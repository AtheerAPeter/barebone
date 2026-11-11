import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { DownloadStatus } from '../shared/types'

/**
 * What the app downloads onto this Mac when the user asks for it: voice
 * models, the engine some of them run on, the music model and ffmpeg. Each is
 * pinned: a file comes from one URL at one revision and is checked against
 * its SHA-256 before it is used. An archive is unpacked once checked, and
 * counts as there while what it unpacked to is.
 */

/** A file that receives nothing this long has stalled: it is stopped and tried again. */
const STALL_MS = 30_000
/** Tries of each file before the download fails. */
const ATTEMPTS = 3

export interface PackageFile {
  url: string
  /** Where it goes, in the package's folder. */
  path: string
  size: number
  sha256: string
  /**
   * An archive: unpacked into the package's folder once checked, then deleted.
   * `unpacked` names a file it holds, which tells that it is there.
   */
  archive?: { kind: 'tar' | 'zip'; unpacked: string }
}

const run = promisify(execFile)

export class Package {
  /** Where its files are. */
  readonly dir: string
  readonly total: number
  private download?: { received: number; abort: AbortController }
  /** The download going on, which every caller of fetch waits for. */
  private fetching?: Promise<void>
  private failure?: string

  constructor(
    /** Its folder, in the app's data. */
    folder: string,
    private readonly files: PackageFile[],
    /** What it is, as a failure names it: "The voice", "ffmpeg". */
    private readonly label: string,
    /** Told whenever its status changes. */
    private readonly changed: () => void,
    /** Packages it needs, downloaded with it: the engine a model runs on. */
    readonly needs: Package[] = []
  ) {
    this.dir = join(app.getPath('userData'), folder)
    this.total = files.reduce((sum, file) => sum + file.size, 0)
  }

  /** Its own files and what it needs are on this Mac. */
  ready(): boolean {
    return this.own() && this.needs.every((need) => need.ready())
  }

  /** Its own files are there, whatever it needs. */
  own(): boolean {
    return this.files.every((file) => this.has(file))
  }

  private has(file: PackageFile): boolean {
    const path = join(this.dir, file.archive ? file.archive.unpacked : file.path)
    return existsSync(path) && (file.archive !== undefined || statSync(path).size === file.size)
  }

  status(): DownloadStatus {
    // What it needs is downloaded with it, so it counts in its size until it is there.
    const total = this.total + this.needs.reduce((sum, n) => sum + (n.own() ? 0 : n.total), 0)
    const busy = [this, ...this.needs].filter((p) => p.download)
    if (busy.length) {
      const received = busy.reduce((sum, p) => sum + p.download!.received, 0)
      return { state: 'downloading', received, total }
    }
    const failure = this.failure ?? this.needs.find((n) => n.failure)?.failure
    if (failure) return { state: 'failed', message: failure, total }
    return { state: this.ready() ? 'ready' : 'missing', total }
  }

  /** Download what is missing of it and what it needs; resolves when done, failed or cancelled. */
  fetch(): Promise<void> {
    this.fetching ??= this.fetchAll().finally(() => (this.fetching = undefined))
    return this.fetching
  }

  private async fetchAll(): Promise<void> {
    for (const need of this.needs) {
      // Shared with another package downloading it now.
      await need.fetch()
      if (!need.own()) return
    }
    if (this.own()) return
    const abort = new AbortController()
    this.download = { received: 0, abort }
    this.failure = undefined
    // Whatever goes wrong, it ends here: a download is never left looking as if it ran.
    try {
      this.changed()
      for (const file of this.files) {
        if (this.has(file)) {
          this.download.received += file.size
          continue
        }
        for (let attempt = 1; ; attempt++) {
          const before = this.download.received
          try {
            await this.fetchFile(file, abort.signal)
            break
          } catch (error) {
            if (abort.signal.aborted || attempt === ATTEMPTS) throw error
            console.error(`[downloads] ${file.path}, try ${attempt}:`, (error as Error).message)
            this.download.received = before
            this.changed()
            await sleep(attempt * 2000)
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.failure = `${this.label} could not be downloaded: ${(error as Error).message}`
      }
    } finally {
      this.download = undefined
      this.changed()
    }
  }

  private async fetchFile(file: PackageFile, signal: AbortSignal): Promise<void> {
    const path = join(this.dir, file.path)
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
    // A file that cannot be written (the disk is full) stops the download.
    let writeError: Error | undefined
    out.on('error', (error) => {
      writeError = error
      stop.abort()
    })
    const hash = createHash('sha256')
    let lastEmit = 0
    try {
      watch()
      const response = await net.fetch(file.url, { signal: stop.signal })
      if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`)
      reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        // Ended by cancelling, not by the file being complete.
        if (stop.signal.aborted) throw new Error('stopped')
        watch()
        if (done) break
        hash.update(value)
        if (!out.write(value)) await once(out, 'drain', { signal: stop.signal })
        this.download!.received += value.length
        if (Date.now() - lastEmit > 200) {
          lastEmit = Date.now()
          this.changed()
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error) => (error ? reject(error) : resolve()))
      )
    } catch (error) {
      out.destroy()
      await rm(partial, { force: true })
      throw (
        writeError ??
        (stalled ? new Error(`nothing arrived for ${STALL_MS / 1000} seconds`) : error)
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
    if (hash.digest('hex') !== file.sha256) {
      await rm(partial, { force: true })
      throw new Error(`${file.path} did not match its checksum`)
    }
    if (!file.archive) {
      await rename(partial, path)
      return
    }
    // The system's own tools unpack it into a folder of its own, then it moves
    // into place, the file that tells it is there last: one cut off halfway is
    // never taken for whole.
    const unpacking = await mkdtemp(join(this.dir, '.unpacking-'))
    try {
      if (file.archive.kind === 'tar') await run('/usr/bin/tar', ['-xzf', partial, '-C', unpacking])
      else await run('/usr/bin/ditto', ['-x', '-k', partial, unpacking])
      const entries = await readdir(unpacking)
      if (!entries.includes(file.archive.unpacked)) {
        throw new Error(`${file.path} did not hold ${file.archive.unpacked}`)
      }
      const marker = file.archive.unpacked
      for (const entry of [...entries.filter((e) => e !== marker), marker]) {
        await rm(join(this.dir, entry), { recursive: true, force: true })
        await rename(join(unpacking, entry), join(this.dir, entry))
      }
    } finally {
      await rm(partial, { force: true })
      await rm(unpacking, { recursive: true, force: true })
    }
  }

  cancel(): void {
    this.download?.abort.abort()
    for (const need of this.needs) need.cancel()
  }

  /** Delete its files, to free their space; what it needs stays, as others may need it too. */
  async remove(): Promise<void> {
    this.download?.abort.abort()
    await rm(this.dir, { recursive: true, force: true })
    this.failure = undefined
    this.changed()
  }
}
