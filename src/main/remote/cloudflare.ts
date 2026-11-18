import { pinnedBinary, type PinnedBinary } from './pinned-binary'
import type { TunnelProvider } from './tunnel'

/**
 * A Cloudflare Tunnel (free, no data cap), the tunnel on a server whose owner
 * made one in Cloudflare's dashboard: it runs from the tunnel's token, and the
 * dashboard routes the user's own hostname to PORT, where the remote link's
 * server then listens. Set on a server with BAREBONE_CLOUDFLARE_TOKEN and
 * BAREBONE_CLOUDFLARE_URL (deploy/vps/README.md).
 */

/** Where the tunnel's route in Cloudflare's dashboard sends the link: http://127.0.0.1:47821. */
export const CLOUDFLARE_PORT = 47821

const VERSION = '2026.11.1'
const release = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`

/** SHA-256 of each download, as GitHub lists it for the release's assets. */
const CLOUDFLARED: PinnedBinary = {
  name: 'cloudflared',
  version: VERSION,
  file: 'cloudflared',
  downloads: {
    'darwin-arm64': {
      url: `${release}/cloudflared-darwin-arm64.tgz`,
      sha256: '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462',
      inArchive: 'cloudflared'
    },
    'darwin-x64': {
      url: `${release}/cloudflared-darwin-amd64.tgz`,
      sha256: '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f',
      inArchive: 'cloudflared'
    },
    'linux-x64': {
      url: `${release}/cloudflared-linux-amd64`,
      sha256: '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7'
    }
  }
}

export interface CloudflareTunnel {
  token: string
  /** The hostname the tunnel's route serves, as an origin: https://remote.example.com. */
  url: string
}

/**
 * The Cloudflare tunnel this server is set to use, or undefined to use zrok.
 * Throws when only one of the two settings is given, or the address is no
 * https origin.
 */
export function cloudflareTunnel(): CloudflareTunnel | undefined {
  const token = process.env.BAREBONE_CLOUDFLARE_TOKEN?.trim()
  const address = process.env.BAREBONE_CLOUDFLARE_URL?.trim()
  if (!token && !address) return undefined
  if (!token || !address) {
    throw new Error('Set both BAREBONE_CLOUDFLARE_TOKEN and BAREBONE_CLOUDFLARE_URL.')
  }
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new Error(`BAREBONE_CLOUDFLARE_URL is not an address: ${address}`)
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`BAREBONE_CLOUDFLARE_URL must be https://your.host only: ${address}`)
  }
  return { token, url: url.origin }
}

export function cloudflareProvider(tunnel: CloudflareTunnel): TunnelProvider {
  return {
    name: 'cloudflared',
    port: CLOUDFLARE_PORT,
    program: () => pinnedBinary(CLOUDFLARED),
    address: async () => tunnel.url,
    command: () => ({
      args: [
        'tunnel',
        // The app pins its version; cloudflared would otherwise replace itself.
        '--no-autoupdate',
        // Stopping waits this long for open requests, within the app's own grace (tunnel.ts).
        '--grace-period',
        '3s',
        'run'
      ],
      // In the environment, so the token is not in the process list.
      env: { TUNNEL_TOKEN: tunnel.token }
    })
  }
}
