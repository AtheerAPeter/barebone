import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as Ort from 'onnxruntime-node'

/**
 * Supertonic 3 (Supertone, OpenRAIL-M): text to speech in 31 languages, run
 * locally with ONNX Runtime. A port of the supertonic Python package 1.3.1
 * (core.py, pipeline.py, utils.py), which the voice was chosen with: the text
 * is normalised and wrapped in a language tag, a duration is predicted, and a
 * latent is denoised in steps from noise, then turned into a waveform.
 *
 * One difference: characters the model has no index for are left out instead
 * of failing, so a stray symbol in an agent's message cannot keep it silent.
 */

/** The model's languages, as Supertonic's codes; `na` is for any other. */
export const LANGUAGES = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu',
  'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'
] as const // prettier-ignore
export type Language = (typeof LANGUAGES)[number]

/** Denoising steps: the package's default, which the voice was chosen at. */
const TOTAL_STEPS = 8
const SPEED = 1.05
/** Longer text is spoken in chunks of whole sentences up to this length (Korean: 120). */
const MAX_CHUNK = 300
const MAX_CHUNK_KO = 120

const EMOJI =
  /[\u{1f600}-\u{1f64f}\u{1f300}-\u{1f5ff}\u{1f680}-\u{1f6ff}\u{1f700}-\u{1f77f}\u{1f780}-\u{1f7ff}\u{1f800}-\u{1f8ff}\u{1f900}-\u{1f9ff}\u{1fa00}-\u{1fa6f}\u{1fa70}-\u{1faff}☀-⛿✀-➿\u{1f1e6}-\u{1f1ff}]+/gu
const SYMBOLS: [string, string][] = [
  ['–', '-'],
  ['‑', '-'],
  ['—', '-'],
  ['¯', ' '],
  ['_', ' '],
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"],
  ['´', "'"],
  ['`', "'"],
  ['[', ' '],
  [']', ' '],
  ['|', ' '],
  ['/', ' '],
  ['#', ' '],
  ['→', ' '],
  ['←', ' ']
]
const DECORATIVE = /[♥☆♡©\\]/g
const ENDS_WITH_PUNCTUATION = /[.!?;:,'"')\]}…。」』】〉》›»]$/
/** After sentence-ending punctuation, unless it ends a common abbreviation (utils.py). */
const SENTENCE_BREAK =
  /(?<!Mr\.)(?<!Mrs\.)(?<!Ms\.)(?<!Dr\.)(?<!Prof\.)(?<!Sr\.)(?<!Jr\.)(?<!Ph\.D\.)(?<!etc\.)(?<!e\.g\.)(?<!i\.e\.)(?<!vs\.)(?<!Inc\.)(?<!Ltd\.)(?<!Co\.)(?<!Corp\.)(?<!St\.)(?<!Ave\.)(?<!Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/

/** Text as the model reads it, as the package prepares it (core.py, _preprocess_text). */
function prepare(text: string, lang: Language): string {
  let t = text.normalize('NFKD').replace(EMOJI, '')
  for (const [from, to] of SYMBOLS) t = t.replaceAll(from, to)
  t = t
    .replace(DECORATIVE, '')
    .replaceAll('@', ' at ')
    .replaceAll('e.g.,', 'for example, ')
    .replaceAll('i.e.,', 'that is, ')
    .replace(/ ([,.!?;:'])/g, '$1')
    .replace(/(["'`])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!ENDS_WITH_PUNCTUATION.test(t)) t += '.'
  return `<${lang}>${t}</${lang}>`
}

/** Text in chunks of whole sentences, paragraph by paragraph (utils.py, chunk_text). */
export function chunks(text: string, lang: Language): string[] {
  const max = lang === 'ko' ? MAX_CHUNK_KO : MAX_CHUNK
  const result: string[] = []
  for (const paragraph of text.trim().split(/\n\s*\n+/)) {
    let current = ''
    for (const sentence of paragraph.trim().split(SENTENCE_BREAK)) {
      const s = sentence.trim()
      if (!s) continue
      if (current.length + s.length + 1 <= max) {
        current += (current ? ' ' : '') + s
      } else {
        if (current) result.push(current)
        current = s
      }
    }
    if (current.trim()) result.push(current.trim())
  }
  return result
}

interface Style {
  ttl: Ort.Tensor
  dp: Ort.Tensor
}

export class Supertonic {
  private constructor(
    private readonly ort: typeof Ort,
    private readonly sessions: {
      duration: Ort.InferenceSession
      encoder: Ort.InferenceSession
      estimator: Ort.InferenceSession
      vocoder: Ort.InferenceSession
    },
    /** Each character code's index in the model; -1 for characters it does not know. */
    private readonly indexer: number[],
    private readonly style: Style,
    readonly sampleRate: number,
    /** Audio samples per latent frame. */
    private readonly chunkSize: number,
    /** Latent channels. */
    private readonly latentDim: number
  ) {}

  /** Load the model from `dir` (onnx/, and voice_styles/ with `voice`.json). */
  static async load(ort: typeof Ort, dir: string, voice: string): Promise<Supertonic> {
    const json = async <T>(path: string): Promise<T> =>
      JSON.parse(await readFile(join(dir, path), 'utf8')) as T
    const config = await json<{
      ae: { sample_rate: number; base_chunk_size: number }
      ttl: { chunk_compress_factor: number; latent_dim: number }
    }>('onnx/tts.json')
    const indexer = await json<number[]>('onnx/unicode_indexer.json')
    const styleJson = await json<
      Record<'style_ttl' | 'style_dp', { dims: number[]; data: unknown }>
    >(`voice_styles/${voice}.json`)
    const tensor = ({ dims, data }: { dims: number[]; data: unknown }): Ort.Tensor =>
      new ort.Tensor(
        'float32',
        Float32Array.from((data as number[]).flat(Infinity) as number[]),
        dims
      )
    const session = (name: string): Promise<Ort.InferenceSession> =>
      ort.InferenceSession.create(join(dir, 'onnx', `${name}.onnx`), {
        executionProviders: ['cpu']
      })
    const [duration, encoder, estimator, vocoder] = await Promise.all(
      ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'].map(session)
    )
    const compress = config.ttl.chunk_compress_factor
    return new Supertonic(
      ort,
      { duration, encoder, estimator, vocoder },
      indexer,
      { ttl: tensor(styleJson.style_ttl), dp: tensor(styleJson.style_dp) },
      config.ae.sample_rate,
      config.ae.base_chunk_size * compress,
      config.ttl.latent_dim * compress
    )
  }

  /** One chunk of text (see `chunks`) as audio samples at `sampleRate`. */
  async speak(text: string, lang: Language): Promise<Float32Array> {
    const { ort } = this
    const ids: bigint[] = []
    for (const char of prepare(text, lang)) {
      const index = this.indexer[char.codePointAt(0)!]
      if (index !== undefined && index >= 0) ids.push(BigInt(index))
    }
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids), [1, ids.length])
    const textMask = new ort.Tensor('float32', new Float32Array(ids.length).fill(1), [
      1,
      1,
      ids.length
    ])

    const { duration } = this.sessions
    const predicted = await duration.run({
      text_ids: textIds,
      style_dp: this.style.dp,
      text_mask: textMask
    })
    const seconds = (predicted[duration.outputNames[0]].data as Float32Array)[0] / SPEED
    const encoded = await this.sessions.encoder.run({
      text_ids: textIds,
      style_ttl: this.style.ttl,
      text_mask: textMask
    })
    const textEmb = encoded[this.sessions.encoder.outputNames[0]]

    // Noise in the latent's shape, masked to the predicted length (core.py, sample_noisy_latent).
    const wavLength = Math.trunc(seconds * this.sampleRate)
    const frames = Math.trunc((seconds * this.sampleRate + this.chunkSize - 1) / this.chunkSize)
    const usedFrames = Math.trunc((wavLength + this.chunkSize - 1) / this.chunkSize)
    const latentMaskData = new Float32Array(frames)
    for (let f = 0; f < Math.min(usedFrames, frames); f++) latentMaskData[f] = 1
    const latentMask = new ort.Tensor('float32', latentMaskData, [1, 1, frames])
    let latent: Float32Array = new Float32Array(this.latentDim * frames)
    for (let c = 0; c < this.latentDim; c++) {
      for (let f = 0; f < frames; f++) latent[c * frames + f] = gaussian() * latentMaskData[f]
    }

    const { estimator } = this.sessions
    const totalStep = new ort.Tensor('float32', new Float32Array([TOTAL_STEPS]), [1])
    for (let step = 0; step < TOTAL_STEPS; step++) {
      const out = await estimator.run({
        noisy_latent: new ort.Tensor('float32', latent, [1, this.latentDim, frames]),
        text_emb: textEmb,
        style_ttl: this.style.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        current_step: new ort.Tensor('float32', new Float32Array([step]), [1]),
        total_step: totalStep
      })
      latent = out[estimator.outputNames[0]].data as Float32Array
    }
    const { vocoder } = this.sessions
    const wav = await vocoder.run({
      latent: new ort.Tensor('float32', latent, [1, this.latentDim, frames])
    })
    return wav[vocoder.outputNames[0]].data as Float32Array
  }
}

/** A standard normal sample (Box-Muller), as numpy's randn. */
function gaussian(): number {
  let u = 0
  while (u === 0) u = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random())
}
