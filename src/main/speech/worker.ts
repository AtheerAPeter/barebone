import type * as Ort from 'onnxruntime-node'
import { sound, type Sound } from './sounds'
import { chunks, Supertonic, type Language } from './supertonic'

/**
 * The speech engine's own process (Electron's utilityProcess), so synthesis
 * never holds up the app. It loads the model once, then speaks: each chunk of
 * a message is sent back as soon as it is made, so playback starts after the
 * first sentence. See speech/index.ts for the other side.
 */

export type ToWorker =
  | { type: 'load'; dir: string; voice: string }
  | { type: 'speak'; id: string; text: string; lang: Language; pace: number; sound?: Sound }
  | { type: 'cancel'; id: string }

export type FromWorker =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'audio'; id: string; samples: Float32Array; sampleRate: number; last: boolean }
  | { type: 'failed'; id: string; message: string }

const port = process.parentPort
const post = (message: FromWorker): void => port.postMessage(message)

let engine: Promise<Supertonic> | undefined
/** Messages to speak, in order; one at a time. */
const queue: Extract<ToWorker, { type: 'speak' }>[] = []
const cancelled = new Set<string>()
let speaking = false

port.on('message', ({ data }: { data: ToWorker }) => {
  if (data.type === 'load') {
    engine = import('onnxruntime-node').then((ort: typeof Ort) =>
      Supertonic.load(ort, data.dir, data.voice)
    )
    engine.then(
      () => post({ type: 'ready' }),
      (error: Error) => post({ type: 'error', message: error.message })
    )
  } else if (data.type === 'speak') {
    queue.push(data)
    void next()
  } else {
    cancelled.add(data.id)
  }
})

async function next(): Promise<void> {
  if (speaking || !engine) return
  const request = queue.shift()
  if (!request) return
  speaking = true
  try {
    const tts = await engine
    // The sound goes first, as a piece of the message, so it plays just before the words.
    if (request.sound && !cancelled.has(request.id)) {
      const samples = sound(request.sound, tts.sampleRate)
      post({ type: 'audio', id: request.id, samples, sampleRate: tts.sampleRate, last: false })
    }
    const parts = chunks(request.text, request.lang)
    for (const [index, part] of parts.entries()) {
      if (cancelled.has(request.id)) break
      const samples = await tts.speak(part, request.lang, request.pace)
      if (cancelled.has(request.id)) break
      post({
        type: 'audio',
        id: request.id,
        samples,
        sampleRate: tts.sampleRate,
        last: index === parts.length - 1
      })
    }
  } catch (error) {
    post({ type: 'failed', id: request.id, message: (error as Error).message })
  } finally {
    cancelled.delete(request.id)
    speaking = false
    void next()
  }
}
