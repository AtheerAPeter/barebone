import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  Downloads,
  DownloadStatus,
  SpokenAudio,
  SpeechStop,
  VoiceModelId
} from '../../shared/types'
import { Package } from '../downloads'
import { AudioCpp, readWav, type ServerModel } from './audiocpp'
import { chunks, type Language } from './supertonic'
import type { FromWorker, ToWorker } from './worker'

/**
 * The voices agents speak with (the speak tool, chats-mcp.ts), and the music
 * they make for videos, all made on this Mac:
 *
 * - Supertonic 3 with its M3 voice: fast, in 31 languages, the same tone
 *   whatever is said. It runs in a process of its own (worker.ts).
 * - VoxCPM2: natural, and it speaks in the mood a message asks for, in 30
 *   languages; a little slower than speech on an M4. It speaks in one voice
 *   made once from a description (makeVoice), so every message sounds like
 *   the same person.
 * - Stable Audio 3 Small Music, which makes music from a description: for
 *   videos, and played with a message, like a drum roll before the news.
 *
 * VoxCPM2 and Stable Audio run on audio.cpp (audiocpp.ts). The user downloads
 * each in Settings, turns the voices on or off, and picks which voice speaks
 * Arabic and which every other language, and whether chats speak with
 * Supertonic instead, which starts at once; videos keep the picked voice. Every file comes from one pinned
 * revision and is checked against its SHA-256 (downloads.ts).
 */

/** Supertonic 3 at the revision the supertonic Python package 1.3.1 pins. */
const SUPERTONIC =
  'https://huggingface.co/Supertone/supertonic-3/resolve/724fb5abbf5502583fb520898d45929e62f02c0b'
const SUPERTONIC_VOICE = 'M3'
const SUPERTONIC_FILES = [
  { path: 'onnx/tts.json', size: 8253, sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' },
  { path: 'onnx/unicode_indexer.json', size: 277676, sha256: '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f' },
  { path: `voice_styles/${SUPERTONIC_VOICE}.json`, size: 290198, sha256: 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b' },
  { path: 'onnx/duration_predictor.onnx', size: 3700147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
  { path: 'onnx/text_encoder.onnx', size: 36416150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
  { path: 'onnx/vocoder.onnx', size: 101424195, sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' },
  { path: 'onnx/vector_estimator.onnx', size: 256534781, sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' }
].map((file) => ({ ...file, url: `${SUPERTONIC}/${file.path}` })) // prettier-ignore

/** audio.cpp 0.9.4, its macOS build for Apple Silicon with Metal. */
const AUDIOCPP = {
  url: 'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-macos-arm64-metal.tar.gz',
  path: 'audiocpp.tar.gz',
  size: 36947118,
  sha256: '5722c4f33e56114345965c0dee472a9239218f7499ace6393bba6a951a41b86a',
  archive: { kind: 'tar' as const, unpacked: 'audiocpp_server' }
}

/** audio.cpp's own GGUF conversions of the models, at one revision. */
const GGUF =
  'https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/73ce4162f6cce370dd533c6782b772135c1b2a8e'
const VOXCPM2 = {
  url: `${GGUF}/VoxCPM2-GGUF/voxcpm2-q8_0.gguf`,
  path: 'voxcpm2-q8_0.gguf',
  size: 2955007488,
  sha256: '8df1faf274e1bdeedef1fd9ddd6aba6632536f66f2e080991d2352af35ceef72'
}
const MUSIC = {
  url: `${GGUF}/Stable-Audio-3-Small-Music-GGUF/stable-audio-3-small-music-q8_0.gguf`,
  path: 'stable-audio-3-small-music-q8_0.gguf',
  size: 1683576608,
  sha256: 'a6d9176e11b857409b28cf5a69f4fefd8f3e61907b3b10d867f1f4c0a7eb9418'
}

/** The languages VoxCPM2 speaks, of the ones the speak tool takes. */
const VOXCPM2_LANGUAGES = new Set<Language>([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'sv', 'tr', 'vi'
]) // prettier-ignore

/** VoxCPM2 speaks a sentence at a time (short ones together), so the first is heard soon. */
const VOXCPM2_CHUNK = 60

/** The voice VoxCPM2 speaks in until the user or an agent describes another. */
export const DEFAULT_VOICE_DESCRIPTION =
  'A warm, friendly man in his thirties with a clear, natural voice'
/** What the made voice says, the recording every message copies the voice from. */
const VOICE_TEXT =
  "Hi there. I'm the voice your agents speak with. I'll tell you when something is done, when I need your answer, and what I found along the way."
/** One seed for every voice made, so a description makes the same voice each time. */
const VOICE_SEED = 1234

/** Music agents make is at most this long, in seconds. */
export const MAX_MUSIC_SECONDS = 120

/** Supertonic's engine process ends after this long without speaking. */
const IDLE_MS = 5 * 60_000

/** What the speech module downloads: the voices and the music model. */
export type SpeechDownload = 'supertonic' | 'voxcpm2' | 'music'

/** What Settings has for the voices (store.ts). */
export interface VoiceSettings {
  /** Speech is on at all. */
  on: boolean
  off: VoiceModelId[]
  voiceFor: { arabic?: VoiceModelId; other?: VoiceModelId }
  /** Chats speak with Supertonic, which starts at once; videos and saved files keep voiceFor's voice. */
  supertonicInChats: boolean
  description?: string
}

/** Which voice says a message, beyond its language. */
export interface VoiceChoice {
  /** The voice to say it with instead of Settings', for samples. */
  model?: VoiceModelId
  /** It is said into a video being recorded, so it keeps the voice Settings picks per language. */
  recorded?: boolean
}

/** How a message is said, beyond its words. */
export interface Delivery {
  /** How fast, 0.7 to 1.5; 1 when missing. */
  pace?: number
  /** The mood to say it in, like "excited" or "calm and reassuring"; VoxCPM2 only. */
  mood?: string
  /** Music made for it and played with it, out loud only. */
  music?: MessageMusic
}

/** Music a message plays with, like a drum roll before the news. */
export interface MessageMusic {
  /** What it sounds like, in English. */
  description: string
  seconds: number
  /** Under the words, quieter while the voice talks; else before them. */
  under: boolean
}

/** A message on its way out. */
export interface Spoken {
  /**
   * True as it is about to begin (a moment before, for what is shown with it);
   * false when it never will (it failed or was stopped).
   */
  started: Promise<boolean>
  /** Once it has been heard to its end, or will not be: it failed or was stopped. */
  ended: Promise<void>
  /** Stop it, made or playing. */
  stop(): void
}

/** A message to make: played, or saved to a file. */
interface Job {
  id: string
  chatId?: string
  text: string
  lang: Language
  delivery: Delivery
  model: VoiceModelId
  /** For a file: the pieces so far, and what to tell when it is whole or failed. */
  file?: {
    pieces: Float32Array[]
    done: (audio: { samples: Float32Array; sampleRate: number }) => void
    fail: (error: Error) => void
  }
  /** Music to play under the words, kept until the voice's first piece is made. */
  under?: { samples: Float32Array; sampleRate: number }
}

export class Speech {
  private readonly emit = (): void => this.events.downloads()
  private readonly engine = new Package(
    'downloads/audiocpp-0.9.4',
    [AUDIOCPP],
    'The audio engine',
    this.emit
  )
  private readonly packages = {
    // Where the first version kept it, so a voice downloaded then is still there.
    supertonic: new Package('speech/supertonic-3', SUPERTONIC_FILES, 'The voice', this.emit),
    voxcpm2: new Package('downloads/voxcpm2', [VOXCPM2], 'VoxCPM2', this.emit, [this.engine]),
    music: new Package('downloads/stable-audio-3-small-music', [MUSIC], 'The music model', this.emit, [this.engine])
  } // prettier-ignore
  private readonly audiocpp = new AudioCpp(this.engine, () => this.serverModels())
  /** VoxCPM2's voice: the recording it copies and what it says, made from a description. */
  private readonly voiceDir: string
  private making?: Promise<void>

  private worker?: UtilityProcess
  private workerFailure?: string
  private idleTimer?: ReturnType<typeof setTimeout>

  /** Messages waiting to be made, in order; one is made at a time, whatever its voice. */
  private readonly queue: Job[] = []
  /** The one being made, how to stop making it, and Supertonic's process making it. */
  private current?: {
    job: Job
    done: () => void
    abort: AbortController
    worker?: UtilityProcess
  }
  /** Messages being made or playing, with the chat that spoke them. */
  private readonly messages = new Map<string, Job>()
  /** Messages not heard to their end yet, with what to tell when they begin and end. */
  private readonly unsaid = new Map<
    string,
    { chatId?: string; begin: (begun: boolean) => void; end: () => void; ended: Promise<void> }
  >()

  constructor(
    userData: string,
    private readonly settings: () => VoiceSettings,
    private readonly events: {
      /** What is downloaded changed, or a download moved on. */
      downloads(): void
      /** VoxCPM2's voice was made from a new description. */
      described(description: string): void
      /** Play a piece of a message; false when there is nowhere to play it. */
      audio(audio: SpokenAudio): boolean
      /** Stop playing a message, or what a chat said, or everything. */
      stop(which: SpeechStop): void
    }
  ) {
    this.voiceDir = join(userData, 'speech', 'voxcpm2-voice')
  }

  downloads(): Omit<Downloads, 'ffmpeg'> {
    const status = (id: SpeechDownload): DownloadStatus => {
      const s = this.packages[id].status()
      // A voice that would not load is as good as not there.
      return id === 'supertonic' && s.state === 'ready' && this.workerFailure
        ? { state: 'failed' as const, message: this.workerFailure, total: s.total }
        : s
    }
    return { supertonic: status('supertonic'), voxcpm2: status('voxcpm2'), music: status('music') }
  }

  /** Download one of the models; resolves when done, failed or cancelled. */
  async fetch(id: SpeechDownload): Promise<void> {
    if (id === 'supertonic') this.workerFailure = undefined
    await this.packages[id].fetch()
  }

  cancel(id: SpeechDownload): void {
    this.packages[id].cancel()
  }

  /**
   * Delete a model, to free its space; the audio engine goes too once no
   * model needs it. A server still running the other model goes on, and is
   * started again without this one at its next request.
   */
  async remove(id: SpeechDownload): Promise<void> {
    if (id === 'supertonic') {
      this.stopWorker()
      this.workerFailure = undefined
    }
    if (id === 'voxcpm2') await rm(this.voiceDir, { recursive: true, force: true })
    await this.packages[id].remove()
    if (!this.packages.voxcpm2.own() && !this.packages.music.own()) {
      this.audiocpp.stop()
      await this.engine.remove()
    }
  }

  /** The voices that can speak now: on this Mac, and on in Settings. */
  private usable(): VoiceModelId[] {
    const { on, off } = this.settings()
    if (!on) return []
    return (['supertonic', 'voxcpm2'] as const).filter(
      (id) =>
        !off.includes(id) &&
        this.packages[id].ready() &&
        !(id === 'supertonic' && this.workerFailure)
    )
  }

  /** Whether agents can speak now: speech is on and a voice is on this Mac. */
  offered(): boolean {
    return this.usable().length > 0
  }

  /** Whether VoxCPM2 speaks now, so moods and set_voice mean something. */
  natural(): boolean {
    return this.usable().includes('voxcpm2')
  }

  /** Whether agents can make music now. */
  musicReady(): boolean {
    return this.packages.music.ready()
  }

  /**
   * The voice that says something in a language: `model`, else Supertonic for
   * what a chat says live while Settings asks for it, else the one Settings
   * picks for the language; one that can when that one cannot.
   */
  private voiceFor(
    lang: Language,
    { model, live }: { model?: VoiceModelId; live: boolean }
  ): VoiceModelId {
    const usable = this.usable()
    const { voiceFor, supertonicInChats } = this.settings()
    const picked =
      model ??
      (live && supertonicInChats
        ? 'supertonic'
        : lang === 'ar'
          ? voiceFor.arabic
          : voiceFor.other) ??
      'supertonic'
    const speaks = (id: VoiceModelId): boolean => id === 'supertonic' || VOXCPM2_LANGUAGES.has(lang)
    const choice = [picked, ...usable].find((id) => usable.includes(id) && speaks(id))
    if (!choice) {
      throw new Error(
        usable.length
          ? `No voice that is on speaks this language (${lang}).`
          : 'No voice is on. The user can download one and turn it on in Settings.'
      )
    }
    return choice
  }

  /**
   * Say a message out loud, after what is playing already. Throws why it
   * cannot be said.
   */
  speak(
    chatId: string | undefined,
    text: string,
    lang: Language,
    delivery: Delivery = {},
    { model, recorded = false }: VoiceChoice = {}
  ): Spoken {
    if (!text.trim()) throw new Error('There is nothing to say: the text is empty.')
    if (delivery.music && !this.packages.music.ready()) {
      throw new Error('The music model is not on this Mac. The user can download it in Settings.')
    }
    const job: Job = {
      id: crypto.randomUUID(),
      chatId,
      text,
      lang,
      delivery,
      model: this.voiceFor(lang, { model, live: !recorded })
    }
    let begin: (begun: boolean) => void = () => undefined
    let end: () => void = () => undefined
    const started = new Promise<boolean>((resolve) => (begin = resolve))
    const ended = new Promise<void>((resolve) => (end = resolve))
    this.unsaid.set(job.id, { chatId, begin, end, ended })
    this.enqueue(job)
    return { started, ended, stop: () => this.stopMessage(job.id) }
  }

  /**
   * Say a message into a new WAV file instead of out loud; resolves with how
   * long it is, in seconds, once the file is written. Throws why it cannot be.
   */
  async save(
    path: string,
    text: string,
    lang: Language,
    delivery: Omit<Delivery, 'music'> = {}
  ): Promise<number> {
    if (!text.trim()) throw new Error('There is nothing to say: the text is empty.')
    // A file is for a video or audio of the agent's own, so it keeps the voice Settings picks.
    const model = this.voiceFor(lang, { live: false })
    const { samples, sampleRate } = await new Promise<{
      samples: Float32Array
      sampleRate: number
    }>((done, fail) =>
      this.enqueue({
        id: crypto.randomUUID(),
        text,
        lang,
        delivery,
        model,
        file: { pieces: [], done, fail }
      })
    )
    await writeNew(path, wav(samples, sampleRate))
    return samples.length / sampleRate
  }

  /**
   * Make VoxCPM2's voice from a description, for every message from now on;
   * resolves once it is made. Throws why it cannot be.
   */
  async makeVoice(description: string): Promise<void> {
    const wanted = description.trim()
    if (!wanted) throw new Error('Describe the voice: who speaks, and how they sound.')
    if (!this.packages.voxcpm2.ready()) {
      throw new Error('VoxCPM2 is not on this Mac. The user can download it in Settings.')
    }
    const previous = this.making
    const making = (async () => {
      await previous?.catch(() => undefined)
      const response = await this.audiocpp.request('/v1/audio/speech', {
        model: 'voxcpm2',
        input: `(${wanted}) ${VOICE_TEXT}`,
        response_format: 'wav',
        seed: VOICE_SEED
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      readWav(bytes) // A recording it can read, or an error now rather than at every message.
      await mkdir(this.voiceDir, { recursive: true })
      const file = join(this.voiceDir, 'voice.wav')
      await writeFile(`${file}.part`, bytes)
      await rename(`${file}.part`, file)
      await writeFile(join(this.voiceDir, 'voice.json'), JSON.stringify({ description: wanted }))
      this.events.described(wanted)
    })()
    this.making = making
    try {
      await making
    } finally {
      if (this.making === making) this.making = undefined
    }
  }

  /** The recording VoxCPM2 copies its voice from; made first when there is none for the description. */
  private async voice(): Promise<string> {
    await this.making?.catch(() => undefined)
    const file = join(this.voiceDir, 'voice.wav')
    const description = this.settings().description ?? DEFAULT_VOICE_DESCRIPTION
    const made = await readFile(join(this.voiceDir, 'voice.json'), 'utf8')
      .then((text) => (JSON.parse(text) as { description?: string }).description)
      .catch(() => undefined)
    if (!existsSync(file) || made !== description) await this.makeVoice(description)
    return file
  }

  /**
   * Make music from a description into a new WAV file; resolves with its
   * length in seconds once written. Throws why it cannot be.
   */
  async makeMusic(path: string, description: string, seconds: number): Promise<number> {
    if (!this.packages.music.ready()) {
      throw new Error('The music model is not on this Mac. The user can download it in Settings.')
    }
    const { bytes, samples, sampleRate } = await this.music(description, seconds)
    await writeNew(path, bytes)
    return samples.length / sampleRate
  }

  /** Music made from a description: its WAV file, and its samples. */
  private async music(
    description: string,
    seconds: number,
    signal?: AbortSignal
  ): Promise<{ bytes: Buffer; samples: Float32Array; sampleRate: number }> {
    const response = await this.audiocpp.request(
      '/v1/tasks/run',
      { model: 'music', request: { text: description, duration_seconds: seconds } },
      signal
    )
    const result = (await response.json()) as { result?: { audio?: string }; audio?: string }
    const audio = result.result?.audio ?? result.audio
    if (!audio) throw new Error('The music model returned no audio.')
    const bytes = Buffer.from(audio.replace(/^data:[^,]*,/, ''), 'base64')
    return { bytes, ...readWav(bytes) }
  }

  /** Once everything a chat has said so far has been heard, or will not be. */
  async said(chatId: string): Promise<void> {
    const waiting = [...this.unsaid.values()].filter((message) => message.chatId === chatId)
    await Promise.all(waiting.map((message) => message.ended))
  }

  /** The player is about to play a message (lib/speech.ts). */
  begun(id: string): void {
    this.unsaid.get(id)?.begin(true)
  }

  /** The player played a message to its end. */
  ended(id: string): void {
    this.finish(id)
  }

  /** Stop what a chat is saying, and what it was going to say; every chat's when undefined. */
  stop(chatId?: string): void {
    for (const job of [...this.messages.values()]) {
      // Speech saved to a file is no one's to hear, so it goes on.
      if (job.file || (chatId !== undefined && job.chatId !== chatId)) continue
      this.cancelJob(job.id)
    }
    for (const [id, message] of this.unsaid) {
      if (chatId === undefined || message.chatId === chatId) this.finish(id)
    }
    this.events.stop(chatId === undefined ? {} : { chatId })
  }

  /** Quit: the engines' processes end with the app. */
  dispose(): void {
    for (const p of Object.values(this.packages)) p.cancel()
    this.stopWorker()
    this.audiocpp.stop()
  }

  private enqueue(job: Job): void {
    this.messages.set(job.id, job)
    this.queue.push(job)
    void this.next()
  }

  /** Make the next message, once the one before is made. */
  private async next(): Promise<void> {
    if (this.current) return
    const job = this.queue.shift()
    if (!job) return
    const abort = new AbortController()
    let done!: () => void
    const made = new Promise<void>((resolve) => (done = resolve))
    const current: NonNullable<Speech['current']> = { job, done, abort }
    this.current = current
    try {
      if (job.delivery.music && !job.file)
        await this.playMusic(job, job.delivery.music, abort.signal)
      if (abort.signal.aborted) return
      if (job.model === 'supertonic') {
        this.send({
          type: 'speak',
          id: job.id,
          text: job.text,
          lang: job.lang,
          pace: job.delivery.pace ?? 1
        })
        current.worker = this.worker
        await made
      } else {
        await this.speakVoxcpm2(job, abort.signal)
      }
    } catch (error) {
      if (!abort.signal.aborted) this.failJob(job, error as Error)
    } finally {
      this.current = undefined
      void this.next()
    }
  }

  private async speakVoxcpm2(job: Job, signal: AbortSignal): Promise<void> {
    const voice = await this.voice()
    const parts = chunks(job.text, job.lang, VOXCPM2_CHUNK)
    const style = styleOf(job.delivery)
    for (const [index, part] of parts.entries()) {
      if (signal.aborted) return
      const response = await this.audiocpp.request(
        '/v1/audio/speech',
        {
          model: 'voxcpm2',
          input: style ? `(${style}) ${part}` : part,
          voice_ref: { type: 'path', path: voice },
          reference_text: VOICE_TEXT,
          response_format: 'wav'
        },
        signal
      )
      const { samples, sampleRate } = readWav(new Uint8Array(await response.arrayBuffer()))
      if (signal.aborted) return
      this.deliver(job, samples, sampleRate, index === parts.length - 1)
    }
  }

  /**
   * Make a message's music. Music before the words goes to the player now, and
   * plays while the voice is made; music under them waits for the voice's first
   * piece, so the voice comes in after the music's short intro, not seconds
   * later. Music that cannot be made is left out: the words are what the
   * message is for.
   */
  private async playMusic(job: Job, music: MessageMusic, signal: AbortSignal): Promise<void> {
    try {
      const { samples, sampleRate } = await this.music(music.description, music.seconds, signal)
      if (signal.aborted) return
      if (music.under) job.under = { samples, sampleRate }
      else this.deliver(job, samples, sampleRate, false, 'before')
    } catch (error) {
      if (!signal.aborted)
        console.error('[speech] no music for the message:', (error as Error).message)
    }
  }

  /** A piece of a message is made: to the player, or to its file. */
  private deliver(
    job: Job,
    samples: Float32Array,
    sampleRate: number,
    last: boolean,
    music?: SpokenAudio['music']
  ): void {
    if (!this.messages.has(job.id)) return
    if (job.file) {
      job.file.pieces.push(samples)
      if (!last) return
      this.messages.delete(job.id)
      // The pieces back to back, as the player plays them.
      const whole = new Float32Array(job.file.pieces.reduce((sum, piece) => sum + piece.length, 0))
      let at = 0
      for (const piece of job.file.pieces) {
        whole.set(piece, at)
        at += piece.length
      }
      job.file.done({ samples: whole, sampleRate })
      return
    }
    if (job.under) {
      const under = job.under
      job.under = undefined
      this.deliver(job, under.samples, under.sampleRate, false, 'under')
      if (!this.messages.has(job.id)) return
    }
    const played = this.events.audio({
      id: job.id,
      ...(job.chatId ? { chatId: job.chatId } : {}),
      text: job.text,
      samples,
      sampleRate,
      last,
      ...(music ? { music } : {})
    })
    if (!played) this.stopMessage(job.id)
    else if (last) this.messages.delete(job.id)
  }

  private failJob(job: Job, error: Error): void {
    console.error('[speech] could not speak:', error.message)
    if (job.file) {
      this.messages.delete(job.id)
      job.file.fail(new Error(`The voice could not say it: ${error.message}`))
      return
    }
    // The rest will not come, so what came of it stops too: a message ends whole or not at all.
    this.stopMessage(job.id)
  }

  /** Stop one message, made or playing. */
  private stopMessage(id: string): void {
    this.cancelJob(id)
    this.finish(id)
    this.events.stop({ id })
  }

  /** Stop making a message, or drop it from the queue. */
  private cancelJob(id: string): void {
    const job = this.messages.get(id)
    this.messages.delete(id)
    const queued = this.queue.findIndex((j) => j.id === id)
    if (queued >= 0) this.queue.splice(queued, 1)
    if (this.current?.job.id === id) {
      this.current.abort.abort()
      this.worker?.postMessage({ type: 'cancel', id } satisfies ToWorker)
      this.current.done()
    }
    job?.file?.fail(new Error('The voice was stopped before it was done.'))
  }

  /** A message is over: heard to its end, or never to be (a message stopped before it began never began). */
  private finish(id: string): void {
    const message = this.unsaid.get(id)
    this.unsaid.delete(id)
    message?.begin(false)
    message?.end()
  }

  /** The models audio.cpp runs, of the ones on this Mac. */
  private serverModels(): ServerModel[] {
    const models: ServerModel[] = []
    if (this.packages.voxcpm2.own()) {
      models.push({
        id: 'voxcpm2',
        family: 'voxcpm2',
        path: join(this.packages.voxcpm2.dir, VOXCPM2.path),
        task: 'tts'
      })
    }
    if (this.packages.music.own()) {
      models.push({
        id: 'music',
        family: 'stable_audio',
        path: join(this.packages.music.dir, MUSIC.path),
        task: 'gen'
      })
    }
    return models
  }

  private send(message: ToWorker): void {
    if (!this.worker) this.startWorker()
    this.worker!.postMessage(message)
    this.keepAlive()
  }

  private startWorker(): void {
    const worker = utilityProcess.fork(join(import.meta.dirname, 'speech-worker.js'), [], {
      serviceName: 'Barebone speech'
    })
    worker.on('message', (message: FromWorker) => this.onWorker(message))
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = undefined
      // What it was making will not come; a message sent to a newer process goes on.
      const current = this.current
      if (current?.job.model === 'supertonic' && current.worker === worker) {
        this.failJob(current.job, new Error('the voice stopped'))
        current.done()
      }
    })
    worker.postMessage({
      type: 'load',
      dir: this.packages.supertonic.dir,
      voice: SUPERTONIC_VOICE
    } satisfies ToWorker)
    this.worker = worker
  }

  private onWorker(message: FromWorker): void {
    this.keepAlive()
    const current = this.current?.job.model === 'supertonic' ? this.current : undefined
    if (message.type === 'audio') {
      if (current?.job.id !== message.id) return
      this.deliver(current.job, message.samples, message.sampleRate, message.last)
      if (message.last) current.done()
    } else if (message.type === 'failed') {
      if (current?.job.id !== message.id) return
      this.failJob(current.job, new Error(message.message))
      current.done()
    } else if (message.type === 'error') {
      console.error('[speech] the engine did not start:', message.message)
      this.workerFailure = `The voice could not be loaded: ${message.message}`
      this.emit()
      if (current) {
        this.failJob(current.job, new Error(message.message))
        current.done()
      }
      this.stopWorker()
    }
  }

  private keepAlive(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.current?.job.model === 'supertonic') this.keepAlive()
      else this.stopWorker()
    }, IDLE_MS)
  }

  private stopWorker(): void {
    clearTimeout(this.idleTimer)
    const worker = this.worker
    this.worker = undefined
    worker?.kill()
  }
}

/** What VoxCPM2 is told about how to say a message: its mood, and its pace in words. */
function styleOf({ mood, pace = 1 }: Delivery): string {
  const parts = [mood?.trim().replace(/[()]/g, '')].filter(Boolean) as string[]
  if (pace < 0.9) parts.push('speaking slowly')
  else if (pace > 1.15) parts.push('speaking quickly')
  return parts.join(', ')
}

/** Write a new file only, as videos are (main/recording.ts). */
async function writeNew(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'EEXIST' ? new Error(`${path} exists already. Save to a new file.`) : error
  })
}

/** Mono samples as a 16-bit PCM WAV file, which every player and editor opens. */
function wav(samples: Float32Array, sampleRate: number): Buffer {
  const data = samples.length * 2
  const out = Buffer.alloc(44 + data)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + data, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(data, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2)
  }
  return out
}
