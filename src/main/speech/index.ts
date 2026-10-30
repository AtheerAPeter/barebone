import { app, net, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SpeechStatus, SpeechStop, SpokenAudio } from '../../shared/types'
import type { Language } from './supertonic'
import type { FromWorker, ToWorker } from './worker'

/**
 * The voice agents speak with (the speak tool, chats-mcp.ts): Supertonic 3
 * with its M3 voice, run on this Mac in a process of its own (worker.ts). The
 * model is downloaded once, when the user turns speech on in Settings, from
 * the revision the voice was chosen at, and every file is checked against its
 * SHA-256 before it is used. Its process ends after a while without speaking,
 * which frees the memory the model takes.
 */

/** Supertonic 3 at the revision the supertonic Python package 1.3.1 pins. */
const REPO =
  'https://huggingface.co/Supertone/supertonic-3/resolve/724fb5abbf5502583fb520898d45929e62f02c0b'
const VOICE = 'M3'
const FILES = [
  { path: 'onnx/tts.json', size: 8253, sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09' },
  { path: 'onnx/unicode_indexer.json', size: 277676, sha256: '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f' },
  { path: `voice_styles/${VOICE}.json`, size: 290198, sha256: 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b' },
  { path: 'onnx/duration_predictor.onnx', size: 3700147, sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db' },
  { path: 'onnx/text_encoder.onnx', size: 36416150, sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff' },
  { path: 'onnx/vocoder.onnx', size: 101424195, sha256: '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba' },
  { path: 'onnx/vector_estimator.onnx', size: 256534781, sha256: '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c' }
] // prettier-ignore
const TOTAL = FILES.reduce((sum, file) => sum + file.size, 0)

/** A file that receives nothing this long has stalled: it is stopped and tried again. */
const STALL_MS = 30_000
/** Tries of each file before the download fails. */
const ATTEMPTS = 3

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
  private download?: { received: number; abort: AbortController }
  private failure?: string
  private worker?: UtilityProcess
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Messages being made, with the chat that spoke them. */
  private readonly messages = new Map<string, { chatId?: string; text: string }>()
  /** Messages not heard to their end yet, with what to tell when they begin and end. */
  private readonly unsaid = new Map<
    string,
    { chatId?: string; begin: (begun: boolean) => void; end: () => void; ended: Promise<void> }
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

  /** Every file is there at its size; they were checked against their SHA-256 when downloaded. */
  private ready(): boolean {
    return FILES.every((file) => {
      const path = join(this.dir, file.path)
      return existsSync(path) && statSync(path).size === file.size
    })
  }

  /** Download the model, the files it does not have yet; resolves when done, failed or cancelled. */
  async fetchModel(): Promise<void> {
    if (this.download || this.ready()) return
    const abort = new AbortController()
    this.download = { received: 0, abort }
    this.failure = undefined
    // Whatever goes wrong, it ends here: a download is never left looking as if it ran.
    try {
      this.emitStatus()
      for (const file of FILES) {
        const path = join(this.dir, file.path)
        if (existsSync(path) && statSync(path).size === file.size) {
          this.download.received += file.size
          continue
        }
        for (let attempt = 1; ; attempt++) {
          const before = this.download.received
          try {
            await this.fetchFile(file, path, abort.signal)
            break
          } catch (error) {
            if (abort.signal.aborted || attempt === ATTEMPTS) throw error
            console.error(`[speech] ${file.path}, try ${attempt}:`, (error as Error).message)
            this.download.received = before
            this.emitStatus()
            await sleep(attempt * 2000)
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.failure = `The voice could not be downloaded: ${(error as Error).message}`
      }
    } finally {
      this.download = undefined
      this.emitStatus()
    }
  }

  private async fetchFile(
    file: (typeof FILES)[number],
    path: string,
    signal: AbortSignal
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    // Stopped when the user cancels, and when nothing arrives for STALL_MS:
    // a connection that stalls would otherwise wait forever, with no error.
    const stop = new AbortController()
    let stalled = false
    const cancel = (): void => stop.abort()
    signal.addEventListener('abort', cancel)
    // A read waiting on the body ends at once when it is cancelled, whatever the connection does.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    stop.signal.addEventListener('abort', () => void reader?.cancel().catch(() => undefined))
    let timer: ReturnType<typeof setTimeout> | undefined
    const watch = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = true
        stop.abort()
      }, STALL_MS)
    }
    const partial = `${path}.part`
    const out = createWriteStream(partial)
    const hash = createHash('sha256')
    let lastEmit = 0
    try {
      watch()
      const response = await net.fetch(`${REPO}/${file.path}`, { signal: stop.signal })
      if (!response.ok || !response.body) {
        throw new Error(`Hugging Face answered ${response.status}`)
      }
      reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        // Ended by cancelling, not by the file being complete.
        if (stop.signal.aborted) throw new Error('stopped')
        watch()
        if (done) break
        hash.update(value)
        if (!out.write(value))
          await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        this.download!.received += value.length
        if (Date.now() - lastEmit > 200) {
          lastEmit = Date.now()
          this.emitStatus()
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error) => (error ? reject(error) : resolve()))
      )
    } catch (error) {
      out.destroy()
      await rm(partial, { force: true })
      throw stalled ? new Error(`nothing arrived for ${STALL_MS / 1000} seconds`) : error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
    if (hash.digest('hex') !== file.sha256) {
      await rm(partial, { force: true })
      throw new Error(`${file.path} did not match its checksum`)
    }
    await rename(partial, path)
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
    if (!this.ready()) {
      throw new Error('The voice is not downloaded. The user can download it in Settings.')
    }
    const id = crypto.randomUUID()
    let begin: (begun: boolean) => void = () => undefined
    let end: () => void = () => undefined
    const started = new Promise<boolean>((resolve) => (begin = resolve))
    const ended = new Promise<void>((resolve) => (end = resolve))
    this.unsaid.set(id, { chatId, begin, end, ended })
    this.messages.set(id, { chatId, text })
    this.send({ type: 'speak', id, text, lang, pace })
    return { started, ended, stop: () => this.stopMessage(id) }
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
    worker.postMessage({ type: 'load', dir: this.dir, voice: VOICE } satisfies ToWorker)
    this.worker = worker
  }

  private onWorker(message: FromWorker): void {
    this.keepAlive()
    if (message.type === 'audio') {
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
  }

  private emitStatus(): void {
    this.events.status(this.status())
  }
}
