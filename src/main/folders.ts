import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { FolderSuggestions } from '../shared/types'

/**
 * Folders on this computer by their path, as typed in the project picker: a
 * project can be opened without a folder dialog, which a browser through the
 * remote link has none of, and which a desktop in a container may not show.
 */

/** How many folders a suggestion lists at most. */
const MAX_SUGGESTIONS = 50

/** A typed path as an absolute one: "~" is the home folder; anything else must start at "/". */
export function typedPath(typed: string): string | undefined {
  const text = typed.trim()
  const path = text === '~' || text.startsWith('~/') ? join(homedir(), text.slice(1)) : text
  return isAbsolute(path) ? resolve(path) : undefined
}

async function isFolder(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false
}

/** The folder a typed path names; throws, saying why, when there is none. */
export async function folderAt(typed: string): Promise<string> {
  const path = typedPath(typed)
  if (!path) throw new Error('Type a full path, starting with / or ~.')
  if (!(await isFolder(path))) throw new Error(`There is no folder at ${path}.`)
  return path
}

/**
 * What a typed path could mean: "~/pro" lists ~/projects and the like, and
 * "~/projects/" what is in it. Hidden folders show once a "." is typed.
 */
export async function folderSuggestions(typed: string): Promise<FolderSuggestions> {
  const path = typedPath(typed)
  if (!path) return { folders: [] }
  const inside = typed.trim().endsWith('/') || typed.trim() === '~'
  const parent = inside ? path : dirname(path)
  const start = inside ? '' : basename(path).toLowerCase()
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => [])
  const matching = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .filter((entry) => start.startsWith('.') || !entry.name.startsWith('.'))
    .filter((entry) => entry.name.toLowerCase().startsWith(start))
    .sort((a, b) => a.name.localeCompare(b.name))
  const folders: string[] = []
  for (const entry of matching) {
    if (folders.length === MAX_SUGGESTIONS) break
    const folder = join(parent, entry.name)
    // A symbolic link counts only when it leads to a folder.
    if (folder !== path && (entry.isDirectory() || (await isFolder(folder)))) folders.push(folder)
  }
  return { folder: (await isFolder(path)) ? path : undefined, folders }
}
