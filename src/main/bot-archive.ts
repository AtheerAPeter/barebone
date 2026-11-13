import { app } from 'electron'
import { execFile } from 'node:child_process'
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { BOT_SHAPES, PROJECT_COLORS, type BotShape, type Project } from '../shared/types'
import { BOTS_DIR, freeFolder, MAX_NAME, MEMORY } from './bots'
import { newRoutine, type NewRoutine } from './routines'
import * as store from './store'

/**
 * A bot as one file, to take it to a Barebone on another computer: a gzipped
 * tar of its folder (its instructions, memory, records, documents, dashboard)
 * and of bot.json, which says who it is and what it does regularly. Its
 * conversation stays behind, as its agent's session cannot be moved, and so
 * do passwords it keeps in the computer's keychain; memory.md is told so.
 */

export const BOT_FILE_EXTENSION = 'barebonebot'

const FORMAT = 'barebone-bot'
const VERSION = 1
const MANIFEST = 'bot.json'
const FOLDER = 'folder'
/** The system's own, as for the packages the app downloads (downloads.ts). */
const TAR = '/usr/bin/tar'

const run = promisify(execFile)

interface Manifest {
  format: typeof FORMAT
  version: number
  name: string
  job: string
  shape: BotShape
  color?: Project['color']
  routines: NewRoutine[]
  /** Where its folder was. Its instructions name the folder, and are rewritten for the new one. */
  path: string
  exportedAt: number
  /** The app's version that wrote the file. */
  app: string
}

const NOT_A_BOT = 'This file is not a Barebone bot, or it is damaged.'

/** Write a bot to `file`. */
export async function exportBot(projectId: string, file: string): Promise<void> {
  const project = store.getState().projects.find((p) => p.id === projectId)
  if (!project?.bot) throw new Error('This bot is gone.')
  const manifest: Manifest = {
    format: FORMAT,
    version: VERSION,
    name: project.name,
    job: project.bot.job,
    shape: project.bot.shape,
    color: project.color,
    routines: (project.bot.routines ?? []).map(({ note, time, days, everyHours }) => ({
      note,
      time,
      days,
      everyHours
    })),
    path: project.path,
    exportedAt: Date.now(),
    app: app.getVersion()
  }
  const staging = await mkdtemp(join(tmpdir(), 'barebone-bot-'))
  try {
    // Only its files and folders: a link would take in whatever it points to.
    await cp(project.path, join(staging, FOLDER), {
      recursive: true,
      filter: async (source) => {
        if (basename(source) === '.DS_Store') return false
        const info = await lstat(source)
        return info.isDirectory() || info.isFile()
      }
    })
    await writeFile(join(staging, MANIFEST), JSON.stringify(manifest, null, 2))
    await run(TAR, ['-czf', file, '-C', staging, MANIFEST, FOLDER], {
      // The Mac's tar otherwise adds a ._ file for each file's extended attributes.
      env: { ...process.env, COPYFILE_DISABLE: '1' }
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Whether a path in the file is the manifest or something in the bot's folder, and nothing else. */
function expected(entry: string): boolean {
  const parts = entry.replace(/^\.\//, '').replace(/\/$/, '').split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false
  return parts[0] === FOLDER || (parts.length === 1 && parts[0] === MANIFEST)
}

/**
 * Throw unless everything under `dir` is a plain file or a folder: a link or a
 * file that is also another file elsewhere would reach out of the bot's folder.
 */
async function onlyFilesAndFolders(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    const info = await lstat(path)
    if (info.isDirectory()) await onlyFilesAndFolders(path)
    else if (!info.isFile() || info.nlink > 1) throw new Error(NOT_A_BOT)
  }
}

function readManifest(text: string): Manifest {
  let read: Partial<Manifest>
  try {
    read = JSON.parse(text) as Partial<Manifest>
  } catch {
    throw new Error(NOT_A_BOT)
  }
  if (read?.format !== FORMAT || typeof read.version !== 'number') throw new Error(NOT_A_BOT)
  if (read.version > VERSION) {
    throw new Error('This bot was exported by a newer Barebone. Update Barebone, then import it.')
  }
  const name = typeof read.name === 'string' ? read.name.trim() : ''
  const job = typeof read.job === 'string' ? read.job.trim() : ''
  const shape = BOT_SHAPES.find((s) => s === read.shape)
  if (!name || name.length > MAX_NAME || !job || !shape) throw new Error(NOT_A_BOT)
  const color =
    PROJECT_COLORS.find((c) => c === read.color) ??
    (typeof read.color === 'string' && /^#[0-9a-f]{6}$/i.test(read.color)
      ? (read.color as `#${string}`)
      : undefined)
  return {
    format: FORMAT,
    version: read.version,
    name,
    job,
    shape,
    color,
    routines: Array.isArray(read.routines) ? read.routines : [],
    path: typeof read.path === 'string' ? read.path : '',
    exportedAt: typeof read.exportedAt === 'number' ? read.exportedAt : 0,
    app: typeof read.app === 'string' ? read.app : ''
  }
}

/**
 * Make a bot from an exported file: its folder under a free name, with its
 * instructions pointing there, and its routines set again from now. The file
 * comes from elsewhere, so nothing in it may land outside the new folder.
 */
export async function importBot(file: string): Promise<Project> {
  await mkdir(BOTS_DIR, { recursive: true })
  // Beside the bots' folders, so the move into place is a rename.
  const staging = await mkdtemp(join(BOTS_DIR, '.import-'))
  try {
    const listed = await run(TAR, ['-tzf', file], { maxBuffer: 64 * 1024 * 1024 }).catch(() => {
      throw new Error(NOT_A_BOT)
    })
    const entries = listed.stdout.split('\n').filter(Boolean)
    if (entries.length === 0 || !entries.every(expected)) throw new Error(NOT_A_BOT)
    await run(TAR, ['-xzf', file, '-C', staging]).catch(() => {
      throw new Error(NOT_A_BOT)
    })
    await onlyFilesAndFolders(staging)

    const manifest = readManifest(
      await readFile(join(staging, MANIFEST), 'utf8').catch(() => {
        throw new Error(NOT_A_BOT)
      })
    )
    const folder = join(staging, FOLDER)
    const instructions = join(folder, 'AGENTS.md')
    const text = await readFile(instructions, 'utf8').catch(() => {
      throw new Error(NOT_A_BOT)
    })
    let routines
    try {
      routines = manifest.routines.map((routine) => newRoutine(routine))
    } catch {
      throw new Error(NOT_A_BOT)
    }

    const path = freeFolder(manifest.name)
    // Only a real path is looked for: a short or empty one would match all over the text.
    const moved = /^(\/|[A-Za-z]:\\).{3,}/.test(manifest.path) && manifest.path !== path
    if (moved) await writeFile(instructions, text.replaceAll(manifest.path, path))
    const day = new Date().toLocaleDateString('sv')
    await appendFile(
      join(folder, MEMORY),
      `\n- Moved to another computer on ${day}. Your folder is now ${path}${moved ? ` (it was ${manifest.path})` : ''}. Your conversation from before did not come along, nor did passwords kept in the old computer's keychain.${routines.length > 0 ? ' Your routines were set again.' : ''}\n`
    )
    await rename(folder, path)

    const project: Project = {
      id: crypto.randomUUID(),
      name: manifest.name,
      path,
      createdAt: Date.now(),
      color: manifest.color,
      bot: {
        shape: manifest.shape,
        job: manifest.job,
        ...(routines.length > 0 ? { routines } : {})
      }
    }
    store.addProject(project)
    return project
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
