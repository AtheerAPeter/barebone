import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The remote link's settings and its paired devices (hashes of their session
 * tokens, never the tokens). Kept in its own file, readable only by the user,
 * as telegram.json and exa.json are.
 */

export interface StoredSession {
  id: string
  /** SHA-256 of the cookie's token. */
  hash: string
  device: string
  createdAt: number
  lastSeenAt: number
}

export interface RemoteConfig {
  /** Whether the link is open; it opens again when the app starts. */
  on?: boolean
  /** The zrok name the link uses, so its address stays the same. */
  zrokName?: string
  /** Paired devices may see and use the browser's tabs (remote/browser.ts). */
  browser?: boolean
  sessions: StoredSession[]
}

/** Barebone on a server (deploy/vps): no screen, so the link is how it is used and set up. */
export const HEADLESS = process.env.BAREBONE_HEADLESS === '1'

const path = join(app.getPath('userData'), 'data', 'remote.json')

let config: RemoteConfig | undefined

export function loadConfig(): RemoteConfig {
  if (config) return config
  config = { sessions: [] }
  if (!existsSync(path)) return config
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as Partial<RemoteConfig>
    config = {
      on: saved.on,
      zrokName: saved.zrokName,
      browser: saved.browser === true || undefined,
      sessions: saved.sessions ?? []
    }
  } catch (error) {
    // Unreadable: start over, closed, with no device paired.
    console.error(`${path} could not be read; the remote link starts unset:`, error)
  }
  return config
}

export function saveConfig(): void {
  if (!config) return
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(temp, path)
}
