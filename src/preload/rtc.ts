import { contextBridge, ipcRenderer } from 'electron'
import type { RtcCommand, RtcEvent } from '../shared/rtc'

/**
 * The video streamer's page (renderer/rtc.html): what to stream comes from
 * the main process, and the page sends back its offers and candidates.
 * Imports nothing but `electron` at run time, so it builds to one file, as a
 * sandboxed preload must.
 */
contextBridge.exposeInMainWorld('rtcHost', {
  onCommand: (listener: (command: RtcCommand) => void): void => {
    ipcRenderer.on('rtc:command', (_event, command: RtcCommand) => listener(command))
  },
  send: (event: RtcEvent): void => ipcRenderer.send('rtc:event', event)
})
