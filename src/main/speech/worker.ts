import type * as Ort from 'onnxruntime-node'
import { Pocket } from './pocket'
import { isPocketLanguage, type PocketLanguage } from './pocket-voices'
import { chunks, Supertonic, type Language } from './supertonic'

/**
 * The speech engines' own process (Electron's utilityProcess), so synthesis
 * never holds up the app. Each engine loads when first used, then speaks:
 * Supertonic sends each chunk of a message as soon as it is made, so playback
 * starts after the first sentence; Pocket (a chat in a meeting) sends audio
 * every few 80 ms frames, so it starts after the first two. See
 * speech/index.ts for the other side.
 */

export type ToWorker =
  | { type: 'load'; dir: string; voice: string; pocketDir: string }
  | {
      type: 'speak'
      id: string
      text: string
      lang: Language
      pace: number
      engine: 'supertonic' | 'pocket'
    }
  | { type: 'cancel'; id: string }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'audio'; id: string; samples: Float32Array; sampleRate: number; last: boolean }
  | { type: 'failed'; id: string; message: string }

const port = process.parentPort
const post = (message: FromWorker): void => port.postMessage(message)

let config: Extract<ToWorker, { type: 'load' }> | undefined
let runtime: Promise<typeof Ort> | undefined
let supertonic: Promise<Supertonic> | undefined
/** Pocket for one language at a time: a meeting is in one. */
let pocket: { language: PocketLanguage; engine: Promise<Pocket> } | undefined
/** Messages to speak, in order; one at a time. */
const queue: Extract<ToWorker, { type: 'speak' }>[] = []
const cancelled = new Set<string>()
let speaking = false

const ort = (): Promise<typeof Ort> => (runtime ??= import('onnxruntime-node'))

port.on('message', ({ data }: { data: ToWorker }) => {
  if (data.type === 'load') {
    config = data
    post({ type: 'ready' })
  } else if (data.type === 'speak') {
    queue.push(data)
    void next()
  } else {
    cancelled.add(data.id)
  }
})

function loadSupertonic(): Promise<Supertonic> {
  if (!supertonic) {
    const { dir, voice } = config!
    supertonic = ort().then((runtime) => Supertonic.load(runtime, dir, voice))
    // The engine not loading is the voice not working: speech/index.ts stops this process.
    supertonic.catch((error: Error) => post({ type: 'error', message: error.message }))
  }
  return supertonic
}

function loadPocket(language: PocketLanguage): Promise<Pocket> {
  if (pocket?.language !== language) {
    const { pocketDir } = config!
    pocket = {
      language,
      engine: ort().then((runtime) => Pocket.load(runtime, pocketDir, language))
    }
    // A failed load is tried again by the next message.
    const failed = pocket
    failed.engine.catch(() => {
      if (pocket === failed) pocket = undefined
    })
  }
  return pocket.engine
}

async function next(): Promise<void> {
  if (speaking || !config) return
  const request = queue.shift()
  if (!request) return
  speaking = true
  const stopped = (): boolean => cancelled.has(request.id)
  try {
    if (request.engine === 'pocket' && isPocketLanguage(request.lang)) {
      const tts = await loadPocket(request.lang)
      for await (const samples of tts.stream(request.text, stopped)) {
        post({ type: 'audio', id: request.id, samples, sampleRate: tts.sampleRate, last: false })
      }
      // The message's end, so the player knows it has heard all of it.
      if (!stopped()) {
        const end = new Float32Array(0)
        post({
          type: 'audio',
          id: request.id,
          samples: end,
          sampleRate: tts.sampleRate,
          last: true
        })
      }
    } else {
      const tts = await loadSupertonic()
      const parts = chunks(request.text, request.lang)
      for (const [index, part] of parts.entries()) {
        if (stopped()) break
        const samples = await tts.speak(part, request.lang, request.pace)
        if (stopped()) break
        post({
          type: 'audio',
          id: request.id,
          samples,
          sampleRate: tts.sampleRate,
          last: index === parts.length - 1
        })
      }
    }
  } catch (error) {
    post({ type: 'failed', id: request.id, message: (error as Error).message })
  } finally {
    cancelled.delete(request.id)
    speaking = false
    void next()
  }
}
