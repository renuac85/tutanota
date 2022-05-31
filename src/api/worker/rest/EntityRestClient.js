//@flow
import type {RestClient} from "./RestClient"
import type {CryptoFacade} from "../crypto/CryptoFacade"
import {_verifyType, HttpMethod, MediaType, resolveTypeReference} from "../../common/EntityFunctions"
import {SessionKeyNotFoundError} from "../../common/error/SessionKeyNotFoundError"
import {PushIdentifierTypeRef} from "../../entities/sys/PushIdentifier"
import {NotAuthenticatedError, PayloadTooLargeError} from "../../common/error/RestError"
import type {EntityUpdate} from "../../entities/sys/EntityUpdate"
import type {lazy} from "@tutao/tutanota-utils"
import {flat, isSameTypeRef, ofClass, promiseMap, splitInChunks, TypeRef} from "@tutao/tutanota-utils";
import {assertWorkerOrNode} from "../../common/Env"
import type {ListElementEntity, SomeEntity, TypeModel} from "../../common/EntityTypes"
import {LOAD_MULTIPLE_LIMIT, POST_MULTIPLE_LIMIT} from "../../common/utils/EntityUtils"
import {Type} from "../../common/EntityConstants"
import {SetupMultipleError} from "../../common/error/SetupMultipleError"
import {expandId} from "./EntityRestCache"
import {InstanceMapper} from "../crypto/InstanceMapper"

assertWorkerOrNode()

export function typeRefToPath(typeRef: TypeRef<any>): string {
	return `/rest/${typeRef.app}/${typeRef.type.toLowerCase()}`
}

export type AuthHeadersProvider = () => Params

/**
 * The EntityRestInterface provides a convenient interface for invoking server side REST services.
 */
export interface EntityRestInterface {

	/**
	 * Reads a single element from the server (or cache). Entities are decrypted before they are returned.
	 */
	load<T: SomeEntity>(typeRef: TypeRef<T>, id: $PropertyType<T, "_id">, queryParameters: ?Params, extraHeaders?: Params): Promise<T>;

	/**
	 * Reads a range of elements from the server (or cache). Entities are decrypted before they are returned.
	 */
	loadRange<T: ListElementEntity>(typeRef: TypeRef<T>, listId: Id, start: Id, count: number, reverse: boolean): Promise<T[]>;

	/**
	 * Reads multiple elements from the server (or cache). Entities are decrypted before they are returned.
	 */
	loadMultiple<T: SomeEntity>(typeRef: TypeRef<T>, listId: ?Id, elementIds: Array<Id>): Promise<Array<T>>;

	/**
	 * Creates a single element on the server. Entities are encrypted before they are sent.
	 */
	setup<T: SomeEntity>(listId: ?Id, instance: T, extraHeaders?: Params): Promise<Id>;

	/**
	 * Creates multiple elements on the server. Entities are encrypted before they are sent.
	 */
	setupMultiple<T: SomeEntity>(listId: ?Id, instances: Array<T>): Promise<Array<Id>>;

	/**
	 * Modifies a single element on the server. Entities are encrypted before they are sent.
	 */
	update<T: SomeEntity>(instance: T): Promise<void>;


	/**
	 * Deletes a single element on the server.
	 */
	erase<T: SomeEntity>(instance: T): Promise<void>;

	/**
	 * Must be called when entity events are received.
	 * @param batch The entity events that were received.
	 * @return Similar to the events in the data parementer, but reduced by the events which are obsolete.
	 */
	entityEventsReceived(batch: Array<EntityUpdate>): Promise<Array<EntityUpdate>>;
}

/**
 * Retrieves the instances from the backend (db) and converts them to entities.
 *
 * Part of this process is
 * * the decryption for the returned instances (GET) and the encryption of all instances before they are sent (POST, PUT)
 * * the injection of aggregate instances for the returned instances (GET)
 * * caching for retrieved instances (GET)
 *
 */
export class EntityRestClient implements EntityRestInterface {
	_authHeadersProvider: AuthHeadersProvider;
	_restClient: RestClient;
	_instanceMapper: InstanceMapper

	// Crypto Facade is lazy due to circular dependency between EntityRestClient and CryptoFacade
	_lazyCrypto: lazy<CryptoFacade>

	get _crypto(): CryptoFacade {
		return this._lazyCrypto()
	}

	constructor(authHeadersProvider: AuthHeadersProvider, restClient: RestClient, crypto: lazy<CryptoFacade>, instanceMapper: InstanceMapper) {
		this._authHeadersProvider = authHeadersProvider
		this._restClient = restClient
		this._lazyCrypto = crypto
		this._instanceMapper = instanceMapper
	}

	async load<T: SomeEntity>(typeRef: TypeRef<T>, id: $PropertyType<T, "_id">, queryParameters: ?Params, extraHeaders?: Params): Promise<T> {
		const {listId, elementId} = expandId(id)
		const {
			path,
			queryParams,
			headers,
			typeModel
		} = await this._validateAndPrepareRestRequest(typeRef, listId, elementId, queryParameters, extraHeaders)
		const json = await this._restClient.request(path, HttpMethod.GET, queryParams, headers, null, MediaType.Json)
		const entity = JSON.parse(json)
		const migratedEntity = await this._crypto.applyMigrations(typeRef, entity)
		const sessionKey = await this._crypto.resolveSessionKey(typeModel, migratedEntity)
		                             .catch(ofClass(SessionKeyNotFoundError, e => {
			                             console.log("could not resolve session key", e)
			                             return null // will result in _errors being set on the instance
		                             }))
		const instance = await this._instanceMapper.decryptAndMapToInstance(typeModel, migratedEntity, sessionKey)
		return this._crypto.applyMigrationsForInstance(instance)
	}

	async loadRange<T: ListElementEntity>(typeRef: TypeRef<T>, listId: Id, start: Id, count: number, reverse: boolean): Promise<T[]> {

		const rangeRequestParams = {
			start: String(start),
			count: String(count),
			reverse: String(reverse)
		}

		const {
			path,
			headers,
			typeModel,
			queryParams
		} = await this._validateAndPrepareRestRequest(typeRef, listId, null, rangeRequestParams, null)

		// This should never happen if type checking is not bypassed with any
		if (typeModel.type !== Type.ListElement) throw new Error("only ListElement types are permitted")

		const json = await this._restClient.request(path, HttpMethod.GET, queryParams, headers, null, MediaType.Json)
		return this._handleLoadMultipleResult(typeRef, JSON.parse(json))
	}

	async loadMultiple<T: SomeEntity>(typeRef: TypeRef<T>, listId: ?Id, elementIds: Array<Id>): Promise<Array<T>> {

		const {
			path,
			headers,
		} = await this._validateAndPrepareRestRequest(typeRef, listId, null, null, null)

		const idChunks = splitInChunks(LOAD_MULTIPLE_LIMIT, elementIds)
		const loadedChunks = await promiseMap(idChunks, async idChunk => {
				const queryParams = {
					ids: idChunk.join(",")
				}
				const json = await this._restClient.request(path, HttpMethod.GET, queryParams, headers, null, MediaType.Json)
				return this._handleLoadMultipleResult(typeRef, JSON.parse(json))
			}
		)

		return flat(loadedChunks)
	}

	async _handleLoadMultipleResult<T: SomeEntity>(typeRef: TypeRef<T>, loadedEntities: Array<any>): Promise<Array<T>> {
		const model = await resolveTypeReference(typeRef)

		// PushIdentifier was changed in the system model v43 to encrypt the name.
		// We check here to check the type only once per array and not for each element.
		if (isSameTypeRef(typeRef, PushIdentifierTypeRef)) {
			await promiseMap(loadedEntities, instance => this._crypto.applyMigrations(typeRef, instance), {concurrency: 5})
		}

		return promiseMap(loadedEntities, instance =>
				this._crypto.resolveSessionKey(model, instance)
				    .catch(ofClass(SessionKeyNotFoundError, e => {
					    console.log("could not resolve session key", e)
					    return null // will result in _errors being set on the instance
				    }))
				    .then(sk => this._instanceMapper.decryptAndMapToInstance(model, instance, sk))
				    .then(decryptedInstance => this._crypto.applyMigrationsForInstance(decryptedInstance)),
			{concurrency: 5})
	}

	async setup<T: SomeEntity>(listId: ?Id, instance: T, extraHeaders?: Params): Promise<Id> {
		const typeRef = instance._type
		const {typeModel, path, headers, queryParams} = await this._validateAndPrepareRestRequest(typeRef, listId, null, null, extraHeaders)

		if (typeModel.type === Type.ListElement) {
			if (!listId) throw new Error("List id must be defined for LETs")
		} else {
			if (listId) throw new Error("List id must not be defined for ETs")
		}

		const sk = this._crypto.setNewOwnerEncSessionKey(typeModel, instance)
		const encryptedEntity = await this._instanceMapper.encryptAndMapToLiteral(typeModel, instance, sk)

		const persistencePostReturn = await this._restClient.request(path, HttpMethod.POST, queryParams, headers, JSON.stringify(encryptedEntity), MediaType.Json)
		return JSON.parse(persistencePostReturn).generatedId
	}

	async setupMultiple<T: SomeEntity>(listId: ?Id, instances: Array<T>): Promise<Array<Id>> {
		const count = instances.length
		if (count < 1) {
			return []
		}

		const instanceChunks = splitInChunks(POST_MULTIPLE_LIMIT, instances)
		const typeRef = instances[0]._type
		const {typeModel, path, headers} = await this._validateAndPrepareRestRequest(typeRef, listId, null, null, null)

		if (typeModel.type === Type.ListElement) {
			if (!listId) throw new Error("List id must be defined for LETs")
		} else {
			if (listId) throw new Error("List id must not be defined for ETs")
		}

		const errors = []
		const failedInstances = []
		const idChunks: Array<Array<Id>> = await promiseMap(instanceChunks, async instanceChunk => {
			try {
				const encryptedEntities = await promiseMap(instanceChunk, e => {
					const sk = this._crypto.setNewOwnerEncSessionKey(typeModel, e)
					return this._instanceMapper.encryptAndMapToLiteral(typeModel, e, sk)
				})

				// informs the server that this is a POST_MULTIPLE request
				const queryParams = {count: String(instanceChunk.length)}
				const persistencePostReturn = await this._restClient.request(path, HttpMethod.POST, queryParams, headers, JSON.stringify(encryptedEntities), MediaType.Json)
				const postReturn = JSON.parse(persistencePostReturn)
				return postReturn.map(e => e.generatedId)
			} catch (e) {
				if (e instanceof PayloadTooLargeError) {
					// If we try to post too many large instances then we get PayloadTooLarge
					// So we fall back to posting single instances
					const returnedIds = await promiseMap(instanceChunk, instance => {
						return this.setup(listId, instance)
						           .catch(e => {
							           errors.push(e)
							           failedInstances.push(instance)
						           })
					})
					return returnedIds.filter(Boolean)
				} else {
					errors.push(e)
					failedInstances.push(...instanceChunk)
					return []
				}
			}
		})

		if (errors.length) {
			throw new SetupMultipleError<T>("Setup multiple entities failed", errors, failedInstances)
		} else {
			return flat(idChunks)
		}
	}

	async update<T: SomeEntity>(instance: T): Promise<void> {
		if (!instance._id) throw new Error("Id must be defined")
		const {listId, elementId} = expandId(instance._id)
		const {
			path,
			queryParams,
			headers,
			typeModel
		} = await this._validateAndPrepareRestRequest(instance._type, listId, elementId, null, null)
		const sessionKey = await this._crypto.resolveSessionKey(typeModel, instance)
		const encryptedEntity = await this._instanceMapper.encryptAndMapToLiteral(typeModel, instance, sessionKey)
		await this._restClient.request(path, HttpMethod.PUT, queryParams, headers, JSON.stringify(encryptedEntity), MediaType.Json)
	}

	async erase<T: SomeEntity>(instance: T): Promise<void> {
		const {listId, elementId} = expandId(instance._id)
		const {path, queryParams, headers} = await this._validateAndPrepareRestRequest(instance._type, listId, elementId, null, null)
		await this._restClient.request(path, HttpMethod.DELETE, queryParams, headers)
	}

	async _validateAndPrepareRestRequest(typeRef: TypeRef<*>, listId: ?Id, elementId: ?Id, queryParameters: ?Params, extraHeaders: ?Params): Promise<{
		path: string,
		queryParams: Params,
		headers: Params,
		typeModel: TypeModel
	}> {
		const typeModel = await resolveTypeReference(typeRef)
		_verifyType(typeModel)
		let path = typeRefToPath(typeRef)
		if (listId) {
			path += '/' + listId
		}
		if (elementId) {
			path += '/' + elementId
		}
		const queryParams = queryParameters ?? {}
		const headers = Object.assign({}, this._authHeadersProvider(), extraHeaders)
		if (Object.keys(headers).length === 0) {
			throw new NotAuthenticatedError("user must be authenticated for entity requests")
		}
		headers.v = typeModel.version

		return {
			path,
			queryParams,
			headers,
			typeModel
		}
	}

	/**
	 * for the admin area (no cache available)
	 */
	entityEventsReceived(batch: Array<EntityUpdate>): Promise<Array<EntityUpdate>> {
		return Promise.resolve(batch)
	}

	getRestClient(): RestClient {
		return this._restClient
	}
}


export function getIds(instance: any, typeModel: TypeModel): {listId: ?string, id: string} {
	if (!instance._id) throw new Error("Id must be defined")
	let listId = null
	let id
	if (typeModel.type === Type.ListElement) {
		listId = instance._id[0]
		id = instance._id[1]
	} else {
		id = instance._id
	}
	return {listId, id};
}