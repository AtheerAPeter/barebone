import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { loadConfig, saveConfig, type StoredSession } from './config'

/**
 * Who may use the remote link: devices paired with a one-time code, shown on
 * the Mac as a QR code, then kept by a session cookie. A code is 32 random
 * bytes, works once and only for a few minutes, so only someone looking at
 * the Mac's screen now can pair.
 */

/** How long a pairing code works. */
export const PAIRING_MS = 5 * 60 * 1000
/** A session nobody used for this long ends. */
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000
/** How often a session's last use is saved, at most. */
const TOUCH_EVERY_MS = 60 * 1000

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

function same(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** The code waiting to be used, by its hash; one at a time, and not saved. */
let pairing: { hash: string; expiresAt: number } | undefined

/** A new pairing code; the one before stops working. */
export function newPairingCode(): { code: string; expiresAt: number } {
  const code = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + PAIRING_MS
  pairing = { hash: hash(code), expiresAt }
  return { code, expiresAt }
}

/** "iPhone · Safari", from a User-Agent. */
export function deviceName(userAgent = ''): string {
  const system = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : 'Unknown device'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(userAgent)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : undefined
  return browser ? `${system} · ${browser}` : system
}

/**
 * Pair a device with a code: its session cookie's token, or undefined for a
 * code that is wrong, used or expired. The code is spent either way it is right.
 */
export function pair(
  code: string,
  userAgent: string | undefined
): { token: string; session: StoredSession } | undefined {
  const now = Date.now()
  if (!pairing || pairing.expiresAt < now || !same(hash(code), pairing.hash)) return undefined
  pairing = undefined
  const token = randomBytes(32).toString('base64url')
  const session: StoredSession = {
    id: randomBytes(8).toString('hex'),
    hash: hash(token),
    device: deviceName(userAgent),
    createdAt: now,
    lastSeenAt: now
  }
  const config = loadConfig()
  config.sessions = [session, ...config.sessions]
  saveConfig()
  return { token, session }
}

/** The session a cookie's token belongs to, if it is still good; its use is noted. */
export function sessionFor(token: string | undefined): StoredSession | undefined {
  if (!token) return undefined
  const config = loadConfig()
  const tokenHash = hash(token)
  const session = config.sessions.find((s) => same(s.hash, tokenHash))
  if (!session) return undefined
  const now = Date.now()
  if (now - session.lastSeenAt > SESSION_IDLE_MS) {
    config.sessions = config.sessions.filter((s) => s !== session)
    saveConfig()
    return undefined
  }
  if (now - session.lastSeenAt > TOUCH_EVERY_MS) {
    session.lastSeenAt = now
    saveConfig()
  }
  return session
}

export function endSession(id: string): void {
  const config = loadConfig()
  config.sessions = config.sessions.filter((s) => s.id !== id)
  saveConfig()
}
