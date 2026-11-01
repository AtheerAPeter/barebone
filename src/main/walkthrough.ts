import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  DiffLine,
  WalkAt,
  WalkCard,
  WalkControl,
  WalkFile,
  WalkStop,
  Walkthrough
} from '../shared/types'
import { diff, repoPath, status } from './git'
import type { Spoken } from './speech'
import type { Language } from './speech/supertonic'

/**
 * Code walkthroughs: an agent sends a whole route through the code at once
 * (the walkthrough tool, browser-mcp.ts), and the app plays it in the code
 * panel, stop after stop, as the voice says each one. Planned whole, it plays
 * without the model's pauses between steps, and the user can pause it and
 * step back and forth.
 */

/** Bigger than this is generated or data, not code to walk through. */
const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface WalkStopArgs {
  path: string
  lines: { from: number; to: number }
  name: string
  say: string
  notes?: { line: number; text: string }[]
  changes?: 'unstaged' | 'staged'
  link?: { line: number; text?: string; label: string; back?: boolean; to_line?: number }
}

/** What the walkthrough tool needs of the app (index.ts). */
export interface WalkthroughApi {
  /** The folder of the chat's project. */
  projectPath(chatId: string): string | undefined
  /** Open the chat's code panel and play the walkthrough there. */
  start(chatId: string, walk: Walkthrough, language?: Language, pace?: number): void
}

let lastId = 0

/**
 * The walkthrough an agent asks for; throws what is wrong with it, so a walk
 * that cannot play does not start.
 */
export async function buildWalkthrough(
  projectPath: string,
  title: string,
  stopArgs: WalkStopArgs[]
): Promise<Walkthrough> {
  // The files, once each: a file and its changes are separate.
  const files: WalkFile[] = []
  const fileOf = new Map<string, number>()
  const hunks = new Map<number, DiffLine[]>()
  for (const [n, stop] of stopArgs.entries()) {
    const path = isAbsolute(stop.path) ? stop.path : resolve(projectPath, stop.path)
    const key = `${path}\0${stop.changes ?? ''}`
    if (fileOf.has(key)) continue
    const name = path.startsWith(projectPath + '/') ? relative(projectPath, path) : path
    const at = `Stop ${n + 1} (${stop.name})`
    if (stop.changes) {
      const changes = await diffOf(path, stop.changes === 'staged', at)
      hunks.set(files.length, changes.lines)
      files.push({ path, name, text: changes.new, old: changes.old, changes: stop.changes })
    } else {
      files.push({ path, name, text: await textOf(path, at) })
    }
    fileOf.set(key, files.length - 1)
  }

  const fileIndex = stopArgs.map((stop) => {
    const path = isAbsolute(stop.path) ? stop.path : resolve(projectPath, stop.path)
    return fileOf.get(`${path}\0${stop.changes ?? ''}`)!
  })
  for (const [n, stop] of stopArgs.entries()) {
    const { from, to } = stop.lines
    const count = lineCount(files[fileIndex[n]].text)
    if (from < 1 || to < from || to > count) {
      throw new Error(
        `Stop ${n + 1} (${stop.name}): lines ${from}–${to} are not in ${files[fileIndex[n]].name}, which has ${count} lines.`
      )
    }
  }

  // Cards: the stretches of each file the stops are about, with a line around
  // them so the code does not start or end mid-thought. Stops whose stretches
  // overlap share a card, so a return comes back to the code it left; next
  // functions, which only touch, keep cards of their own.
  const cards: WalkCard[] = []
  const cardOf: number[] = []
  for (const [n, stop] of stopArgs.entries()) {
    const file = fileIndex[n]
    const count = lineCount(files[file].text)
    const from = Math.max(1, stop.lines.from - 1)
    const to = Math.min(count, stop.lines.to + 1)
    const near = cards.findIndex((c) => c.file === file && from <= c.to && to >= c.from)
    if (near === -1) {
      cards.push({ file, from, to, rows: [] })
      cardOf.push(cards.length - 1)
    } else {
      cards[near].from = Math.min(cards[near].from, from)
      cards[near].to = Math.max(cards[near].to, to)
      cardOf.push(near)
    }
  }
  for (const card of cards) card.rows = rowsOf(card, hunks.get(card.file))

  const stops: WalkStop[] = stopArgs.map((stop, n) => {
    const card = cards[cardOf[n]]
    const file = files[card.file]
    const at = `Stop ${n + 1} (${stop.name})`
    const notes = (stop.notes ?? [])
      .map((note) => ({ line: note.line, text: note.text.trim() }))
      .filter((note) => note.text)
    for (const note of notes) {
      if (note.line < card.from || note.line > card.to) {
        throw new Error(
          `${at}: its note "${note.text}" is on line ${note.line}, outside the lines it shows (${card.from}–${card.to}).`
        )
      }
    }
    let link: WalkStop['link']
    if (stop.link) {
      const next = n + 1 < stopArgs.length ? cards[cardOf[n + 1]] : undefined
      if (!next) throw new Error(`${at}: it is the last stop, so its link leads nowhere.`)
      const { line, text, label, back, to_line } = stop.link
      if (line < card.from || line > card.to) {
        throw new Error(
          `${at}: its link leaves from line ${line}, outside the lines it shows (${card.from}–${card.to}).`
        )
      }
      if (text && !lineText(file.text, line).includes(text)) {
        throw new Error(`${at}: "${text}" is not on line ${line} of ${file.name}.`)
      }
      const to = to_line ?? stopArgs[n + 1].lines.from
      if (to < next.from || to > next.to) {
        throw new Error(
          `${at}: its link arrives at line ${to}, outside what stop ${n + 2} shows (${next.from}–${next.to}).`
        )
      }
      link = { line, text: text || undefined, label: label.trim(), back: back === true, to }
    }
    return {
      card: cardOf[n],
      name: stop.name.trim(),
      from: stop.lines.from,
      to: stop.lines.to,
      say: stop.say.trim(),
      notes,
      link
    }
  })

  return { id: ++lastId, title: title.trim(), files, cards, stops }
}

async function textOf(path: string, at: string): Promise<string> {
  const info = await stat(path).catch(() => undefined)
  if (!info) throw new Error(`${at}: there is no file at ${path}.`)
  if (info.isDirectory()) throw new Error(`${at}: ${path} is a folder, not a file.`)
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`${at}: ${path} is ${(info.size / 1e6).toFixed(1)} MB, too big to show.`)
  }
  const text = await readFile(path, 'utf8')
  if (text.includes('\0')) throw new Error(`${at}: ${path} is a binary file.`)
  return text
}

/** A file's uncommitted changes: the file before and after, and every changed or nearby line. */
async function diffOf(
  path: string,
  staged: boolean,
  at: string
): Promise<{ old: string; new: string; lines: DiffLine[] }> {
  const where = await repoPath(path)
  if (!where) throw new Error(`${at}: ${path} is not in a git repository, so it has no changes.`)
  const repo = await status(where.root)
  const change = repo.repo
    ? (staged ? repo.staged : repo.unstaged).find((c) => c.path === where.path)
    : undefined
  if (!change) {
    throw new Error(
      `${at}: ${where.path} has no ${staged ? 'staged' : 'unstaged'} changes. Leave out "changes" to show the file as it is.`
    )
  }
  const changes = await diff(where.root, change, staged)
  if (changes.binary) throw new Error(`${at}: ${where.path} is a binary file.`)
  if (!changes.new) throw new Error(`${at}: ${where.path} is deleted, so it has no lines to show.`)
  return { old: changes.old, new: changes.new, lines: changes.hunks.flatMap((h) => h.lines) }
}

/**
 * A card's rows: its lines of the new file in order, and with changes the
 * added ones marked and the deleted ones before the line they stood before.
 */
function rowsOf(card: WalkCard, changed: DiffLine[] | undefined): DiffLine[] {
  const added = new Set(changed?.filter((l) => l.type === 'add').map((l) => l.new))
  const rows: DiffLine[] = []
  for (let line = card.from; line <= card.to; line++) {
    for (const del of changed ?? []) {
      if (del.type === 'del' && del.before === line) rows.push(del)
    }
    rows.push({ type: added.has(line) ? 'add' : 'context', new: line })
  }
  return rows
}

function lineCount(text: string): number {
  if (!text) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

function lineText(text: string, line: number): string {
  return text.split('\n')[line - 1] ?? ''
}

/** How long the link to the next stop takes to draw, before that stop is told. */
const LINK_MS = 900
/** How long a stop shows before its voice begins, when no link draws to it. */
const SETTLE_MS = 350
/** The pause after a stop has been told. */
const AFTER_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

interface Playing {
  walk: Walkthrough
  at: WalkAt
  language?: Language
  pace?: number
  /** Grows with each control, so the play loop it replaces stops. */
  run: number
  spoken?: Spoken
}

/**
 * Plays each chat's walkthrough: shows a stop, has the voice say it, and moves
 * on once it is said, drawing the link to the next. Without the voice, a stop
 * stays as long as it takes to read. The user's controls stop the voice at once.
 */
export class WalkPlayer {
  private walks = new Map<string, Playing>()

  constructor(
    /** Say a stop's sentence; undefined when the voice is off. */
    private readonly say: (
      chatId: string,
      text: string,
      language?: Language,
      pace?: number
    ) => Spoken | undefined,
    /** Tell the window where a chat's walkthrough is. */
    private readonly tell: (chatId: string, at: WalkAt) => void
  ) {}

  start(chatId: string, walk: Walkthrough, language?: Language, pace?: number): void {
    this.halt(chatId)
    const playing: Playing = { walk, at: { index: 0, playing: true }, language, pace, run: 0 }
    this.walks.set(chatId, playing)
    void this.play(chatId, playing, 0)
  }

  /** The chat's walkthrough and where it is, if it has one. */
  current(chatId: string): { walk: Walkthrough; at: WalkAt } | undefined {
    const playing = this.walks.get(chatId)
    return playing && { walk: playing.walk, at: playing.at }
  }

  control(chatId: string, action: WalkControl, index?: number): void {
    const playing = this.walks.get(chatId)
    if (!playing) return
    const last = playing.walk.stops.length - 1
    const from =
      action === 'next'
        ? playing.at.index + 1
        : action === 'prev'
          ? playing.at.index - 1
          : action === 'goto'
            ? (index ?? playing.at.index)
            : // Play at the end starts over.
              action === 'play' && playing.at.index === last && !playing.at.playing
              ? 0
              : playing.at.index
    const to = Math.min(Math.max(from, 0), last)
    const on = action === 'play' || (action !== 'pause' && playing.at.playing)
    this.halt(chatId)
    if (on) {
      void this.play(chatId, playing, to)
    } else {
      playing.at = { index: to, playing: false }
      this.tell(chatId, playing.at)
    }
  }

  forget(chatId: string): void {
    this.halt(chatId)
    this.walks.delete(chatId)
  }

  /** Stop the play loop and the voice. */
  private halt(chatId: string): void {
    const playing = this.walks.get(chatId)
    if (!playing) return
    playing.run++
    playing.spoken?.stop()
    playing.spoken = undefined
  }

  private async play(chatId: string, playing: Playing, from: number): Promise<void> {
    const run = playing.run
    const { stops } = playing.walk
    for (let i = from; i < stops.length; i++) {
      playing.at = { index: i, playing: true }
      this.tell(chatId, playing.at)
      // The link to this stop draws first; the voice waits for it.
      await sleep(i > from && stops[i - 1].link ? LINK_MS : SETTLE_MS)
      if (playing.run !== run) return
      const spoken = this.say(chatId, stops[i].say, playing.language, playing.pace)
      playing.spoken = spoken
      if (spoken) await spoken.ended
      else await sleep(Math.max(2500, stops[i].say.length * 60))
      if (playing.run !== run) return
      playing.spoken = undefined
      if (i < stops.length - 1) await sleep(AFTER_MS)
      if (playing.run !== run) return
    }
    playing.at = { index: stops.length - 1, playing: false }
    this.tell(chatId, playing.at)
  }
}
