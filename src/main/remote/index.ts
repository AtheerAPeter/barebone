import { powerSaveBlocker } from 'electron'
import { renderUnicodeCompact } from 'uqr'
import {
  OWN_BROWSER,
  type AppState,
  type RemotePairing,
  type RemoteStatus
} from '../../shared/types'
import type { BuiltinBrowser } from '../browser'
import { endSession, newPairingCode } from './auth'
import { RemoteBrowser } from './browser'
import { HEADLESS, loadConfig, saveConfig } from './config'
import { handle, MAC_ONLY, type Caller } from './registry'
import { cloudflareProvider, cloudflareTunnel, type CloudflareTunnel } from './cloudflare'
import { RemoteServer } from './server'
import { Tunnel, type TunnelEvents, type TunnelProvider } from './tunnel'
import { enableZrok, newShareName, zrokEnabled, zrokProvider } from './zrok'

/**
 * The remote link: this app's UI in a browser anywhere, through a tunnel:
 * zrok, or on a server a Cloudflare tunnel when one is set. Set up and opened
 * in Settings on the Mac only (none of its requests are open to the link
 * itself). A device joins by scanning a one-time QR code shown there. The
 * link opens again at launch when it was open.
 */
export class RemoteLink {
  private server?: RemoteServer
  private tunnel?: Tunnel
  private tunnelEvents: TunnelEvents = {
    online: (url) => {
      this.url = url
      if (this.server) this.server.publicOrigin = new URL(url).origin
      this.setLink('online')
      this.printPairing()
    },
    failed: (message) => this.setLink('error', message)
  }
  /** The Cloudflare tunnel this server is set to use (cloudflare.ts); zrok when there is none. */
  private cloudflare?: CloudflareTunnel
  private link: RemoteStatus['link'] = 'off'
  /** Whether this launch printed its pairing link (printPairing); the tunnel can come online again. */
  private printedPairing = false
  private url?: string
  private error?: string
  /** The browser's tabs on the link's devices, once the app has a browser. */
  private browser?: RemoteBrowser
  /**
   * Keeps the Mac from going to sleep while the link is open: asleep, it
   * answers no one. The display may still sleep, and a closed lid still
   * sleeps a Mac on battery.
   */
  private awake?: number

  constructor(
    private host: {
      state(): AppState
      statusChanged(status: RemoteStatus): void
    }
  ) {}

  /** Register Settings' requests, and open the link if it was open when the app quit. */
  start(browser: BuiltinBrowser): void {
    this.browser = new RemoteBrowser(browser, {
      // A chat's browser, or the user's own (Browser in the sidebar).
      chatExists: (chatId) =>
        chatId === OWN_BROWSER || this.host.state().chats.some((chat) => chat.id === chatId),
      sendTo: (caller, channel, args) => this.server?.sendTo(caller, channel, args) ?? false,
      sendBinary: (caller, data) => this.server?.sendBinary(caller, data) ?? false,
      deviceOf: (caller) => this.server?.deviceOf(caller)
    })
    // On a server, paired devices set the link up as Settings on the Mac do;
    // turning it off, which would leave no way back in, stays the Mac's.
    const settings = HEADLESS ? undefined : MAC_ONLY
    handle('remote:status', () => this.status(), settings)
    handle('remote:setBrowser', (on: boolean) => this.setBrowser(on), settings)
    handle('remote:pair', () => this.pair(), settings)
    handle('remote:signOut', (id: string) => this.signOut(id), settings)
    handle('remote:enableZrok', (token: string) => this.enableZrok(token), MAC_ONLY)
    handle('remote:setOn', (on: boolean) => this.setOn(on), MAC_ONLY)
    if (HEADLESS) void this.startOnServer()
    else if (loadConfig().on && this.ready()) void this.open().catch(() => undefined)
  }

  /**
   * On a server the link is the only way in: it opens at once, through the
   * Cloudflare tunnel when one is set, or else joining zrok with
   * BAREBONE_ZROK_TOKEN the first time. Each launch prints a pairing link for
   * the server's log (docker compose logs; printPairing).
   */
  private async startOnServer(): Promise<void> {
    try {
      this.cloudflare = cloudflareTunnel()
      if (!this.ready()) {
        const token = process.env.BAREBONE_ZROK_TOKEN?.trim()
        if (!token) {
          console.error('The remote link is off: set BAREBONE_ZROK_TOKEN to your zrok token.')
          return
        }
        await enableZrok(token)
      }
      loadConfig().on = true
      saveConfig()
      await this.open()
    } catch (error) {
      console.error(`The remote link did not open: ${(error as Error).message}`)
    }
  }

  /**
   * On a server, a link to pair a device, in the log, once each time Barebone
   * starts: the way in for the first device, and for any device later on without
   * one already paired at hand. Whoever reads the log runs the server anyway.
   */
  private printPairing(): void {
    if (!HEADLESS || this.printedPairing) return
    this.printedPairing = true
    const { url } = this.pair()
    console.log(
      [
        '',
        'Pair your phone or computer with Barebone: open this link on it, or scan the code.',
        'It works once, for 5 minutes; restart Barebone for a new one.',
        '',
        url,
        '',
        renderUnicodeCompact(url, { border: 2 }),
        ''
      ].join('\n')
    )
  }

  /** The paired session a page of the link is open in; undefined once it is gone. */
  sessionOf(caller: Caller): string | undefined {
    return this.server?.sessionOf(caller)
  }

  /** Something the window is told: pages of the link that show it are told too. */
  event(channel: string, args: unknown[]): void {
    this.server?.event(channel, args)
  }

  /** Tell one page of the link something; false when it is gone. */
  sendTo(caller: Caller, channel: string, args: unknown[]): boolean {
    return this.server?.sendTo(caller, channel, args) ?? false
  }

  async stop(): Promise<void> {
    if (this.awake !== undefined) powerSaveBlocker.stop(this.awake)
    this.awake = undefined
    await this.tunnel?.stop()
    this.tunnel = undefined
    await this.server?.stop()
    this.server = undefined
  }

  status(): RemoteStatus {
    const config = loadConfig()
    return {
      tunnel: this.cloudflare ? 'cloudflare' : 'zrok',
      ready: this.ready(),
      on: Boolean(config.on),
      browser: config.browser === true,
      link: this.link,
      url: this.link === 'online' ? this.url : undefined,
      error: this.link === 'error' ? this.error : undefined,
      sessions: config.sessions.map(({ id, device, createdAt, lastSeenAt }) => ({
        id,
        device,
        createdAt,
        lastSeenAt
      }))
    }
  }

  /** Whether the tunnel is set up: a Cloudflare tunnel is set, or zrok is joined to an account. */
  private ready(): boolean {
    return Boolean(this.cloudflare) || zrokEnabled()
  }

  private changed(): void {
    this.host.statusChanged(this.status())
  }

  private setLink(link: RemoteStatus['link'], error?: string): void {
    this.link = link
    this.error = error
    this.changed()
  }

  private async enableZrok(token: string): Promise<void> {
    await enableZrok(token)
    this.changed()
  }

  /** A one-time link to the pairing page, its code after the #, which browsers never send on. */
  private pair(): RemotePairing {
    if (this.link !== 'online' || !this.url) throw new Error('Turn the remote link on first.')
    const { code, expiresAt } = newPairingCode()
    return { url: `${this.url}/pair#${code}`, expiresAt }
  }

  /** Let paired devices use the browser, or stop them; they are told either way. */
  private setBrowser(on: boolean): void {
    this.browser?.setAllowed(on === true)
    this.event('remoteBrowser:allowed', [on === true])
    this.changed()
  }

  private signOut(id: string): void {
    endSession(id)
    this.server?.dropEndedSessions()
    this.changed()
  }

  private async setOn(on: boolean): Promise<void> {
    if (on && !this.ready()) throw new Error('Join zrok to your account first.')
    loadConfig().on = on || undefined
    saveConfig()
    if (on) await this.open()
    else await this.close()
  }

  private async open(): Promise<void> {
    if (this.server) return
    const config = loadConfig()
    let provider: TunnelProvider
    if (this.cloudflare) provider = cloudflareProvider(this.cloudflare)
    else {
      config.zrokName ??= newShareName()
      saveConfig()
      provider = zrokProvider(config.zrokName)
    }
    this.setLink('starting')
    this.awake = powerSaveBlocker.start('prevent-app-suspension')
    try {
      this.server = new RemoteServer({
        state: this.host.state,
        sessionsChanged: () => this.changed()
      })
      const port = await this.server.start(provider.port)
      this.tunnel = new Tunnel(provider, this.tunnelEvents)
      await this.tunnel.start(port)
    } catch (error) {
      await this.close()
      this.setLink('error', (error as Error).message)
      throw error
    }
  }

  private async close(): Promise<void> {
    await this.stop()
    this.url = undefined
    this.setLink('off')
  }
}
