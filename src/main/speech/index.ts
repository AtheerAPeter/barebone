import { app, utilityProcess, type UtilityProcess } from 'electron'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SpeechStatus, SpeechStop, SpokenAudio } from '../../shared/types'
import { POCKET_FILES } from '../meeting-models'
import { downloadFiles, haveFiles, totalSize, type ModelFile } from '../models'
import { isPocketLanguage, type PocketLanguage } from './pocket-voices'
import type { Language } from './supertonic'
import type { FromWorker, ToWorker } from './worker'

/**
 * The voice agents speak with (the speak tool, chats-mcp.ts): Supertonic 3
 * with its M3 voice, run on this Mac in a process of its own (worker.ts). The
 * model is downloaded once, when the user turns speech on in Settings, from
 * the revision the voice was chosen at, and every file is checked against its
 * SHA-256 before it is used. Its process ends after a while without speaking,
 * which frees the memory the model takes.
 *
 * A chat in a meeting (main/meeting.ts) speaks with Pocket instead, in the
 * languages it has: it starts talking about 0.1 s after the text arrives,
 * where Supertonic takes a second or more. Its files come with the meeting.
 */

/** Supertonic 3 at the revision the supertonic Python package 1.3.1 pins. */
const REPO =
  'https://huggingface.co/Supertone/supertonic-3/resolve/724fb5abbf5502583fb520898d45929e62f02c0b'
const VOICE = 'M3'
const FILES: ModelFile[] = [
  { path: 'onnx/tts.json', size: 8253, sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' },
  { path: 'onnx/unicode_indexer.json', size: 277676, sha256: '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f' },
  { path: `voice_styles/${VOICE}.json`, size: 290198, sha256: 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b' },
  { path: 'onnx/duration_predictor.onnx', size: 3700147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
  { path: 'onnx/text_encoder.onnx', size: 36416150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
  { path: 'onnx/vocoder.onnx', size: 101424195, sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' },
  { path: 'onnx/vector_estimator.onnx', size: 256534781, sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' }
].map((file) => ({ ...file, url: `${REPO}/${file.path}` })) // prettier-ignore
const TOTAL = totalSize(FILES)

/** The engine's process ends after this long without speaking. */
const IDLE_MS = 5 * 60_000

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

export class Speech {
  private readonly dir = join(app.getPath('userData'), 'speech', 'supertonic-3')
  /** Pocket's bundles, one folder per language (meeting-models.ts). */
  private readonly pocketDir = join(app.getPath('userData'), 'speech', 'pocket')
  /** The chat in a meeting, which speaks with Pocket where it can. */
  private meetingChat?: string
  private download?: { received: number; abort: AbortController }
  private failure?: string
  private worker?: UtilityProcess
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Messages being made, with the chat that spoke them. */
  private readonly messages = new Map<string, { chatId?: string; text: string }>()
  /** Messages being made into files (save), with their pieces so far. */
  private readonly files = new Map<
    string,
    {
      pieces: Float32Array[]
      done: (audio: { samples: Float32Array; sampleRate: number }) => void
      fail: (error: Error) => void
    }
  >()
  /** Messages not heard to their end yet, with what to tell when they begin and end. */
  private readonly unsaid = new Map<
    string,
    {
      chatId?: string
      text: string
      begin: (begun: boolean) => void
      end: () => void
      ended: Promise<void>
    }
  >()

  constructor(
    private readonly events: {
      status(status: SpeechStatus): void
      /** Play a piece of a message; false when there is nowhere to play it. */
      audio(audio: SpokenAudio): boolean
      /** Stop playing a message, or what a chat said, or everything. */
      stop(which: SpeechStop): void
    }
  ) {}

  status(): SpeechStatus {
    if (this.download)
      return { state: 'downloading', received: this.download.received, total: TOTAL }
    if (this.failure) return { state: 'failed', message: this.failure, total: TOTAL }
    return { state: this.ready() ? 'ready' : 'missing', total: TOTAL }
  }

  private ready(): boolean {
    return haveFiles(this.dir, FILES)
  }

  /** Download the model, the files it does not have yet; resolves when done, failed or cancelled. */
  async fetchModel(): Promise<void> {
    if (this.download || this.ready()) return
    const abort = new AbortController()
    const download = { received: 0, abort }
    this.download = download
    this.failure = undefined
    let lastEmit = 0
    // Whatever goes wrong, it ends here: a download is never left looking as if it ran.
    try {
      this.emitStatus()
      await downloadFiles(this.dir, FILES, abort.signal, (received) => {
        download.received = received
        if (Date.now() - lastEmit < 200) return
        lastEmit = Date.now()
        this.emitStatus()
      })
    } catch (error) {
      if (!abort.signal.aborted) {
        this.failure = `The voice could not be downloaded: ${(error as Error).message}`
      }
    } finally {
      this.download = undefined
      this.emitStatus()
    }
  }

  /** Pocket's files for a language a meeting is in, and their size. */
  pocketFiles(language: string): ModelFile[] {
    return isPocketLanguage(language) ? POCKET_FILES[language] : []
  }

  /** Whether Pocket's files for a meeting's language are here; true for a language it does not speak. */
  pocketReady(language: string): boolean {
    return haveFiles(this.pocketDir, this.pocketFiles(language))
  }

  /** Download Pocket's files for a meeting's language, those it does not have yet. */
  fetchPocket(
    language: PocketLanguage,
    signal: AbortSignal,
    progress: (n: number) => void
  ): Promise<void> {
    return downloadFiles(this.pocketDir, POCKET_FILES[language], signal, progress)
  }

  /** The chat in a meeting, which speaks with Pocket from now on; none when the meeting ends. */
  setMeeting(chatId: string | undefined): void {
    this.meetingChat = chatId
  }

  cancelDownload(): void {
    this.download?.abort.abort()
  }

  /** Delete the model, to free its space; speech is off without it. */
  async remove(): Promise<void> {
    this.cancelDownload()
    this.stopWorker()
    await rm(this.dir, { recursive: true, force: true })
    this.failure = undefined
    this.emitStatus()
  }

  /**
   * Say a message out loud, after what is playing already, `pace` times as
   * fast as normal. Throws why it cannot be said.
   */
  speak(chatId: string | undefined, text: string, lang: Language, pace = 1): Spoken {
    if (!text.trim()) throw new Error('There is nothing to say: the text is empty.')
    const pocket =
      chatId !== undefined &&
      chatId === this.meetingChat &&
      isPocketLanguage(lang) &&
      haveFiles(this.pocketDir, POCKET_FILES[lang])
    if (!pocket && !this.ready()) {
      throw new Error('The voice is not downloaded. The user can download it in Settings.')
    }
    const id = crypto.randomUUID()
    let begin: (begun: boolean) => void = () => undefined
    let end: () => void = () => undefined
    const started = new Promise<boolean>((resolve) => (begin = resolve))
    const ended = new Promise<void>((resolve) => (end = resolve))
    this.unsaid.set(id, { chatId, text, begin, end, ended })
    this.messages.set(id, { chatId, text })
    this.send({ type: 'speak', id, text, lang, pace, engine: pocket ? 'pocket' : 'supertonic' })
    return { started, ended, stop: () => this.stopMessage(id) }
  }

  /**
   * Say a message into a new WAV file instead of out loud; resolves with how
   * long it is, in seconds, once the file is written. Throws why it cannot be.
   */
  async save(path: string, text: string, lang: Language, pace = 1): Promise<number> {
    if (!text.trim()) throw new Error('There is nothing to say: the text is empty.')
    if (!this.ready()) {
      throw new Error('The voice is not downloaded. The user can download it in Settings.')
    }
    const id = crypto.randomUUID()
    const { samples, sampleRate } = await new Promise<{
      samples: Float32Array
      sampleRate: number
    }>((done, fail) => {
      this.files.set(id, { pieces: [], done, fail })
      this.send({ type: 'speak', id, text, lang, pace, engine: 'supertonic' })
    })
    await mkdir(dirname(path), { recursive: true })
    // A new file only, as videos are (main/recording.ts).
    await writeFile(path, wav(samples, sampleRate), { flag: 'wx' }).catch(
      (error: NodeJS.ErrnoException) => {
        throw error.code === 'EEXIST'
          ? new Error(`${path} exists already. Save to a new file.`)
          : error
      }
    )
    return samples.length / sampleRate
  }

  /** Once everything a chat has said so far has been heard, or will not be. */
  async said(chatId: string): Promise<void> {
    const waiting = [...this.unsaid.values()].filter((message) => message.chatId === chatId)
    await Promise.all(waiting.map((message) => message.ended))
  }

  /** What a chat is saying, or is yet to say, message by message (see meeting.ts). */
  saying(chatId: string): string[] {
    return [...this.unsaid.values()].filter((m) => m.chatId === chatId).map((m) => m.text)
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
    for (const [id, message] of this.messages) {
      if (chatId !== undefined && message.chatId !== chatId) continue
      this.messages.delete(id)
      this.worker?.postMessage({ type: 'cancel', id } satisfies ToWorker)
    }
    for (const [id, message] of this.unsaid) {
      if (chatId === undefined || message.chatId === chatId) this.finish(id)
    }
    this.events.stop(chatId === undefined ? {} : { chatId })
  }

  /** Quit: the engine's process ends with the app. */
  dispose(): void {
    this.cancelDownload()
    this.stopWorker()
  }

  /** Stop one message, made or playing. */
  private stopMessage(id: string): void {
    this.messages.delete(id)
    this.worker?.postMessage({ type: 'cancel', id } satisfies ToWorker)
    this.finish(id)
    this.events.stop({ id })
  }

  /** A message is over: heard to its end, or never to be (a message stopped before it began never began). */
  private finish(id: string): void {
    const message = this.unsaid.get(id)
    this.unsaid.delete(id)
    message?.begin(false)
    message?.end()
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
      this.dropMessages()
    })
    worker.postMessage({
      type: 'load',
      dir: this.dir,
      voice: VOICE,
      pocketDir: this.pocketDir
    } satisfies ToWorker)
    this.worker = worker
  }

  private onWorker(message: FromWorker): void {
    this.keepAlive()
    const file = 'id' in message ? this.files.get(message.id) : undefined
    if (file && message.type === 'audio') {
      file.pieces.push(message.samples)
      if (!message.last) return
      this.files.delete(message.id)
      // The pieces back to back, as the player plays them.
      const samples = new Float32Array(file.pieces.reduce((sum, piece) => sum + piece.length, 0))
      let at = 0
      for (const piece of file.pieces) {
        samples.set(piece, at)
        at += piece.length
      }
      file.done({ samples, sampleRate: message.sampleRate })
    } else if (file && message.type === 'failed') {
      this.files.delete(message.id)
      file.fail(new Error(`The voice could not say it: ${message.message}`))
    } else if (message.type === 'audio') {
      const spoken = this.messages.get(message.id)
      if (!spoken) return
      const played = this.events.audio({
        id: message.id,
        ...(spoken.chatId ? { chatId: spoken.chatId } : {}),
        text: spoken.text,
        samples: message.samples,
        sampleRate: message.sampleRate,
        last: message.last
      })
      if (!played) this.stopMessage(message.id)
      else if (message.last) this.messages.delete(message.id)
    } else if (message.type === 'failed') {
      console.error('[speech] could not speak:', message.message)
      // The rest will not come, so what came of it stops too: a message ends whole or not at all.
      this.stopMessage(message.id)
    } else if (message.type === 'error') {
      console.error('[speech] the engine did not start:', message.message)
      this.failure = `The voice could not be loaded: ${message.message}`
      this.emitStatus()
      this.stopWorker()
    }
  }

  private keepAlive(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.messages.size === 0) this.stopWorker()
      else this.keepAlive()
    }, IDLE_MS)
  }

  private stopWorker(): void {
    clearTimeout(this.idleTimer)
    this.worker?.kill()
    this.worker = undefined
    this.dropMessages()
  }

  /** The engine ended: the messages it was making will not come. */
  private dropMessages(): void {
    for (const id of [...this.messages.keys()]) this.stopMessage(id)
    for (const [id, file] of this.files) {
      this.files.delete(id)
      file.fail(new Error('The voice stopped before it was done.'))
    }
  }

  private emitStatus(): void {
    this.events.status(this.status())
  }
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
