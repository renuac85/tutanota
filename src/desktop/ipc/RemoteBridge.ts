import * as electron from "electron"
import {DesktopFacade} from "../../native/common/generatedipc/DesktopFacade.js"
import {CommonNativeFacade} from "../../native/common/generatedipc/CommonNativeFacade.js"
import {ApplicationWindow} from "../ApplicationWindow.js"
import {exposeRemote} from "../../api/common/WorkerProxy.js"
import {ExposedNativeInterface} from "../../native/common/NativeInterface.js"
import {ElectronWebContentsTransport} from "./ElectronWebContentsTransport.js"
import {DesktopGlobalDispatcher} from "../../native/common/generatedipc/DesktopGlobalDispatcher.js"
import {MessageDispatcher, Request} from "../../api/common/MessageDispatcher.js"
import {DesktopFacadeSendDispatcher} from "../../native/common/generatedipc/DesktopFacadeSendDispatcher.js"
import {CommonNativeFacadeSendDispatcher} from "../../native/common/generatedipc/CommonNativeFacadeSendDispatcher.js"
import {CentralIpcHandler, IpcConfig} from "./CentralIpcHandler.js"
import {InterWindowEventSender} from "../../native/common/InterWindowEventBus.js"
import {InterWindowEventTypes} from "../../native/common/InterWindowEventTypes.js"
import {DesktopCommonSystemFacade} from "../DesktopCommonSystemFacade.js"

export interface SendingFacades {
	desktopFacade: DesktopFacade
	commonNativeFacade: CommonNativeFacade
	interWindowEventSender: InterWindowEventSender<InterWindowEventTypes>
}


const primaryIpcConfig: IpcConfig<"to-main", "to-renderer"> = {
	renderToMainEvent: "to-main",
	mainToRenderEvent: "to-renderer",
} as const
// Must be created only once
const primaryIpcHandler = new CentralIpcHandler(electron.ipcMain, primaryIpcConfig)

export type DispatcherFactory = (window: ApplicationWindow) => {desktopCommonSystemFacade: DesktopCommonSystemFacade; dispatcher: DesktopGlobalDispatcher}
export type FacadeHandler = (message: Request<"facade">) => Promise<any>
export type FacadeHandlerFactory = (window: ApplicationWindow) => FacadeHandler

export class RemoteBridge {

	constructor(
		private readonly dispatcherFactory: DispatcherFactory,
		private readonly facadeHandlerFactory: FacadeHandlerFactory,
	) {
	}

	createBridge(window: ApplicationWindow): SendingFacades {
		const webContents = window._browserWindow.webContents
		const {desktopCommonSystemFacade, dispatcher} = this.dispatcherFactory(window)
		const facadeHandler = this.facadeHandlerFactory(window)

		const transport = new ElectronWebContentsTransport<typeof primaryIpcConfig, JsRequestType, NativeRequestType>(webContents, primaryIpcHandler)
		const messageDispatcher = new MessageDispatcher<JsRequestType, NativeRequestType>(transport, {
			"facade": facadeHandler,
			"ipc": async ({args}) => {
				const [facade, method, ...methodArgs] = args
				return await dispatcher.dispatch(facade, method, methodArgs)
			}
		})
		const nativeInterface = {
			invokeNative: async (requestType: string, args: ReadonlyArray<unknown>): Promise<any> => {
				await desktopCommonSystemFacade.awaitForInit()
				return messageDispatcher.postRequest(new Request(requestType as JsRequestType, args))
			}
		}
		const exposedNativeInterface = exposeRemote<ExposedNativeInterface>((message) => messageDispatcher.postRequest(message))
		return {
			desktopFacade: new DesktopFacadeSendDispatcher(nativeInterface),
			commonNativeFacade: new CommonNativeFacadeSendDispatcher(nativeInterface),
			interWindowEventSender: exposedNativeInterface.interWindowEventSender
		}
	}

	destroyBridge(window: ApplicationWindow) {
		primaryIpcHandler.removeHandler(window._browserWindow.webContents.id)
	}
}