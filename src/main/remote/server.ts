import { app } from 'electron'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { basename, extname, join, normalize, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AppState, SpokenAudio } from '../../shared/types'
import { REMOTE_BOTS, REMOTE_IMAGES } from '../../shared/types'
import {
  decode,
  diffState,
  encode,
  sentState,
  type ClientMessage,
  type SentState,
  type ServerMessage
} from '../../shared/wire'
import { imageType, requestedImage } from '../images'
import {
  botFile,
  botFileType,
  DASHBOARD_POLICY,
  HELPER,
  HELPER_SCRIPT,
  keyedBot,
  MAX_RECORD_BYTES,
  saveRecord,
  STYLESHEET,
  stylesheet
} from '../bots'
import { endSession, pair, sessionFor } from './auth'
import { loadConfig } from './config'
import { callFromRemote, callerGone, sendFromRemote, type Caller } from './registry'

/**
 * The remote link's web server, on this Mac only (127.0.0.1): zrok carries
 * the browser's requests to it. It serves the pairing page to anyone, and to
 * a signed-in browser the app's own UI (renderer/web.html), the chats' images,
 * uploads of attachments, and the socket that carries the window's API.
 */

const COOKIE = '__Host-barebone'
/** The longest a browser keeps a cookie (400 days in Chrome and Safari). */
const COOKIE_DAYS = 400
/** Attachments larger than this are refused. */
const MAX_UPLOAD = 50 * 1024 * 1024
/** A socket that has not answered a ping in this long is gone. */
const PING_MS = 30_000
/** State changes come in bursts (one per model step): sent at most this often. */
const STATE_EVERY_MS = 150
/** Chats a page gets live items for: the ones it opened last. */
const WATCHED_CHATS = 4

/** Events the page shows, sent to every page. chat:item and speech:audio go to the chat's watchers. */
const BROADCAST = new Set([
  'chat:options',
  'chat:commands',
  'git:changed',
  'walk:start',
  'walk:at',
  'speech:stop',
  'downloads:status',
  'telegram:status',
  'remoteBrowser:allowed',
  'bots:changed'
])

/** What a bot's dashboard asks its folder with: its files, a record to save, and the browser's question before that. */
const BOT_METHODS = ['GET', 'PUT', 'OPTIONS']

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.wasm': 'application/wasm'
}
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json', '.wasm'])

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin'
}

export interface RemoteServerHost {
  state(): AppState
  /** A session's sockets close when it signs out (Settings). */
  sessionsChanged(): void
}

interface Page {
  socket: WebSocket
  caller: Caller
  sessionId: string
  sent: SentState
  /** Chats it has open, newest last: it gets their items and voice. */
  watched: string[]
  stateTimer?: NodeJS.Timeout
  alive: boolean
}

export class RemoteServer {
  private http?: Server
  private sockets?: WebSocketServer
  private pages = new Set<Page>()
  private nextPage = 1
  private ping?: NodeJS.Timeout
  /** The public address, once zrok gives it: a socket must come from its page. */
  publicOrigin?: string
  port = 0
  /** Compressed files, by path: the built app does not change while it runs. */
  private gzipped = new Map<string, Buffer>()
  /** The files the pairing page loads, which anyone may fetch. */
  private pairAssets = new Set<string>()

  constructor(private host: RemoteServerHost) {}

  private get root(): string {
    return join(import.meta.dirname, '../renderer')
  }

  async start(): Promise<number> {
    await this.findPairAssets()
    this.http = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        console.error('Remote link request failed:', error)
        if (!res.headersSent) this.text(res, 500, 'Something went wrong.')
        else res.destroy()
      })
    })
    this.sockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_UPLOAD,
      // Chat items are sent whole as they grow; compressed, a repeat costs little.
      perMessageDeflate: { threshold: 512 }
    })
    this.http.on('upgrade', (req, socket, head) => {
      const session = this.session(req)
      if (
        new URL(req.url ?? '/', 'http://x').pathname !== '/ws' ||
        !session ||
        !this.originOk(req)
      ) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      this.sockets!.handleUpgrade(req, socket, head, (ws) => this.connect(ws, session.id))
    })
    this.ping = setInterval(() => {
      for (const page of this.pages) {
        if (!page.alive) {
          page.socket.terminate()
          continue
        }
        page.alive = false
        page.socket.ping()
      }
    }, PING_MS)
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject)
      this.http!.listen(0, '127.0.0.1', () => resolve())
    })
    this.port = (this.http.address() as AddressInfo).port
    return this.port
  }

  async stop(): Promise<void> {
    clearInterval(this.ping)
    const http = this.http
    this.http = undefined
    const closed = new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
    http?.closeAllConnections()
    for (const page of this.pages) page.socket.close(1001, 'The remote link closed.')
    // A page that does not answer the close in time is cut off.
    const cutOff = setTimeout(() => {
      for (const page of this.pages) page.socket.terminate()
    }, 1000)
    this.sockets?.close()
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))])
    clearTimeout(cutOff)
    for (const page of this.pages) page.socket.terminate()
    this.pages.clear()
  }

  /** Close the sockets of sessions that ended. */
  dropEndedSessions(): void {
    for (const page of this.pages) {
      if (!this.sessionStillOn(page.sessionId)) page.socket.close(4401, 'Signed out.')
    }
  }

  // ── Events from the app ────────────────────────────────────────────────

  /** Something the window is told; pages that show it are told too. */
  event(channel: string, args: unknown[]): void {
    if (channel === 'state:changed') return this.stateChanged()
    if (channel === 'chat:item') return this.toWatchers(args[0] as string, channel, args)
    if (channel === 'speech:audio') {
      const audio = args[0] as SpokenAudio
      // The sample played from Settings stays on the Mac.
      if (audio.chatId) this.toWatchers(audio.chatId, channel, args)
      return
    }
    if (!BROADCAST.has(channel)) return
    for (const page of this.pages) this.post(page, { t: 'ev', ch: channel, args })
  }

  /** Tell one page something; false when it is gone. */
  sendTo(caller: Caller, channel: string, args: unknown[]): boolean {
    const page = this.pageOf(caller)
    if (page) this.post(page, { t: 'ev', ch: channel, args })
    return page !== undefined
  }

  /** Send one page a binary message (wire.ts encodeFrame); false when it is gone. */
  sendBinary(caller: Caller, data: Uint8Array): boolean {
    const page = this.pageOf(caller)
    if (!page || page.socket.readyState !== page.socket.OPEN) return false
    // Compressing a JPEG again gains nothing.
    page.socket.send(data, { binary: true, compress: false })
    return true
  }

  /** The device a page is open on, as Settings lists it: "iPhone · Safari". */
  deviceOf(caller: Caller): string | undefined {
    const page = this.pageOf(caller)
    return page && loadConfig().sessions.find((s) => s.id === page.sessionId)?.device
  }

  /** The paired session a page is open in. */
  sessionOf(caller: Caller): string | undefined {
    return this.pageOf(caller)?.sessionId
  }

  private pageOf(caller: Caller): Page | undefined {
    for (const page of this.pages) if (page.caller === caller) return page
    return undefined
  }

  private toWatchers(chatId: string, channel: string, args: unknown[]): void {
    for (const page of this.pages) {
      if (page.watched.includes(chatId)) this.post(page, { t: 'ev', ch: channel, args })
    }
  }

  private stateChanged(): void {
    for (const page of this.pages) {
      page.stateTimer ??= setTimeout(() => {
        page.stateTimer = undefined
        this.sendState(page)
      }, STATE_EVERY_MS)
    }
  }

  private sendState(page: Page): void {
    const patch = diffState(this.host.state(), page.sent)
    if (patch) this.post(page, { t: 'state', patch })
  }

  private post(page: Page, message: ServerMessage): void {
    if (page.socket.readyState === page.socket.OPEN) page.socket.send(encode(message))
  }

  // ── Sockets ────────────────────────────────────────────────────────────

  private connect(socket: WebSocket, sessionId: string): void {
    const page: Page = {
      socket,
      caller: `remote:${this.nextPage++}`,
      sessionId,
      sent: sentState(),
      watched: [],
      alive: true
    }
    this.pages.add(page)
    socket.on('pong', () => (page.alive = true))
    socket.on('message', (data) => {
      page.alive = true
      let message: ClientMessage
      try {
        message = decode<ClientMessage>(data.toString())
      } catch {
        return
      }
      void this.receive(page, message)
    })
    socket.on('close', () => {
      clearTimeout(page.stateTimer)
      this.pages.delete(page)
      callerGone(page.caller)
    })
    // Everything first, then only what changes.
    this.sendState(page)
  }

  private async receive(page: Page, message: ClientMessage): Promise<void> {
    // A session signed out in Settings is refused at once, before its socket closes.
    if (!this.sessionStillOn(page.sessionId)) return void page.socket.close(4401, 'Signed out.')
    if (message.t === 'send') {
      if (typeof message.ch === 'string' && Array.isArray(message.args)) {
        sendFromRemote(page.caller, message.ch, message.args)
      }
      return
    }
    if (message.t !== 'call' || typeof message.ch !== 'string' || !Array.isArray(message.args)) {
      return
    }
    // Opening a chat loads its messages: from then on, its items come live.
    if (message.ch === 'chat:messages' && typeof message.args[0] === 'string') {
      const chatId = message.args[0]
      page.watched = [...page.watched.filter((id) => id !== chatId), chatId].slice(-WATCHED_CHATS)
    }
    try {
      const value = await callFromRemote(page.caller, message.ch, message.args)
      this.post(page, { t: 'ret', id: message.id, value })
    } catch (error) {
      this.post(page, {
        t: 'ret',
        id: message.id,
        error: (error as Error).message ?? String(error)
      })
    }
  }

  // ── Requests ───────────────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = decodeURIComponent(url.pathname)
    const method = req.method ?? 'GET'
    // A bot's dashboard runs sandboxed, in an origin of its own, so it has no cookie:
    // its key, which only a paired page is given, lets it in (bots.ts). What it saves
    // comes from that origin of its own, and no cookie goes with it, so the check below
    // of where a change comes from is not for it.
    if (path.startsWith(`${REMOTE_BOTS}/`) && BOT_METHODS.includes(method)) {
      const [key = '', ...parts] = path.slice(REMOTE_BOTS.length + 1).split('/')
      const keyed = keyedBot(key)
      // A key stops working once the device it was given to is signed out.
      const projectId = keyed && this.sessionStillOn(keyed.sessionId) ? keyed.projectId : undefined
      const file = parts.join('/')
      // The page saves a record across origins, so the browser asks first whether it may.
      if (method === 'OPTIONS') return this.botAnswer(res, 204, '')
      if (method === 'PUT') {
        if (!projectId) return this.botAnswer(res, 404, 'Not found.')
        const tooLarge = Number(req.headers['content-length'] ?? 0) > MAX_RECORD_BYTES
        const body = tooLarge
          ? undefined
          : await this.body(req, MAX_RECORD_BYTES).catch(() => undefined)
        if (!body) return this.botAnswer(res, 413, 'Too large to save.')
        const { status, message } = await saveRecord(projectId, file, body)
        return this.botAnswer(res, status, message)
      }
      const css = projectId && file === STYLESHEET ? stylesheet(projectId) : undefined
      if (css) return this.botFile(res, { text: css, type: TYPES['.css'] })
      if (projectId && file === HELPER) {
        return this.botFile(res, { text: HELPER_SCRIPT, type: TYPES['.js'] })
      }
      const found = projectId && (await botFile(projectId, file))
      // Readable across origins, so a page asking for a record not made yet gets this answer.
      if (!found) return this.botAnswer(res, 404, 'Not found.')
      return this.botFile(res, { path: found })
    }

    // zrok shares share one domain that is no public suffix, so another user's share is the
    // same site as this one and SameSite cookies go with its requests: a change must come
    // from this link's own page.
    if (method !== 'GET' && method !== 'HEAD' && !this.originOk(req)) {
      return this.text(res, 403, 'Not from this link.')
    }

    if (path === '/pair') {
      if (this.session(req)) return this.redirect(res, '/')
      return this.file(req, res, 'pair.html', 'no-store')
    }
    if (path === '/api/pair' && method === 'POST') return this.pair(req, res)
    if (path === '/api/logout' && method === 'POST') {
      const session = this.session(req)
      if (session) {
        endSession(session.id)
        this.dropEndedSessions()
        this.host.sessionsChanged()
      }
      res.setHeader(
        'Set-Cookie',
        `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      )
      return this.json(res, 200, {})
    }
    if (path.startsWith('/assets/') && this.pairAssets.has(path)) {
      return this.file(req, res, path.slice(1), 'immutable')
    }
    const session = this.session(req)
    if (!session) {
      if (path === '/' || path === '/index.html') return this.redirect(res, '/pair')
      return this.text(res, 401, 'Pair this device first.')
    }

    if (path === '/api/session') return this.json(res, 200, {})
    if (path === '/' && method === 'GET') return this.file(req, res, 'web.html', 'no-store')
    if (path.startsWith('/assets/') && method === 'GET') {
      return this.file(req, res, path.slice(1), 'immutable')
    }
    if (path.startsWith(`${REMOTE_IMAGES}/`) && method === 'GET') {
      const [, , chatId, file] = path.split('/')
      const image = await requestedImage(chatId ?? '', file ?? '')
      if (!image) return this.text(res, 404, 'Not found.')
      return this.stream(res, image, imageType(file), 'private, max-age=31536000, immutable')
    }
    if (path === '/api/upload' && method === 'POST') return this.upload(req, res, url)
    return this.text(res, 404, 'Not found.')
  }

  /** A device pairs with the code from the Mac's QR code, and gets its session cookie. */
  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: { code?: unknown }
    try {
      body = JSON.parse((await this.body(req, 4096)).toString('utf8'))
    } catch {
      return this.json(res, 400, { error: 'Bad request.' })
    }
    if (typeof body.code !== 'string') return this.json(res, 400, { error: 'Bad request.' })
    const paired = pair(body.code, req.headers['user-agent'])
    if (!paired) {
      return this.json(res, 401, {
        error: 'This QR code was used already or has expired. Show a new one on your Mac.'
      })
    }
    // The browser may keep it as long as it allows; the Mac ends a session unused for 30 days.
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${paired.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}`
    )
    this.host.sessionsChanged()
    return this.json(res, 200, {})
  }

  private async upload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_UPLOAD)
      return this.json(res, 413, { error: 'Files up to 50 MB can be attached.' })
    let data: Buffer
    try {
      data = await this.body(req, MAX_UPLOAD)
    } catch {
      return this.json(res, 413, { error: 'Files up to 50 MB can be attached.' })
    }
    // Only a plain name is kept; the folder is the app's own.
    const name =
      basename(url.searchParams.get('name') ?? 'file')
        .replace(/[^\w.\- ]+/g, '_')
        .slice(-100) || 'file'
    const dir = join(app.getPath('userData'), 'attachments', crypto.randomUUID())
    await mkdir(dir, { recursive: true })
    const path = join(dir, name)
    await writeFile(path, data)
    return this.json(res, 200, { path, name })
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private session(req: IncomingMessage): { id: string } | undefined {
    const cookies = req.headers.cookie ?? ''
    const token = cookies
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1)
    return sessionFor(token)
  }

  private sessionStillOn(id: string): boolean {
    return loadConfig().sessions.some((s) => s.id === id)
  }

  private originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (!origin) return false
    return (
      origin === this.publicOrigin ||
      origin === `http://127.0.0.1:${this.port}` ||
      origin === `http://localhost:${this.port}`
    )
  }

  private body(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('Too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  /** A file of the built app, compressed when the browser takes it. */
  private async file(
    req: IncomingMessage,
    res: ServerResponse,
    relative: string,
    cache: 'no-store' | 'immutable'
  ): Promise<void> {
    const path = normalize(join(this.root, relative))
    if (!path.startsWith(this.root + sep)) return this.text(res, 404, 'Not found.')
    const ext = extname(path)
    const type = TYPES[ext]
    const info = await stat(path).catch(() => undefined)
    if (!type || !info?.isFile()) return this.text(res, 404, 'Not found.')
    const headers: Record<string, string> = {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Cache-Control': cache === 'immutable' ? 'public, max-age=31536000, immutable' : 'no-store'
    }
    const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding']))
    if (!gzip) {
      res.writeHead(200, { ...headers, 'Content-Length': String(info.size) })
      createReadStream(path).pipe(res)
      return
    }
    let body = this.gzipped.get(path)
    if (!body) {
      body = gzipSync(await readFile(path))
      this.gzipped.set(path, body)
    }
    res.writeHead(200, {
      ...headers,
      'Content-Encoding': 'gzip',
      Vary: 'Accept-Encoding',
      'Content-Length': String(body.length)
    })
    res.end(body)
  }

  private async stream(
    res: ServerResponse,
    path: string,
    type: string,
    cache: string
  ): Promise<void> {
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) return this.text(res, 404, 'Not found.')
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': String(info.size),
      'Cache-Control': cache
    })
    createReadStream(path).pipe(res)
  }

  /**
   * A file of a bot's folder, for its dashboard in a frame of this link's page:
   * sandboxed, so it cannot reach the page, and able to load nothing but its
   * own folder's files, which it fetches across origins.
   */
  private async botFile(
    res: ServerResponse,
    file: { path: string } | { text: string; type: string }
  ): Promise<void> {
    const headers = {
      'Content-Security-Policy': `sandbox allow-scripts; ${DASHBOARD_POLICY}; frame-ancestors 'self'`,
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    }
    if ('text' in file) {
      res.writeHead(200, { ...headers, 'Content-Type': file.type })
      return void res.end(file.text)
    }
    const info = await stat(file.path).catch(() => undefined)
    if (!info?.isFile()) return this.text(res, 404, 'Not found.')
    res.writeHead(200, {
      ...headers,
      'Content-Type': botFileType(file.path),
      'Content-Length': String(info.size)
    })
    createReadStream(file.path).pipe(res)
  }

  /**
   * A short answer to a dashboard: to saving a record, to the browser asking
   * whether it may, or that a file is not there. The page reads it across
   * origins, as it reads its files.
   */
  private botAnswer(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT',
      'Access-Control-Max-Age': '600',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    })
    res.end(text)
  }

  private redirect(res: ServerResponse, to: string): void {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: to, 'Cache-Control': 'no-store' })
    res.end()
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(value))
  }

  private text(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(text)
  }

  /** The scripts and styles pair.html loads: the only files served to a device not paired. */
  private async findPairAssets(): Promise<void> {
    const html = await readFile(join(this.root, 'pair.html'), 'utf8')
    this.pairAssets = new Set(
      [...html.matchAll(/(?:src|href)="\.?(\/assets\/[^"]+)"/g)].map((match) => match[1])
    )
  }
}
