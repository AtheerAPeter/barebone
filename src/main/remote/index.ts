import type { AppState, RemotePairing, RemoteStatus } from '../../shared/types'
import type { BuiltinBrowser } from '../browser'
import { endSession, newPairingCode } from './auth'
import { RemoteBrowser } from './browser'
import { loadConfig, saveConfig } from './config'
import { handle, MAC_ONLY, type Caller } from './registry'
import { RemoteServer } from './server'
import { enableZrok, newShareName, zrokEnabled, ZrokTunnel } from './tunnel'

/**
 * The remote link: this app's UI in a browser anywhere, through zrok. Set up
 * and opened in Settings on the Mac only (none of its requests are open to the
 * link itself). A device joins by scanning a one-time QR code shown there. The
 * link opens again at launch when it was open.
 */
export class RemoteLink {
  private server?: RemoteServer
  private tunnel = new ZrokTunnel({
    online: (url) => {
      this.url = url
      if (this.server) this.server.publicOrigin = new URL(url).origin
      this.setLink('online')
    },
    failed: (message) => this.setLink('error', message)
  })
  private link: RemoteStatus['link'] = 'off'
  private url?: string
  private error?: string
  /** The browser's tabs on the link's devices, once the app has a browser. */
  private browser?: RemoteBrowser

  constructor(
    private host: {
      state(): AppState
      statusChanged(status: RemoteStatus): void
    }
  ) {}

  /** Register Settings' requests, and open the link if it was open when the app quit. */
  start(browser: BuiltinBrowser): void {
    this.browser = new RemoteBrowser(browser, {
      chatExists: (chatId) => this.host.state().chats.some((chat) => chat.id === chatId),
      sendTo: (caller, channel, args) => this.server?.sendTo(caller, channel, args) ?? false,
      sendBinary: (caller, data) => this.server?.sendBinary(caller, data) ?? false,
      deviceOf: (caller) => this.server?.deviceOf(caller)
    })
    handle('remote:status', () => this.status(), MAC_ONLY)
    handle('remote:setBrowser', (on: boolean) => this.setBrowser(on), MAC_ONLY)
    handle('remote:enableZrok', (token: string) => this.enableZrok(token), MAC_ONLY)
    handle('remote:setOn', (on: boolean) => this.setOn(on), MAC_ONLY)
    handle('remote:pair', () => this.pair(), MAC_ONLY)
    handle('remote:signOut', (id: string) => this.signOut(id), MAC_ONLY)
    if (loadConfig().on && zrokEnabled()) void this.open().catch(() => undefined)
  }

  /** The paired session a page of the link is open in; undefined once it is gone. */
  sessionOf(caller: Caller): string | undefined {
    return this.server?.sessionOf(caller)
  }

  /** Something the window is told: pages of the link that show it are told too. */
  event(channel: string, args: unknown[]): void {
    this.server?.event(channel, args)
  }

  async stop(): Promise<void> {
    await this.tunnel.stop()
    await this.server?.stop()
    this.server = undefined
  }

  status(): RemoteStatus {
    const config = loadConfig()
    return {
      zrok: zrokEnabled() ? 'enabled' : 'disabled',
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
    if (on && !zrokEnabled()) throw new Error('Join zrok to your account first.')
    loadConfig().on = on || undefined
    saveConfig()
    if (on) await this.open()
    else await this.close()
  }

  private async open(): Promise<void> {
    if (this.server) return
    const config = loadConfig()
    config.zrokName ??= newShareName()
    saveConfig()
    this.setLink('starting')
    try {
      this.server = new RemoteServer({
        state: this.host.state,
        sessionsChanged: () => this.changed()
      })
      const port = await this.server.start()
      await this.tunnel.start(port, config.zrokName)
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
