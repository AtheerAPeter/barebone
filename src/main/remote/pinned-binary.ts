import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A program a tunnel runs (zrok, cloudflared), downloaded by the app the first
 * time from its maker's releases on GitHub, so nothing has to be installed by
 * hand. Its version is pinned, and the download is checked against the SHA-256
 * written in its spec: a file that differs is refused.
 */
export interface PinnedBinary {
  /** The program's name, in messages and as its folder: "zrok". */
  name: string
  version: string
  /** The program's file once downloaded. */
  file: string
  /** By `${process.platform}-${process.arch}`. */
  downloads: Partial<Record<string, PinnedDownload>>
}

interface PinnedDownload {
  url: string
  /** SHA-256 of the file at url. */
  sha256: string
  /** A .tar.gz holding the program under this name; the program itself when left out. */
  inArchive?: string
}

const downloading = new Map<string, Promise<string>>()

/** The program, downloaded first if it is not here yet. */
export function pinnedBinary(spec: PinnedBinary): Promise<string> {
  const dir = join(app.getPath('userData'), spec.name, spec.version)
  const binary = join(dir, spec.file)
  if (existsSync(binary)) return Promise.resolve(binary)
  let pending = downloading.get(binary)
  if (!pending) {
    pending = download(spec, dir, binary).finally(() => downloading.delete(binary))
    downloading.set(binary, pending)
  }
  return pending
}

async function download(spec: PinnedBinary, dir: string, binary: string): Promise<string> {
  const source = spec.downloads[`${process.platform}-${process.arch}`]
  if (!source) throw new Error(`${spec.name} does not run on this system.`)
  const response = await fetch(source.url, { signal: AbortSignal.timeout(5 * 60 * 1000) })
  if (!response.ok) throw new Error(`${spec.name} could not be downloaded (${response.status}).`)
  const data = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(data).digest('hex') !== source.sha256) {
    throw new Error(`The ${spec.name} download is not the expected file, so it was not used.`)
  }
  // Unpacked beside where it goes, so it can be moved there: a move from the
  // system's temp folder fails when that is another filesystem (as /tmp is in a
  // container whose data is on a volume).
  await mkdir(dir, { recursive: true })
  const temp = await mkdtemp(join(dir, '.unpacking-'))
  try {
    const unpacked = join(temp, source.inArchive ?? spec.file)
    if (source.inArchive) {
      const archive = 'download.tar.gz'
      await writeFile(join(temp, archive), data)
      await new Promise<void>((resolve, reject) =>
        execFile('/usr/bin/tar', ['-xzf', archive, source.inArchive!], { cwd: temp }, (error) =>
          error
            ? reject(new Error(`${spec.name} could not be unpacked: ${error.message}`))
            : resolve()
        )
      )
    } else {
      await writeFile(unpacked, data)
    }
    await chmod(unpacked, 0o755)
    await rename(unpacked, binary)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  return binary
}
