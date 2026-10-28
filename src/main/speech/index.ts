import { app, net, utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SpeechStatus, SpokenAudio } from '../../shared/types'
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

/** The engine's process ends after this long without speaking. */
const IDLE_MS = 5 * 60_000

export class Speech {
  private readonly dir = join(app.getPath('userData'), 'speech', 'supertonic-3')
  private download?: { received: number; abort: AbortController }
  private failure?: string
  private worker?: UtilityProcess
  private idleTimer?: ReturnType<typeof setTimeout>
  /** Messages being made or played, with the chat that spoke them. */
  private readonly messages = new Map<string, { chatId?: string; text: string }>()

  constructor(
    private readonly events: {
      status(status: SpeechStatus): void
      audio(audio: SpokenAudio): void
      /** Stop playing what a chat said; every chat's when undefined. */
      stop(chatId: string | undefined): void
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
        await this.fetchFile(file, path, abort.signal)
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
    const response = await net.fetch(`${REPO}/${file.path}`, { signal })
    if (!response.ok || !response.body) throw new Error(`Hugging Face answered ${response.status}`)
    const partial = `${path}.part`
    const out = createWriteStream(partial)
    const hash = createHash('sha256')
    const reader = response.body.getReader()
    let lastEmit = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
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
      throw error
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
   * Say a message out loud; resolves once it is on its way, not when it has
   * been said. Rejects with why it cannot be said.
   */
  speak(chatId: string | undefined, text: string, lang: Language): void {
    if (!text.trim()) throw new Error('There is nothing to say: the text is empty.')
    if (!this.ready()) {
      throw new Error('The voice is not downloaded. The user can download it in Settings.')
    }
    const id = crypto.randomUUID()
    this.messages.set(id, { chatId, text })
    this.send({ type: 'speak', id, text, lang })
  }

  /** Stop what a chat is saying, and what it was going to say; every chat's when undefined. */
  stop(chatId?: string): void {
    for (const [id, message] of this.messages) {
      if (chatId !== undefined && message.chatId !== chatId) continue
      this.messages.delete(id)
      this.worker?.postMessage({ type: 'cancel', id } satisfies ToWorker)
    }
    this.events.stop(chatId)
  }

  /** Quit: the engine's process ends with the app. */
  dispose(): void {
    this.cancelDownload()
    this.stopWorker()
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
      // Messages it was making will not come.
      this.messages.clear()
    })
    worker.postMessage({ type: 'load', dir: this.dir, voice: VOICE } satisfies ToWorker)
    this.worker = worker
  }

  private onWorker(message: FromWorker): void {
    this.keepAlive()
    if (message.type === 'audio') {
      const spoken = this.messages.get(message.id)
      if (!spoken) return
      if (message.last) this.messages.delete(message.id)
      this.events.audio({
        id: message.id,
        ...(spoken.chatId ? { chatId: spoken.chatId } : {}),
        text: spoken.text,
        samples: message.samples,
        sampleRate: message.sampleRate,
        last: message.last
      })
    } else if (message.type === 'failed') {
      this.messages.delete(message.id)
      console.error('[speech] could not speak:', message.message)
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
    this.messages.clear()
  }

  private emitStatus(): void {
    this.events.status(this.status())
  }
}
