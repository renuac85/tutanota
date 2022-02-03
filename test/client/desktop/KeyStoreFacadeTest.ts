import o from "ospec"
import {KeyAccountName, KeyStoreFacadeImpl, SERVICE_NAME} from "../../../src/desktop/KeyStoreFacadeImpl"
import {DesktopCryptoFacade} from "../../../src/desktop/DesktopCryptoFacade"
import type {SecretStorage} from "../../../src/desktop/sse/SecretStorage"
import {spyify} from "../nodemocker"
import {downcast} from "@tutao/tutanota-utils"
import {keyToBase64, uint8ArrayToKey} from "@tutao/tutanota-crypto"

function initKeyStoreFacade(secretStorage: SecretStorage, crypto: DesktopCryptoFacade): KeyStoreFacadeImpl {
	return new KeyStoreFacadeImpl(secretStorage, crypto)
}

o.spec("KeyStoreFacade test", function () {
	const aes256Key = uint8ArrayToKey(new Uint8Array([1, 2]))
	o("getDeviceKey should return stored key", async function () {
		const secretStorageSpy: SecretStorage = spyify({
			async getPassword(service: string, account: string): Promise<string | null> {
				return keyToBase64(aes256Key)
			},

			async setPassword(service: string, account: string, password: string): Promise<void> {
			},
		})
		const cryptoFacadeSpy: DesktopCryptoFacade = spyify(downcast({}))
		const keyStoreFacade = initKeyStoreFacade(secretStorageSpy, cryptoFacadeSpy)
		const actualKey = await keyStoreFacade.getDeviceKey()
		o(actualKey).deepEquals(aes256Key)
		o(secretStorageSpy.getPassword.callCount).equals(1)
		o(secretStorageSpy.getPassword.calls[0].args).deepEquals([SERVICE_NAME, KeyAccountName.DEVICE_KEY])
	})
	o("getDeviceKey should store the key", async function () {
		const secretStorageSpy: SecretStorage = spyify({
			async getPassword(service: string, account: string): Promise<string | null> {
				return null
			},

			async setPassword(service: string, account: string, password: string): Promise<void> {
			},
		})
		const cryptoFacadeSpy: DesktopCryptoFacade = downcast({
			generateDeviceKey() {
				return aes256Key
			},
		})
		const keyStoreFacade = initKeyStoreFacade(secretStorageSpy, cryptoFacadeSpy)
		await keyStoreFacade.getDeviceKey()
		o(secretStorageSpy.setPassword.args).deepEquals([SERVICE_NAME, KeyAccountName.DEVICE_KEY, keyToBase64(aes256Key)])
	})
})