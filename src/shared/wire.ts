/**
 * Messages on the remote link's socket, as JSON (main/remote/server.ts and
 * renderer/src/remote/socket.ts). JSON has no bytes, so the binary data the
 * API carries is written as base64: recordings sent for transcribing
 * (Uint8Array) and the agent's voice (Float32Array). The voice goes as 16-bit
 * samples, half the size, which is all a phone's speaker plays.
 */

import type { AppState, Chat, Project } from './types'

/** What the page sends. */
export type ClientMessage =
  | { t: 'call'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; args: unknown[] }

/** The changes since the last state the page was sent. */
export interface StatePatch {
  /** Top-level settings that changed (theme, instructions and so on), with their new values. */
  set?: Partial<Omit<AppState, 'chats' | 'projects'>>
  /** Settings that are gone. */
  unset?: string[]
  projects?: Project[]
  /** Chats that are new or changed. */
  chats?: Chat[]
  /** Chats that are gone. */
  removed?: string[]
  /** The order of every chat's id, when it changed. */
  order?: string[]
}

/** What the server sends. */
export type ServerMessage =
  | { t: 'hello'; state: AppState }
  | { t: 'state'; patch: StatePatch }
  | { t: 'ret'; id: number; value?: unknown; error?: string }
  | { t: 'ev'; ch: string; args: unknown[] }

const CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message, (_key, value: unknown) => {
    if (value instanceof Uint8Array) return { $u8: toBase64(value) }
    if (value instanceof Float32Array) {
      const samples = new Int16Array(value.length)
      for (let i = 0; i < value.length; i++) {
        samples[i] = Math.max(-1, Math.min(1, value[i])) * 0x7fff
      }
      return { $pcm16: toBase64(new Uint8Array(samples.buffer)) }
    }
    return value
  })
}

export function decode<T extends ClientMessage | ServerMessage>(text: string): T {
  return JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === 'object') {
      if ('$u8' in value && typeof value.$u8 === 'string') return fromBase64(value.$u8)
      if ('$pcm16' in value && typeof value.$pcm16 === 'string') {
        const bytes = fromBase64(value.$pcm16)
        const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
        const out = new Float32Array(samples.length)
        for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 0x7fff
        return out
      }
    }
    return value
  }) as T
}

/**
 * What a page was last sent, as JSON, to tell what changed since. Snapshots,
 * not the state itself: the app changes its state object in place.
 */
export interface SentState {
  settings: Map<string, string>
  projects: string
  chats: Map<string, string>
  order: string
}

export function sentState(): SentState {
  return { settings: new Map(), projects: '', chats: new Map(), order: '' }
}

/**
 * The changes since what a page was last sent, noted as sent; undefined when
 * nothing changed. The first call, with nothing sent yet, gives everything.
 */
export function diffState(state: AppState, sent: SentState): StatePatch | undefined {
  const patch: StatePatch = {}
  const { chats, projects, ...settings } = state
  for (const [key, value] of Object.entries(settings)) {
    const json = JSON.stringify(value)
    if (json === undefined) continue
    if (sent.settings.get(key) !== json) {
      patch.set = { ...patch.set, [key]: value }
      sent.settings.set(key, json)
    }
  }
  for (const key of [...sent.settings.keys()]) {
    if (JSON.stringify((settings as Record<string, unknown>)[key]) === undefined) {
      patch.unset = [...(patch.unset ?? []), key]
      sent.settings.delete(key)
    }
  }
  const projectsJson = JSON.stringify(projects)
  if (projectsJson !== sent.projects) {
    patch.projects = projects
    sent.projects = projectsJson
  }
  const now = new Set<string>()
  for (const chat of chats) {
    now.add(chat.id)
    const json = JSON.stringify(chat)
    if (sent.chats.get(chat.id) !== json) {
      patch.chats = [...(patch.chats ?? []), chat]
      sent.chats.set(chat.id, json)
    }
  }
  for (const id of [...sent.chats.keys()]) {
    if (!now.has(id)) {
      patch.removed = [...(patch.removed ?? []), id]
      sent.chats.delete(id)
    }
  }
  const order = chats.map((c) => c.id)
  if (order.join() !== sent.order) {
    patch.order = order
    sent.order = order.join()
  }
  return Object.keys(patch).length ? patch : undefined
}

/** A state with a patch applied. */
export function applyPatch(state: AppState, patch: StatePatch): AppState {
  const next: AppState = { ...state, ...patch.set }
  for (const key of patch.unset ?? []) delete (next as unknown as Record<string, unknown>)[key]
  if (patch.projects) next.projects = patch.projects
  const byId = new Map(state.chats.map((c) => [c.id, c]))
  for (const chat of patch.chats ?? []) byId.set(chat.id, chat)
  for (const id of patch.removed ?? []) byId.delete(id)
  const order = patch.order ?? [
    ...state.chats.map((c) => c.id).filter((id) => byId.has(id)),
    ...(patch.chats ?? []).map((c) => c.id).filter((id) => !state.chats.some((c) => c.id === id))
  ]
  next.chats = order.flatMap((id) => byId.get(id) ?? [])
  return next
}

/**
 * A picture of a browser tab (main/remote/browser.ts), sent as a binary
 * message: the length of its header, the header as JSON, then the JPEG.
 * Binary, as base64 in JSON would make every picture a third bigger.
 */
export interface FrameHeader {
  chatId: string
  /** The tab's id, like t2. */
  tab: string
  /** The page's viewport in CSS pixels, which the picture shows all of. */
  width: number
  height: number
}

export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header))
  const message = new Uint8Array(4 + head.length + jpeg.length)
  new DataView(message.buffer).setUint32(0, head.length)
  message.set(head, 4)
  message.set(jpeg, 4 + head.length)
  return message
}

export function decodeFrame(data: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } {
  const length = new DataView(data).getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)))
  return { header: header as FrameHeader, jpeg: new Uint8Array(data, 4 + length) }
}
