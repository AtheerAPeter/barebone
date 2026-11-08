import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { makeApi } from '../shared/api'

/** The window's API (shared/api.ts), over Electron's IPC. */
const api = makeApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => {
    const handler = (_event: IpcRendererEvent, ...args: unknown[]): void =>
      (listener as (...args: unknown[]) => void)(...args)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.off(channel, handler)
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  remote: false
})

export type { Api } from '../shared/api'

contextBridge.exposeInMainWorld('api', api)
