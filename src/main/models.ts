import { net } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Model files the app downloads to run on this Mac: the voices (speech/) and
 * the meeting's speech-to-text (meeting.ts). Each comes from a pinned address
 * and is checked against its SHA-256 before it is used.
 */

export interface ModelFile {
  url: string
  /** Where it goes, under the model's folder. */
  path: string
  size: number
  sha256: string
}

/** A file that receives nothing this long has stalled: it is stopped and tried again. */
const STALL_MS = 30_000
/** Tries of each file before the download fails. */
const ATTEMPTS = 3

/** Every file is there at its size; they were checked against their SHA-256 when downloaded. */
export function haveFiles(dir: string, files: ModelFile[]): boolean {
  return files.every((file) => {
    const path = join(dir, file.path)
    return existsSync(path) && statSync(path).size === file.size
  })
}

export const totalSize = (files: ModelFile[]): number =>
  files.reduce((sum, file) => sum + file.size, 0)

/**
 * Download the files `dir` does not have yet. `progress` is told the bytes
 * there so far, files already there included. Rejects with why it failed;
 * when `signal` aborts, with 'stopped'.
 */
export async function downloadFiles(
  dir: string,
  files: ModelFile[],
  signal: AbortSignal,
  progress: (received: number) => void
): Promise<void> {
  let received = 0
  for (const file of files) {
    const path = join(dir, file.path)
    if (existsSync(path) && statSync(path).size === file.size) {
      received += file.size
      progress(received)
      continue
    }
    for (let attempt = 1; ; attempt++) {
      const before = received
      try {
        await fetchFile(file, path, signal, (bytes) => progress((received += bytes)))
        break
      } catch (error) {
        if (signal.aborted || attempt === ATTEMPTS) throw error
        console.error(`[models] ${file.path}, try ${attempt}:`, (error as Error).message)
        received = before
        progress(received)
        await sleep(attempt * 2000)
      }
    }
  }
}

async function fetchFile(
  file: ModelFile,
  path: string,
  signal: AbortSignal,
  bytes: (count: number) => void
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Stopped when the caller cancels, and when nothing arrives for STALL_MS:
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
  try {
    watch()
    const response = await net.fetch(file.url, { signal: stop.signal })
    if (!response.ok || !response.body) {
      throw new Error(`${new URL(file.url).host} answered ${response.status}`)
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
      bytes(value.length)
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
