import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RecordingRequest } from '../shared/types'
import type { ChatPage } from './browser'
import { withTimeout } from './page-driver'

/**
 * Videos agents record of a browser tab (start_recording and stop_recording,
 * browser-mcp.ts). The window records them (lib/recording.ts): it captures the
 * tab by a media source id, which needs no screen recording permission and
 * keeps pages out of sight rendering, adds the chat's voice (lib/speech.ts)
 * as the sound, and sends the MP4 here a second at a time, written as it
 * comes. A chat records one tab at a time.
 *
 * The video leaves out the time the agent spends working out what to do next:
 * while its turn runs, it records only while something is held (`hold`: the
 * voice talking, the page changing), and a moment after. Between turns it
 * records all along, as the user may be the one acting on the page.
 */

/** How long the window has to start recording before start fails. */
const START_TIMEOUT = 10_000
/** How long it keeps recording after what it held: the page settling, a breath after the words. */
const TAIL_MS = 600

/** A recording that has ended, and its file written. */
export interface Recorded {
  path: string
  /** The tab's id, like t2. */
  tab: string
  /** In milliseconds. */
  duration: number
  bytes: number
  /** Why it ended before it was stopped, if it did: the tab closed, the window reloaded. */
  endedBy?: string
}

interface Recording {
  id: string
  chatId: string
  tab: ChatPage
  path: string
  file: WriteStream
  bytes: number
  startedAt: number
  /** When it was asked to stop, or stopped by itself. */
  endedAt?: number
  endedBy?: string
  /** The window was asked to stop it. */
  stopping: boolean
  /** Holds not yet released: while there are any, it records. */
  holds: number
  /** Since when it is paused, while it is. */
  pausedAt?: number
  /** How long it was paused before, which the video leaves out. */
  pausedMs: number
  /** Pauses it once the tail after the last hold is over. */
  pauseTimer?: ReturnType<typeof setTimeout>
  started: { resolve: () => void; reject: (error: Error) => void }
  /** Settles once the file is closed. */
  done: Promise<Recorded>
  /** Close the file; the window sends nothing more. */
  finish: () => void
}

export class PageRecorder {
  /** By id, until their file is closed. */
  private readonly writing = new Map<string, Recording>()
  /** Each chat's latest, by chat id; kept after it ends, until stop collects it. */
  private readonly latest = new Map<string, Recording>()

  constructor(
    /** The window, which records. */
    private readonly window: WebContents,
    /** Whether a chat's agent is working on a turn now. */
    private readonly working: (chatId: string) => boolean
  ) {
    const from = <Args extends unknown[]>(
      channel: string,
      handle: (recording: Recording, ...args: Args) => void
    ): void => {
      ipcMain.on(channel, (event: IpcMainEvent, id: string, ...args: unknown[]) => {
        const recording = this.writing.get(id)
        if (recording && event.sender === this.window) handle(recording, ...(args as Args))
      })
    }
    from('recording:started', (recording) => recording.started.resolve())
    from<[string]>('recording:failed', (recording, message) =>
      recording.started.reject(new Error(message))
    )
    from<[Uint8Array]>('recording:data', (recording, chunk) => {
      recording.bytes += chunk.byteLength
      recording.file.write(chunk)
    })
    from<[string | undefined]>('recording:ended', (recording, error) => {
      if (error) recording.endedBy ??= `the recording failed: ${error}`
      recording.endedAt ??= Date.now()
      recording.finish()
    })
  }

  /** Start recording a chat's tab to an MP4 file; throws why it cannot. */
  async start(chatId: string, tab: ChatPage, path: string): Promise<void> {
    const running = this.latest.get(chatId)
    if (running && !running.endedBy) {
      throw new Error(
        `This chat is recording tab ${running.tab.id} already. Stop it with stop_recording first.`
      )
    }
    if (!path.toLowerCase().endsWith('.mp4')) {
      throw new Error(`The video is an MP4 file: "path" must end in .mp4, not ${path}.`)
    }
    await mkdir(dirname(path), { recursive: true })
    // A new file only: a video already there is never written over, so the
    // file removed when the start fails (below) is always this one.
    const file = createWriteStream(path, { flags: 'wx' })
    await new Promise<void>((resolve, reject) =>
      file.once('open', () => resolve()).once('error', reject)
    ).catch((error: NodeJS.ErrnoException) => {
      throw error.code === 'EEXIST'
        ? new Error(`${path} exists already. Record to a new file.`)
        : error
    })

    // The view lets go of its contents once the tab closes; kept here to stop listening.
    const contents = tab.contents
    const { width, height } = tab.view.getBounds()
    const request: RecordingRequest = {
      id: crypto.randomUUID(),
      chatId,
      sourceId: contents.getMediaSourceId(this.window),
      width,
      height
    }
    let started!: Recording['started']
    const starting = new Promise<void>((resolve, reject) => (started = { resolve, reject }))
    let finish!: () => void
    const finished = new Promise<void>((resolve) => (finish = resolve))
    const closed = (): void => this.end(recording, 'the tab closed')
    const recording: Recording = {
      id: request.id,
      chatId,
      tab,
      path,
      file,
      bytes: 0,
      startedAt: Date.now(),
      stopping: false,
      holds: 0,
      pausedMs: 0,
      started,
      finish,
      done: finished.then(async () => {
        this.writing.delete(request.id)
        clearTimeout(recording.pauseTimer)
        contents.off('destroyed', closed)
        await new Promise<void>((resolve) => file.end(() => resolve()))
        const end = recording.endedAt ?? Date.now()
        const paused = recording.pausedMs + (recording.pausedAt ? end - recording.pausedAt : 0)
        return {
          path,
          tab: tab.id,
          duration: end - recording.startedAt - paused,
          bytes: recording.bytes,
          endedBy: recording.endedBy
        }
      })
    }
    this.writing.set(request.id, recording)
    this.latest.set(chatId, recording)
    contents.once('destroyed', closed)
    try {
      if (this.window.isDestroyed()) throw new Error("Barebone's window is not open.")
      // The browser lets the window capture the tab only meanwhile (browser.ts).
      tab.capturing = true
      this.window.send('recording:start', request)
      await withTimeout(
        starting,
        START_TIMEOUT,
        () => new Error(`The recording did not start within ${START_TIMEOUT / 1000}s.`)
      ).finally(() => (tab.capturing = false))
      recording.startedAt = Date.now()
      this.settle(recording)
    } catch (error) {
      if (this.latest.get(chatId) === recording) this.latest.delete(chatId)
      // The window may start it still; it stops it then.
      this.end(recording)
      recording.finish()
      await recording.done
      await rm(path, { force: true })
      throw error
    }
  }

  /** Stop a chat's recording and close its file; throws when the chat has none. */
  async stop(chatId: string): Promise<Recorded> {
    const recording = this.latest.get(chatId)
    if (!recording) throw new Error('This chat is not recording. Start with start_recording.')
    this.end(recording)
    const recorded = await recording.done
    if (this.latest.get(chatId) === recording) this.latest.delete(chatId)
    return recorded
  }

  /** Whether a chat is recording now. */
  recording(chatId: string): boolean {
    const recording = this.latest.get(chatId)
    return recording !== undefined && this.writing.has(recording.id) && !recording.stopping
  }

  /**
   * Keep a chat's recording going while something happens that belongs in
   * it; returns its release. Does nothing when the chat is not recording.
   */
  hold(chatId: string): () => void {
    const recording = this.latest.get(chatId)
    if (!recording || !this.recording(chatId)) return () => undefined
    recording.holds++
    this.settle(recording)
    let released = false
    return () => {
      if (released) return
      released = true
      recording.holds--
      this.settle(recording)
    }
  }

  /** A chat's turn began or ended: recordings pause or go on as it says. */
  refresh(): void {
    for (const recording of this.writing.values()) this.settle(recording)
  }

  /**
   * Record while something is held or the agent is between turns; else pause
   * once the tail after the last hold is over.
   */
  private settle(recording: Recording): void {
    if (recording.stopping || this.window.isDestroyed()) return
    if (recording.holds > 0 || !this.working(recording.chatId)) {
      clearTimeout(recording.pauseTimer)
      recording.pauseTimer = undefined
      if (recording.pausedAt !== undefined) {
        recording.pausedMs += Date.now() - recording.pausedAt
        recording.pausedAt = undefined
        this.window.send('recording:resume', recording.id)
      }
    } else if (recording.pausedAt === undefined && !recording.pauseTimer) {
      recording.pauseTimer = setTimeout(() => {
        recording.pauseTimer = undefined
        if (recording.stopping || this.window.isDestroyed()) return
        recording.pausedAt = Date.now()
        this.window.send('recording:pause', recording.id)
      }, TAIL_MS)
    }
  }

  /** Stop every recording, for quitting; settles once their files are closed. */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.writing.values()].map((recording) => {
        this.end(recording)
        return recording.done
      })
    )
  }

  /**
   * The window reloaded or crashed: its recordings are gone with it, and what
   * it sent of them is all there is.
   */
  abandon(reason: string): void {
    for (const recording of this.writing.values()) {
      recording.endedBy ??= reason
      recording.endedAt ??= Date.now()
      recording.finish()
    }
  }

  /** Ask the window to stop a recording, saying why when it was not asked to. */
  private end(recording: Recording, reason?: string): void {
    if (recording.stopping) return
    recording.stopping = true
    clearTimeout(recording.pauseTimer)
    recording.endedAt = Date.now()
    recording.endedBy ??= reason
    if (this.window.isDestroyed()) recording.finish()
    else this.window.send('recording:stop', recording.id)
  }
}
