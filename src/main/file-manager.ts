import { shell } from 'electron'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { FileEntry, FilePreview, FolderListing } from '../shared/types'
import { handle, MAC_ONLY } from './remote/registry'

/**
 * The file manager: the folders and files of this computer, for the window
 * and the remote link's pages. Paths are absolute; the view starts at the
 * home folder. It can do what the user could in a terminal, which the remote
 * link's pages also have.
 */

/** A text file shows this much of its start. */
const TEXT_LIMIT = 1024 * 1024
/** A picture larger than this is not sent to look at. */
const IMAGE_LIMIT = 15 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

export function registerFileManager(): void {
  handle('fm:home', () => homedir())
  handle('fm:list', (path: unknown) => list(absolute(path)))
  handle('fm:preview', (path: unknown) => preview(absolute(path)))
  handle('fm:mkdir', async (folder: unknown, name: unknown) => {
    const path = join(absolute(folder), plainName(name))
    await mkdir(path)
    return path
  })
  handle('fm:rename', async (path: unknown, name: unknown) => {
    const from = absolute(path)
    const to = join(dirname(from), plainName(name))
    await refuseExisting(to)
    await rename(from, to)
    return to
  })
  handle('fm:move', (paths: unknown, folder: unknown) => move(paths, absolute(folder)))
  handle('fm:copyInto', (paths: unknown, folder: unknown) => copyInto(paths, absolute(folder)))
  handle('fm:delete', (paths: unknown) => remove(pathList(paths)))
  // Finder is on the Mac only.
  handle('fm:reveal', (path: unknown) => shell.showItemInFolder(absolute(path)), MAC_ONLY)
}

/**
 * Where a file uploaded into a folder through the remote link goes: the
 * folder, under its name or a free one like it; undefined when the folder is
 * not one.
 */
export async function uploadPath(folder: string, name: string): Promise<string | undefined> {
  if (!isAbsolute(folder) || !(await stat(folder).catch(() => undefined))?.isDirectory()) {
    return undefined
  }
  return freeName(resolve(folder), name)
}

/** A file to send whole, as the remote link's download does; undefined when it is no file. */
export async function downloadable(
  path: string
): Promise<{ size: number; stream: () => NodeJS.ReadableStream } | undefined> {
  if (!isAbsolute(path)) return undefined
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  return { size: info.size, stream: () => createReadStream(path) }
}

async function list(path: string): Promise<FolderListing> {
  const entries: FileEntry[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    // A link is shown as what it leads to; a broken one as a file.
    const info = await stat(full).catch(() => lstat(full).catch(() => undefined))
    if (!info) continue
    const folder = info.isDirectory()
    entries.push({ name: entry.name, folder, size: folder ? 0 : info.size, modified: info.mtimeMs })
  }
  entries.sort(
    (a, b) =>
      Number(b.folder) - Number(a.folder) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )
  const parent = dirname(path)
  return { path, parent: parent === path ? undefined : parent, entries }
}

async function preview(path: string): Promise<FilePreview> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Only a file can be opened.')
  const type = IMAGE_TYPES[extname(path).toLowerCase()]
  if (type) {
    if (info.size > IMAGE_LIMIT) return { kind: 'other', size: info.size }
    const handle = await open(path)
    try {
      const data = await handle.readFile()
      return { kind: 'image', url: `data:${type};base64,${data.toString('base64')}` }
    } finally {
      await handle.close()
    }
  }
  const handle = await open(path)
  try {
    const buffer = Buffer.alloc(Math.min(info.size, TEXT_LIMIT))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const start = buffer.subarray(0, bytesRead)
    // A NUL byte early on is a binary file's, never a text file's.
    if (start.subarray(0, 8000).includes(0)) return { kind: 'other', size: info.size }
    return { kind: 'text', text: start.toString('utf8'), cut: info.size > bytesRead }
  } finally {
    await handle.close()
  }
}

/** Move files and folders into a folder; the paths they have there. */
async function move(paths: unknown, folder: string): Promise<string[]> {
  const moved: string[] = []
  for (const from of pathList(paths)) {
    const to = join(folder, basename(from))
    if (to === from) continue
    if ((folder + '/').startsWith(from + '/'))
      throw new Error(`${basename(from)} cannot go into itself.`)
    await refuseExisting(to)
    try {
      await rename(from, to)
    } catch (error) {
      // Onto another disk: copied, then the original removed.
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await cp(from, to, { recursive: true, errorOnExist: true, force: false })
      await rm(from, { recursive: true, force: true })
    }
    moved.push(to)
  }
  return moved
}

/**
 * Copy files into a folder, as an upload is: a file dropped on the window, or
 * one a remote link's page sent (remote/server.ts). A name already there gets
 * a number, as Finder does: "notes 2.txt".
 */
async function copyInto(paths: unknown, folder: string): Promise<string[]> {
  const copied: string[] = []
  for (const from of pathList(paths)) {
    const to = await freeName(folder, basename(from))
    await cp(from, to, { recursive: true, errorOnExist: true, force: false })
    copied.push(to)
  }
  return copied
}

/** To the Trash where there is one (the Mac); deleted for good where there is none. */
async function remove(paths: string[]): Promise<void> {
  for (const path of paths) {
    if (path === '/' || path === homedir()) throw new Error(`${path} cannot be deleted.`)
    if (process.platform === 'darwin') await shell.trashItem(path)
    else await rm(path, { recursive: true, force: false })
  }
}

async function freeName(folder: string, name: string): Promise<string> {
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  for (let n = 1; ; n++) {
    const path = join(folder, n === 1 ? name : `${stem} ${n}${extension}`)
    if (!(await lstat(path).catch(() => undefined))) return path
  }
}

async function refuseExisting(path: string): Promise<void> {
  if (await lstat(path).catch(() => undefined)) {
    throw new Error(`There is already something named ${basename(path)} there.`)
  }
}

function absolute(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Bad request.')
  return resolve(path)
}

function pathList(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Bad request.')
  return paths.map(absolute)
}

/** A name for a file or folder: no folder in it, and not "." or "..". */
function plainName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/')) {
    throw new Error('Enter a name without a slash.')
  }
  return trimmed
}
