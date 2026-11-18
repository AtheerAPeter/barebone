import { ipcRenderer } from 'electron'

/**
 * The video encoder's page (renderer/encoder.html): it gets the port the main
 * process talks to it on, and hands it to the page, which cannot reach
 * Electron itself. Imports nothing but `electron`, so it builds to one file,
 * as a sandboxed preload must.
 */
ipcRenderer.on('encoder:port', (event) => window.postMessage('encoder:port', '*', event.ports))
