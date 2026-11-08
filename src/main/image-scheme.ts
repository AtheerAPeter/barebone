import { nativeImage, net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { IMAGE_SCHEME } from '../shared/types'
import { chatImagePath } from './images'

/** The window's chat images (images.ts), as chat-image://<chatId>/<file>. */

const CHAT_ID = /^[0-9a-f-]{36}$/
const FILE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/

/** Must run before the app is ready. */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** Serve chat images to the window. Only its session has the scheme; the browser panel's pages do not. */
export function handleImageRequests(): void {
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url)
    const file = pathname.slice(1)
    if (!CHAT_ID.test(host) || !FILE.test(file)) return new Response(null, { status: 404 })
    return net.fetch(pathToFileURL(await chatImagePath(host, file)).href)
  })
}

/** A small preview of an image file on disk, as a data URL; null when it cannot be read. */
export async function thumbnail(path: string): Promise<string | null> {
  try {
    const image = await nativeImage.createThumbnailFromPath(path, { width: 96, height: 96 })
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}
