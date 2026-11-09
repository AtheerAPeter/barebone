import { ipcMain } from 'electron'

/**
 * The window's requests, registered once for both ways in: Electron's IPC from
 * the app's window, and the remote link's socket from a browser
 * (remote/server.ts). A handler marked MAC_ONLY is left out of the remote
 * link: it opens a native dialog no one there can see, drives the browser
 * panel, or changes the remote link itself.
 */

export const MAC_ONLY = { remote: false } as const

/** Who made a request: the app's window, or one page through the remote link. */
export type Caller = 'window' | `remote:${number}`

type Handler = (caller: Caller, ...args: unknown[]) => unknown

const remoteCalls = new Map<string, Handler>()
const remoteSends = new Map<string, Handler>()
const goneListeners = new Set<(caller: Caller) => void>()

/** A request with an answer (ipcMain.handle). */
export function handle<A extends unknown[]>(
  channel: string,
  handler: (...args: A) => unknown,
  options?: { remote?: boolean }
): void {
  handleAs(channel, (_caller, ...args: A) => handler(...args), options)
}

/** A request whose handler needs to know who asked; see onCallerGone. */
export function handleAs<A extends unknown[]>(
  channel: string,
  handler: (caller: Caller, ...args: A) => unknown,
  { remote = true }: { remote?: boolean } = {}
): void {
  ipcMain.handle(channel, (_event, ...args) => handler('window', ...(args as A)))
  if (remote) remoteCalls.set(channel, handler as Handler)
}

/** A message with no answer (ipcMain.on). */
export function listen<A extends unknown[]>(
  channel: string,
  handler: (...args: A) => void,
  { remote = true }: { remote?: boolean } = {}
): void {
  ipcMain.on(channel, (_event, ...args) => handler(...(args as A)))
  if (remote) remoteSends.set(channel, ((_caller, ...args: A) => handler(...args)) as Handler)
}

/** A request from the remote link only, which the app's window has no use for. */
export function handleRemote<A extends unknown[]>(
  channel: string,
  handler: (caller: Caller, ...args: A) => unknown
): void {
  remoteCalls.set(channel, handler as Handler)
}

/** A message with no answer, from the remote link only, whose handler needs to know who sent it. */
export function listenRemote<A extends unknown[]>(
  channel: string,
  handler: (caller: Caller, ...args: A) => void
): void {
  remoteSends.set(channel, handler as Handler)
}

/** Run a request from the remote link; rejects for a channel it may not use. */
export async function callFromRemote(
  caller: Caller,
  channel: string,
  args: unknown[]
): Promise<unknown> {
  const handler = remoteCalls.get(channel)
  if (!handler) throw new Error('This is only available on the Mac.')
  return handler(caller, ...args)
}

/** Deliver a message from the remote link; one on a channel it may not use is dropped. */
export function sendFromRemote(caller: Caller, channel: string, args: unknown[]): void {
  remoteSends.get(channel)?.(caller, ...args)
}

/** Be told when a page of the remote link goes, to drop what it had asked for. */
export function onCallerGone(listener: (caller: Caller) => void): void {
  goneListeners.add(listener)
}

export function callerGone(caller: Caller): void {
  for (const listener of goneListeners) listener(caller)
}
