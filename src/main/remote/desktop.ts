import {
  request,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse
} from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * The server's desktop through the remote link, at /desktop/: on a Linux server
 * (deploy/vps), linuxserver's Selkies desktop, served there under that path.
 * Only paired devices reach it (server.ts checks first), and none needs the
 * desktop's own password: the link signs in for them.
 *
 * BAREBONE_DESKTOP is the desktop's address (http://127.0.0.1:3000) and
 * BAREBONE_DESKTOP_AUTH its sign-in (user:password). Unset, as on the Mac,
 * there is no desktop.
 */

export const DESKTOP_PATH = '/desktop/'

const address = process.env.BAREBONE_DESKTOP ? new URL(process.env.BAREBONE_DESKTOP) : undefined
const auth = process.env.BAREBONE_DESKTOP_AUTH
  ? `Basic ${Buffer.from(process.env.BAREBONE_DESKTOP_AUTH).toString('base64')}`
  : undefined

export const desktopAvailable = (): boolean => address !== undefined

export const isDesktopPath = (path: string): boolean =>
  path === DESKTOP_PATH.slice(0, -1) || path.startsWith(DESKTOP_PATH)

/** The request's headers for the desktop: its sign-in instead of the link's cookie. */
function headers(req: IncomingMessage): OutgoingHttpHeaders {
  const sent: OutgoingHttpHeaders = { ...req.headers, host: address!.host }
  delete sent.cookie
  delete sent.authorization
  if (auth) sent.authorization = auth
  return sent
}

function upstream(req: IncomingMessage): ReturnType<typeof request> {
  return request({
    hostname: address!.hostname,
    port: address!.port || 80,
    method: req.method,
    path: req.url,
    headers: headers(req)
  })
}

/**
 * What of the desktop may run as the link: its app's page and the app's own
 * scripts (the page starts web workers from them), matched exactly on the
 * address as sent. Everything else, such as the server's files that Selkies
 * serves (api/files, api/print), is sandboxed: shown without scripts, in an
 * origin of its own. An address written another way (a doubled slash, an
 * encoded character) is not on this list, so it is sandboxed too.
 */
const APP = /^\/desktop\/(?:index\.html)?$|^\/desktop\/(?:assets\/)?[\w.-]+\.m?js$/

/** The desktop's headers, made safe to serve from the link's origin. */
function answerHeaders(req: IncomingMessage, answer: IncomingMessage): OutgoingHttpHeaders {
  const sent: OutgoingHttpHeaders = { ...answer.headers }
  // Never in a frame: zrok's shares are one site, so another share's page could otherwise
  // frame the desktop with this link's cookie (clickjacking).
  const policies = [answer.headers['content-security-policy'] ?? []].flat()
  policies.push("frame-ancestors 'none'")
  const path = (req.url ?? '/').split('?')[0]
  if (!APP.test(path)) policies.push('sandbox')
  // Several policies in one header, each enforced on its own.
  sent['content-security-policy'] = policies.join(', ')
  sent['x-frame-options'] = 'DENY'
  sent['x-content-type-options'] = 'nosniff'
  sent['cross-origin-opener-policy'] = 'same-origin'
  return sent
}

/** A page or file of the desktop. */
export function proxyDesktop(req: IncomingMessage, res: ServerResponse): void {
  // Only from the link's own pages, or opened directly: not from another site,
  // such as another zrok share, which the browser counts as the same site.
  const site = req.headers['sec-fetch-site']
  if (site === 'same-site' || site === 'cross-site') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not from this link.')
    return
  }
  const forward = upstream(req)
  forward.on('response', (answer) => {
    res.writeHead(answer.statusCode ?? 502, answerHeaders(req, answer))
    answer.pipe(res)
  })
  forward.on('error', () => {
    if (res.headersSent) return void res.destroy()
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('The desktop is not running.')
  })
  req.pipe(forward)
}

/** The desktop's WebSocket (its picture, sound and input): the two sockets joined. */
export function proxyDesktopUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const forward = upstream(req)
  forward.on('upgrade', (answer, desktop, desktopHead) => {
    const lines = [`HTTP/1.1 101 ${answer.statusMessage ?? 'Switching Protocols'}`]
    for (let i = 0; i < answer.rawHeaders.length; i += 2) {
      lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (desktopHead.length) socket.write(desktopHead)
    if (head.length) desktop.write(head)
    desktop.on('error', () => socket.destroy())
    socket.on('error', () => desktop.destroy())
    desktop.pipe(socket).pipe(desktop)
  })
  // The desktop answered without switching (signed out, not found): pass that on.
  forward.on('response', (answer) => {
    socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n\r\n`)
  })
  forward.on('error', () => socket.destroy())
  forward.end()
}
