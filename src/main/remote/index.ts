import type { AppState, RemotePairing, RemoteStatus } from '../../shared/types'
import { endSession, newPairingCode } from './auth'
import { loadConfig, saveConfig } from './config'
import { handle, MAC_ONLY } from './registry'
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

  constructor(
    private host: {
      state(): AppState
      statusChanged(status: RemoteStatus): void
    }
  ) {}

  /** Register Settings' requests, and open the link if it was open when the app quit. */
  start(): void {
    handle('remote:status', () => this.status(), MAC_ONLY)
    handle('remote:enableZrok', (token: string) => this.enableZrok(token), MAC_ONLY)
    handle('remote:setOn', (on: boolean) => this.setOn(on), MAC_ONLY)
    handle('remote:pair', () => this.pair(), MAC_ONLY)
    handle('remote:signOut', (id: string) => this.signOut(id), MAC_ONLY)
    if (loadConfig().on && zrokEnabled()) void this.open().catch(() => undefined)
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
