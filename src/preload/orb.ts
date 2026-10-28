import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OrbCorner, OrbState } from '../shared/types'

/**
 * The agent orb's page (renderer/orb.html): what it shows comes from the main
 * process, and it sends back its size, drags, and what the user types.
 * Imports nothing but `electron` at run time, so it builds to one file, as a
 * sandboxed preload must.
 */

function on<Args extends unknown[]>(
  channel: string,
  listener: (...args: Args) => void
): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    listener(...(args as Args))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  /** What to show, and the widest the subtitles may be; null when the orb is hidden. */
  onState: (listener: (state: OrbState | null, maxWidth: number) => void) =>
    on('orb:state', listener),
  /** How loud the microphone is, 0 to 1, while the user dictates. */
  onLevel: (listener: (level: number) => void) => on('orb:level', listener),
  /** Dictated text, to put in the input for the user to check and send. */
  onDraft: (listener: (text: string) => void) => on('orb:draft', listener),
  /** The corner the orb was dropped in. */
  onCorner: (listener: (corner: OrbCorner) => void) => on('orb:corner', listener),
  /** What the page measures, so its view is made that size, in its corner. */
  size: (size: { width: number; height: number }, corner: OrbCorner): void =>
    ipcRenderer.send('orb:size', size, corner),
  /** Bring the whole chat back. */
  unfold: (): void => ipcRenderer.send('orb:unfold'),
  /** The orb is being dragged, with the pointer here on screen. */
  drag: (screenX: number, screenY: number): void => ipcRenderer.send('orb:drag', screenX, screenY),
  /** Let go: the orb moves to the nearest corner. */
  drop: (): void => ipcRenderer.send('orb:drop'),
  /** Send a message to the chat, as its composer does: while it works, it steers it. */
  send: (chatId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chat:send', chatId, text, []),
  stop: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:cancel', chatId)
}

export type OrbApi = typeof api

contextBridge.exposeInMainWorld('orb', api)
