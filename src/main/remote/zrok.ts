import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { pinnedBinary, type PinnedBinary } from './pinned-binary'
import type { TunnelProvider } from './tunnel'

/**
 * zrok (zrok.io, free), the tunnel on a Mac and on a server without a
 * Cloudflare tunnel. The app joins it to the user's account once with their
 * account token. The share is public under a name kept for this Mac, so its
 * address stays the same; it is taken down when zrok stops.
 */

const VERSION = '2.0.9'
const release = `https://github.com/openziti/zrok/releases/download/v${VERSION}`

/** SHA-256 of each archive, from the release's checksums.sha256.txt. */
const ZROK: PinnedBinary = {
  name: 'zrok',
  version: VERSION,
  file: 'zrok2',
  downloads: {
    'darwin-arm64': {
      url: `${release}/zrok_${VERSION}_darwin_arm64.tar.gz`,
      sha256: '42e989f4c1369f2698d9b8e17ee10302c36229ed3353c45e4dffde726f0113c4',
      inArchive: 'zrok2'
    },
    'darwin-x64': {
      url: `${release}/zrok_${VERSION}_darwin_amd64.tar.gz`,
      sha256: '74bd2eee1524b884015fd7e7114da226d5c6a59930b33abbd074bafdc2f92a18',
      inArchive: 'zrok2'
    },
    'linux-x64': {
      url: `${release}/zrok_${VERSION}_linux_amd64.tar.gz`,
      sha256: 'cce814e1f0036ea9bd6fc58363bd2b52468db903781d44defcf755349fca333f',
      inArchive: 'zrok2'
    }
  }
}

/** Where zrok keeps the account an environment was enabled with. */
const ENVIRONMENT = join(homedir(), '.zrok2', 'environment.json')
/** How long zrok may take to answer a command (enable, names). */
const COMMAND_TIMEOUT = 60_000

/** Whether zrok is joined to an account on this Mac. */
export function zrokEnabled(): boolean {
  return existsSync(ENVIRONMENT)
}

function run(zrok: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(zrok, args, { timeout: COMMAND_TIMEOUT }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      // zrok writes its errors as "[ERROR]: …" lines; the last says why.
      const said = `${stderr}\n${stdout}`
        .split('\n')
        .map((line) => stripVTControlCharacters(line).trim())
        .filter(Boolean)
        .pop()
      reject(new Error(said || error.message))
    })
  )
}

/** Join zrok to the user's account with the account token from myzrok.io. */
export async function enableZrok(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!/^[\w-]{6,}$/.test(trimmed)) throw new Error('That does not look like a zrok account token.')
  const zrok = await pinnedBinary(ZROK)
  await run(zrok, [
    'enable',
    trimmed,
    '--headless',
    '--description',
    `Barebone on ${hostname().replace(/\.local$/, '')}`
  ])
}

/** A new name for this Mac's share: random, so the address says nothing about who is behind it. */
export function newShareName(): string {
  return `bb${randomBytes(6).toString('hex')}`
}

interface ZrokName {
  name: string
  namespaceName: string
  /** The share holding the name, while one does. */
  shareToken?: string
}

async function names(zrok: string): Promise<ZrokName[]> {
  return JSON.parse(await run(zrok, ['list', 'names', '--json'])) as ZrokName[]
}

/**
 * Make sure the name is the account's and free, creating it the first time;
 * its public address, as https://<name>.<namespace> (zrok's names list gives
 * both). The name is this Mac's alone, so a share holding it as the link opens
 * was left by a run of the app that ended without taking it down (a crash, a
 * power cut): it is deleted, or the new share could not take the name.
 */
async function ensureName(zrok: string, name: string): Promise<string> {
  let found = (await names(zrok)).find((n) => n.name === name)
  if (!found) {
    await run(zrok, ['create', 'name', name])
    found = (await names(zrok)).find((n) => n.name === name)
  }
  if (!found) throw new Error(`zrok did not keep the name ${name}.`)
  if (found.shareToken) await run(zrok, ['delete', 'share', found.shareToken])
  return `https://${found.name}.${found.namespaceName}`
}

/** zrok sharing the local server under the name, which keeps its address. */
export function zrokProvider(name: string): TunnelProvider {
  return {
    name: 'zrok',
    async program() {
      if (!zrokEnabled()) throw new Error('zrok is not joined to your account yet.')
      return pinnedBinary(ZROK)
    },
    address: (zrok) => ensureName(zrok, name),
    command: (port) => ({
      args: [
        'share',
        'public',
        `http://127.0.0.1:${port}`,
        '--name-selection',
        `public:${name}`,
        '--headless',
        // A zrok agent running on this Mac would otherwise take the share over.
        '--force-local'
      ]
    })
  }
}
