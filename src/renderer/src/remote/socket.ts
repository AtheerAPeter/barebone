import type { AppState, Attachment } from '../../../shared/types'
import { uploadFile } from './upload'
import { makeApi, type Api } from '../../../shared/api'
import {
  applyPatch,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage
} from '../../../shared/wire'

/**
 * The window's API in a browser, through the remote link: the same requests
 * and events as in the app, over one WebSocket to the Mac
 * (main/remote/server.ts). The state comes as changes and is put back
 * together here. The socket reconnects on its own; when it comes back, the
 * open chat catches up on what it missed.
 */

export type Connection = 'connecting' | 'online' | 'offline'

/** Reconnecting waits this long, growing to the cap. */
const RETRY_MS = 1000
const RETRY_CAP_MS = 15_000
/** Close code for a session that was signed out (main/remote/server.ts). */
const SIGNED_OUT = 4401

type Listener = (...args: unknown[]) => void

export function remoteApi(): {
  api: Api
  onConnection(listener: (c: Connection) => void): () => void
} {
  let socket: WebSocket | undefined
  let state: AppState | undefined
  let nextCall = 1
  let retry = RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let connection: Connection = 'connecting'
  /** The chat the page shows last asked for: caught up on after a reconnect. */
  let watching: string | undefined
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  /** Sent while the socket was down: they go once it is back. */
  let waiting: ClientMessage[] = []
  const listeners = new Map<string, Set<Listener>>()
  const connectionListeners = new Set<(c: Connection) => void>()
  const stateWaiters: ((state: AppState) => void)[] = []

  const emit = (channel: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(channel) ?? []) listener(...args)
  }
  const setConnection = (next: Connection): void => {
    connection = next
    for (const listener of connectionListeners) listener(next)
  }
  /** Calls sent on the socket that is open now; it closing loses their answers. */
  const inFlight = new Set<number>()
  const post = (message: ClientMessage): void => {
    if (socket?.readyState !== WebSocket.OPEN) return void waiting.push(message)
    socket.send(encode(message))
    if (message.t === 'call') inFlight.add(message.id)
  }

  const receive = (message: ServerMessage): void => {
    if (message.t === 'state') {
      const first = !state
      state = applyPatch(state ?? { projects: [], chats: [] }, message.patch)
      if (first) stateWaiters.splice(0).forEach((resolve) => resolve(state!))
      else emit('state:changed', state)
    } else if (message.t === 'ret') {
      const call = calls.get(message.id)
      calls.delete(message.id)
      inFlight.delete(message.id)
      if (message.error !== undefined) call?.reject(new Error(message.error))
      else call?.resolve(message.value)
    } else if (message.t === 'ev') {
      emit(message.ch, ...message.args)
    }
  }

  const connect = (): void => {
    clearTimeout(retryTimer)
    if (socket) return
    setConnection('connecting')
    const url = new URL('/ws', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(url)
    socket = ws
    let reconnected = false
    let opened = false
    ws.onopen = () => {
      opened = true
      retry = RETRY_MS
      reconnected = state !== undefined
      // A new socket starts the state over: everything comes again.
      const kept = state
      state = undefined
      if (kept) stateWaiters.push((fresh) => emit('state:changed', fresh))
      setConnection('online')
      const queued = waiting
      waiting = []
      for (const message of queued) post(message)
      // The open chat missed what came while the socket was down.
      if (reconnected && watching) {
        const chatId = watching
        void call<{ id: string }[]>('chat:messages', chatId).then((items) => {
          for (const item of items) emit('chat:item', chatId, item)
        })
      }
    }
    ws.onmessage = (event) => {
      if (socket === ws) receive(decode<ServerMessage>(String(event.data)))
    }
    ws.onclose = async (event) => {
      if (socket !== ws) return
      socket = undefined
      for (const id of inFlight) {
        calls.get(id)?.reject(new Error('The connection to your Mac dropped. Try again.'))
        calls.delete(id)
      }
      inFlight.clear()
      if (event.code === SIGNED_OUT) return location.replace('/pair')
      // Refused before it opened: the browser hides why, so ask whether the session is over.
      if (!opened) {
        const session = await fetch('/api/session', { credentials: 'same-origin' }).catch(
          () => undefined
        )
        if (session?.status === 401) return location.replace('/pair')
      }
      setConnection('offline')
      retryTimer = setTimeout(connect, retry)
      retry = Math.min(retry * 2, RETRY_CAP_MS)
    }
  }

  function call<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (channel === 'chat:messages') watching = args[0] as string
    if (channel === 'state:get') {
      return new Promise((resolve) =>
        state ? resolve(state as T) : stateWaiters.push(resolve as (s: AppState) => void)
      )
    }
    const id = nextCall++
    return new Promise<T>((resolve, reject) => {
      calls.set(id, { resolve: resolve as (value: unknown) => void, reject })
      post({ t: 'call', id, ch: channel, args })
    })
  }

  // A page come back to (a phone unlocked) reconnects at once rather than wait out its timer.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !socket) {
      retry = RETRY_MS
      connect()
    }
  })

  connect()

  const api = makeApi({
    invoke: call,
    send: (channel, ...args) => post({ t: 'send', ch: channel, args }),
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set)
      set.add(listener as Listener)
      return () => set.delete(listener as Listener)
    },
    // A browser gives no paths: files are uploaded (see attach below).
    pathForFile: () => '',
    remote: true
  })

  return {
    api: { ...api, pickFiles: () => pickAndUpload() },
    onConnection: (listener) => {
      connectionListeners.add(listener)
      listener(connection)
      return () => connectionListeners.delete(listener)
    }
  }
}

/** The device's own file picker, in place of the Mac's; the chosen files are uploaded. */
function pickAndUpload(): Promise<Attachment[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      Promise.all(Array.from(input.files ?? []).map(uploadFile)).then(resolve, reject)
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}
