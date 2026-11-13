import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The zrok program the remote link runs, downloaded by the app the first time
 * from zrok's releases on GitHub, so nothing has to be installed by hand. Its
 * version is pinned, and the download is checked against the checksums of
 * that release, written here: a file that differs is refused.
 */

const VERSION = '2.0.9'

/** SHA-256 of each archive, from the release's checksums.sha256.txt. */
const ARCHIVES: Partial<Record<string, { name: string; sha256: string }>> = {
  'darwin-arm64': {
    name: `zrok_${VERSION}_darwin_arm64.tar.gz`,
    sha256: '42e989f4c1369f2698d9b8e17ee10302c36229ed3353c45e4dffde726f0113c4'
  },
  'darwin-x64': {
    name: `zrok_${VERSION}_darwin_amd64.tar.gz`,
    sha256: '74bd2eee1524b884015fd7e7114da226d5c6a59930b33abbd074bafdc2f92a18'
  },
  'linux-x64': {
    name: `zrok_${VERSION}_linux_amd64.tar.gz`,
    sha256: 'cce814e1f0036ea9bd6fc58363bd2b52468db903781d44defcf755349fca333f'
  }
}

const dir = join(app.getPath('userData'), 'zrok', VERSION)
const binary = join(dir, 'zrok2')

let downloading: Promise<string> | undefined

/** The zrok program, downloaded first if it is not here yet. */
export function zrokBinary(): Promise<string> {
  if (existsSync(binary)) return Promise.resolve(binary)
  downloading ??= download().finally(() => (downloading = undefined))
  return downloading
}

async function download(): Promise<string> {
  const archive = ARCHIVES[`${process.platform}-${process.arch}`]
  if (!archive) throw new Error('The remote link runs on macOS and on Linux on x64 only.')
  const url = `https://github.com/openziti/zrok/releases/download/v${VERSION}/${archive.name}`
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1000) })
  if (!response.ok) throw new Error(`zrok could not be downloaded (${response.status}).`)
  const data = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(data).digest('hex') !== archive.sha256) {
    throw new Error('The zrok download is not the expected file, so it was not used.')
  }
  const temp = await mkdtemp(join(app.getPath('temp'), 'barebone-zrok-'))
  try {
    await writeFile(join(temp, archive.name), data)
    await new Promise<void>((resolve, reject) =>
      execFile('/usr/bin/tar', ['-xzf', archive.name, 'zrok2'], { cwd: temp }, (error) =>
        error ? reject(new Error(`zrok could not be unpacked: ${error.message}`)) : resolve()
      )
    )
    await chmod(join(temp, 'zrok2'), 0o755)
    await mkdir(dir, { recursive: true })
    await rename(join(temp, 'zrok2'), binary)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  return binary
}
