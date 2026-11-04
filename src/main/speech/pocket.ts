import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as Ort from 'onnxruntime-node'
import { SentencePieceProcessor } from '@sctg/sentencepiece-js'
import { POCKET_VOICES, type PocketLanguage } from './pocket-voices'

/**
 * Kyutai's Pocket TTS (CC BY 4.0), the voice of meetings (main/meeting.ts):
 * it makes speech frame by frame, 80 ms each, so a reply starts playing about
 * 0.1 s after its text arrives, where Supertonic renders whole sentences first.
 * A port of the stream() path of KevinAHM/pocket-tts-onnx's pocket_tts_onnx.py,
 * run on lineofflight/pocket-tts-onnx's bundles (Kyutai's current models).
 *
 * The text conditions the model once; then each step the main model makes a
 * frame's conditioning, one flow step turns noise into the frame's latent,
 * and Mimi decodes latents to 24 kHz audio: the first two frames at once,
 * then in chunks sized to stay ahead of playback.
 */

const TEMPERATURE = 0.7
/** An end-of-speech logit above this ends the text, a few frames later. */
const EOS_THRESHOLD = -4
const FIRST_CHUNK_FRAMES = 2
/** Decoded audio kept ahead of playback once it has started. */
const TARGET_BUFFER_SEC = 0.2
const MAX_CHUNK_FRAMES = 15
/** Text tokens per second of speech, for the most frames a text may take. */
const TOKENS_PER_SECOND = 3

interface StateEntry {
  input_name: string
  output_name: string
  module: string
  key: string
  dtype: 'float32' | 'int64' | 'bool'
  shape: number[]
  fill: 'nan' | 'ones' | 'zeros' | 'empty'
}

interface Bundle {
  sample_rate: number
  samples_per_frame: number
  frame_rate: number
  latent_dim: number
  conditioning_dim: number
  max_token_per_chunk: number
  model_recommended_frames_after_eos: number | null
  pad_with_spaces_for_short_inputs: boolean
  remove_semicolons: boolean
  tokenizer_file: string
  flow_lm_state_manifest: StateEntry[]
  mimi_state_manifest: StateEntry[]
}

type State = Record<string, Ort.Tensor>

const size = (shape: number[]): number => shape.reduce((a, b) => a * b, 1)

export class Pocket {
  private constructor(
    private readonly ort: typeof Ort,
    private readonly bundle: Bundle,
    private readonly sessions: {
      text: Ort.InferenceSession
      main: Ort.InferenceSession
      flow: Ort.InferenceSession
      decoder: Ort.InferenceSession
    },
    private readonly tokenizer: SentencePieceProcessor,
    /** The model's state once the voice has conditioned it; every text starts from it. */
    private readonly voice: State
  ) {}

  get sampleRate(): number {
    return this.bundle.sample_rate
  }

  /** Load a language's bundle and voice from `dir` (the folder holding every bundle). */
  static async load(ort: typeof Ort, dir: string, language: PocketLanguage): Promise<Pocket> {
    const { bundle: name, voice } = POCKET_VOICES[language]
    const folder = join(dir, name)
    const bundle = JSON.parse(await readFile(join(folder, 'bundle.json'), 'utf8')) as Bundle
    // One thread: each step is a small matmul waiting on the last, and more
    // threads were slower and used several times the CPU.
    const options = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ['cpu'] }
    const session = (file: string): Promise<Ort.InferenceSession> =>
      ort.InferenceSession.create(join(folder, file), options)
    const [text, main, flow, decoder] = await Promise.all([
      session('text_conditioner.onnx'),
      session('flow_lm_main_int8.onnx'),
      session('flow_lm_flow.onnx'),
      session('mimi_decoder.onnx')
    ])
    const tokenizer = new SentencePieceProcessor()
    await tokenizer.load(join(folder, bundle.tokenizer_file))
    const state = voiceState(ort, bundle, await readFile(join(folder, `${voice}.safetensors`)))
    return new Pocket(ort, bundle, { text, main, flow, decoder }, tokenizer, state)
  }

  /**
   * Speak `text`: its audio in pieces as they are made, until it is said or
   * `stopped()` turns true, which is checked every frame.
   */
  async *stream(text: string, stopped: () => boolean): AsyncGenerator<Float32Array> {
    const { ort, bundle } = this
    const frameSeconds = bundle.samples_per_frame / bundle.sample_rate
    for (const chunk of this.chunks(text)) {
      const decoder = this.initState(bundle.mimi_state_manifest)
      const latents: Float32Array[] = []
      let decoded = 0
      let playing: number | undefined
      const start = performance.now()
      const decode = async (frames: number): Promise<Float32Array> => {
        const latent = new Float32Array(frames * bundle.latent_dim)
        for (let i = 0; i < frames; i++) latent.set(latents[decoded + i], i * bundle.latent_dim)
        const result = await this.sessions.decoder.run({
          latent: new ort.Tensor('float32', latent, [1, frames, bundle.latent_dim]),
          ...decoder
        })
        take(decoder, result, bundle.mimi_state_manifest)
        decoded += frames
        playing ??= (performance.now() - start) / 1000
        return result[this.sessions.decoder.outputNames[0]].data as Float32Array
      }
      for await (const latent of this.latents(chunk)) {
        if (stopped()) return
        latents.push(latent)
        const pending = latents.length - decoded
        let frames = 0
        if (playing === undefined) {
          if (pending >= FIRST_CHUNK_FRAMES) frames = FIRST_CHUNK_FRAMES
        } else {
          const ahead = decoded * frameSeconds - ((performance.now() - start) / 1000 - playing)
          if (ahead < TARGET_BUFFER_SEC) frames = Math.min(pending, 3)
          else if (pending >= MAX_CHUNK_FRAMES) frames = MAX_CHUNK_FRAMES
        }
        if (frames > 0) yield await decode(frames)
      }
      if (stopped()) return
      if (decoded < latents.length) yield await decode(latents.length - decoded)
    }
  }

  /** The latents of one chunk of text, frame by frame. */
  private async *latents(chunk: string): AsyncGenerator<Float32Array> {
    const { ort, bundle, sessions } = this
    const { text, framesAfterEos } = this.prepare(chunk)
    const ids = this.tokenizer.encodeIds(text)
    const tokens = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length])
    const embedded = await sessions.text.run({ token_ids: tokens })
    const state: State = { ...this.voice }
    let result = await sessions.main.run({
      sequence: empty(ort, bundle.latent_dim),
      text_embeddings: embedded[sessions.text.outputNames[0]],
      ...state
    })
    take(state, result, bundle.flow_lm_state_manifest)

    const noText = empty(ort, bundle.conditioning_dim)
    const s = new ort.Tensor('float32', new Float32Array([0]), [1, 1])
    const t = new ort.Tensor('float32', new Float32Array([1]), [1, 1])
    let previous = new ort.Tensor('float32', new Float32Array(bundle.latent_dim).fill(NaN), [
      1,
      1,
      bundle.latent_dim
    ])
    const limit = Math.ceil((ids.length / TOKENS_PER_SECOND + 2) * bundle.frame_rate)
    let endAt: number | undefined
    for (let step = 0; step < limit; step++) {
      result = await sessions.main.run({ sequence: previous, text_embeddings: noText, ...state })
      const conditioning = result[sessions.main.outputNames[0]]
      const eos = (result[sessions.main.outputNames[1]].data as Float32Array)[0]
      take(state, result, bundle.flow_lm_state_manifest)
      if (eos > EOS_THRESHOLD && endAt === undefined) endAt = step + framesAfterEos
      if (endAt !== undefined && step >= endAt) return
      // One flow step, from s = 0 to t = 1, turns noise into the frame.
      const x = gaussian(bundle.latent_dim, Math.sqrt(TEMPERATURE))
      const flow = await sessions.flow.run({
        c: conditioning,
        s,
        t,
        x: new ort.Tensor('float32', x, [1, bundle.latent_dim])
      })
      const velocity = flow[sessions.flow.outputNames[0]].data as Float32Array
      for (let i = 0; i < x.length; i++) x[i] += velocity[i]
      previous = new ort.Tensor('float32', x, [1, 1, bundle.latent_dim])
      yield x
    }
  }

  /** Text as the model was trained on it, and how many frames to let it end in. */
  private prepare(raw: string): { text: string; framesAfterEos: number } {
    let text = raw.trim().replace(/\s+/g, ' ')
    if (this.bundle.remove_semicolons) text = text.replaceAll(';', ',')
    const words = text.split(' ').length
    text = text[0].toUpperCase() + text.slice(1)
    if (/[\p{L}\p{N}]$/u.test(text)) text += '.'
    if (this.bundle.pad_with_spaces_for_short_inputs && words < 5) text = ' '.repeat(8) + text
    return {
      text,
      framesAfterEos: this.bundle.model_recommended_frames_after_eos ?? (words <= 4 ? 3 : 1) + 2
    }
  }

  /** Sentences, joined while they fit in max_token_per_chunk tokens; each is spoken from the voice anew. */
  private chunks(text: string): string[] {
    const sentences = text.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []
    const result: string[] = []
    let current = ''
    let tokens = 0
    for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
      const count = this.tokenizer.encodeIds(sentence).length
      if (current && tokens + count > this.bundle.max_token_per_chunk) {
        result.push(current)
        current = sentence
        tokens = count
      } else {
        current = current ? `${current} ${sentence}` : sentence
        tokens += count
      }
    }
    if (current) result.push(current)
    return result
  }

  private initState(manifest: StateEntry[]): State {
    return Object.fromEntries(manifest.map((entry) => [entry.input_name, filled(this.ort, entry)]))
  }
}

function empty(ort: typeof Ort, dim: number): Ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(0), [1, 0, dim])
}

function filled(ort: typeof Ort, entry: StateEntry): Ort.Tensor {
  const n = size(entry.shape)
  if (entry.dtype === 'float32') {
    const value = entry.fill === 'nan' ? NaN : entry.fill === 'ones' ? 1 : 0
    return new ort.Tensor('float32', new Float32Array(n).fill(value), entry.shape)
  }
  if (entry.dtype === 'int64') {
    return new ort.Tensor(
      'int64',
      new BigInt64Array(n).fill(entry.fill === 'ones' ? 1n : 0n),
      entry.shape
    )
  }
  return new ort.Tensor('bool', new Uint8Array(n).fill(entry.fill === 'ones' ? 1 : 0), entry.shape)
}

/** Carry a model's state outputs over to its inputs for the next run. */
function take(
  state: State,
  result: Ort.InferenceSession.OnnxValueMapType,
  manifest: StateEntry[]
): void {
  for (const entry of manifest) state[entry.input_name] = result[entry.output_name] as Ort.Tensor
}

/** Normal noise, by Box-Muller. */
function gaussian(n: number, std: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - Math.random())) * std
    const angle = 2 * Math.PI * Math.random()
    out[i] = r * Math.cos(angle)
    if (i + 1 < n) out[i + 1] = r * Math.sin(angle)
  }
  return out
}

interface SavedTensor {
  data: Float32Array | BigInt64Array
  shape: number[]
}

/** A safetensors file's tensors (only the float32 and int64 voices use). */
function safetensors(file: Buffer): Record<string, SavedTensor> {
  const headerLength = Number(file.readBigUInt64LE(0))
  const header = JSON.parse(file.subarray(8, 8 + headerLength).toString('utf8')) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >
  const tensors: Record<string, SavedTensor> = {}
  for (const [name, info] of Object.entries(header)) {
    if (name === '__metadata__') continue
    const [start, end] = info.data_offsets
    // Copied out, so the typed array is aligned.
    const bytes = new Uint8Array(file.subarray(8 + headerLength + start, 8 + headerLength + end))
    if (info.dtype === 'F32')
      tensors[name] = { data: new Float32Array(bytes.buffer), shape: info.shape }
    else if (info.dtype === 'I64')
      tensors[name] = { data: new BigInt64Array(bytes.buffer), shape: info.shape }
    else throw new Error(`The voice has a tensor of an unexpected type: ${name} is ${info.dtype}.`)
  }
  return tensors
}

/**
 * The model's state with a voice in it: Kyutai's voices are the attention
 * caches of the model after hearing the voice, shorter than the state's
 * caches, so each is copied into the start of a cache of the state's size.
 * A layer's step is the voice's offset (_state_from_model_state).
 */
function voiceState(ort: typeof Ort, bundle: Bundle, file: Buffer): State {
  const tensors = safetensors(file)
  const state: State = {}
  for (const entry of bundle.flow_lm_state_manifest) {
    let source = tensors[`${entry.module}/${entry.key}`]
    if (!source && entry.key === 'step') {
      const offset = tensors[`${entry.module}/offset`]
      if (offset && !tensors[`${entry.module}/end_offset`])
        source = { data: offset.data, shape: [1] }
    }
    state[entry.input_name] = source ? adapt(ort, source, entry) : filled(ort, entry)
  }
  return state
}

/** `source` in a tensor of the entry's shape: reshaped when the sizes match, else copied into its start. */
function adapt(ort: typeof Ort, source: SavedTensor, entry: StateEntry): Ort.Tensor {
  if (size(source.shape) === size(entry.shape)) {
    const data = source.data.slice()
    return data instanceof BigInt64Array
      ? new ort.Tensor('int64', data, entry.shape)
      : new ort.Tensor('float32', data, entry.shape)
  }
  const target = filled(ort, entry)
  if (source.shape.length !== entry.shape.length) return target
  const extent = source.shape.map((s, i) => Math.min(s, entry.shape[i]))
  if (extent.some((e) => e === 0)) return target
  const strides = (shape: number[]): number[] => shape.map((_, i) => size(shape.slice(i + 1)))
  const [from, to] = [strides(source.shape), strides(entry.shape)]
  const data = target.data as Float32Array | BigInt64Array
  const index = new Array<number>(extent.length).fill(0)
  for (let k = 0, count = size(extent); k < count; k++) {
    let s = 0
    let t = 0
    for (let d = 0; d < extent.length; d++) {
      s += index[d] * from[d]
      t += index[d] * to[d]
    }
    data[t] = source.data[s]
    for (let d = extent.length - 1; d >= 0 && ++index[d] === extent[d]; d--) index[d] = 0
  }
  return target
}
