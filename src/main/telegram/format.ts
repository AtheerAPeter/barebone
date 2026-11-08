import { marked, type Token, type Tokens } from 'marked'
import type { ChatItem, ToolStatus } from '../../shared/types'
import {
  callKind,
  callVerb,
  category,
  groupSummary,
  isWebSearch,
  spokenText,
  toolKindAndTarget,
  type Category
} from '../../shared/tool-calls'
import { formatDuration } from '../chats-mcp'

/**
 * Text for Telegram: agents' Markdown turned into the HTML Telegram shows
 * (core.telegram.org/bots/api#html-style: b, i, s, code, pre, a, blockquote),
 * split to fit a message, and the cards that show what chats are doing.
 */

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** A message's most text: Telegram's limit is 4096 characters after the tags are taken out. */
const MAX_MESSAGE = 4000

/** Titles in cards are cut here, so a card stays a few lines. */
const MAX_TITLE = 90

/** A message, as HTML and as plain text, sent instead when Telegram cannot read the HTML. */
export interface OutText {
  html: string
  plain: string
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Text for an attribute's value, in double quotes. */
export function attribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;')
}

/** Text on one line, cut to `max` characters. */
export function cut(text: string, max = MAX_TITLE): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function inline(tokens: Token[] | undefined): string {
  return (tokens ?? []).map(inlineToken).join('')
}

function inlineToken(token: Token): string {
  switch (token.type) {
    case 'strong':
      return `<b>${inline((token as Tokens.Strong).tokens)}</b>`
    case 'em':
      return `<i>${inline((token as Tokens.Em).tokens)}</i>`
    case 'del':
      return `<s>${inline((token as Tokens.Del).tokens)}</s>`
    case 'codespan':
      return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`
    case 'link': {
      const link = token as Tokens.Link
      return `<a href="${attribute(link.href)}">${inline(link.tokens)}</a>`
    }
    case 'image': {
      const image = token as Tokens.Image
      return `<a href="${attribute(image.href)}">${escapeHtml(image.text || image.href)}</a>`
    }
    case 'br':
      return '\n'
    case 'text': {
      const text = token as Tokens.Text
      return text.tokens ? inline(text.tokens) : escapeHtml(text.text)
    }
    default:
      return escapeHtml('text' in token && typeof token.text === 'string' ? token.text : token.raw)
  }
}

function block(token: Token, indent = ''): string {
  switch (token.type) {
    case 'space':
      return ''
    case 'paragraph':
      return inline((token as Tokens.Paragraph).tokens)
    case 'heading':
      return `<b>${inline((token as Tokens.Heading).tokens)}</b>`
    case 'code': {
      const code = token as Tokens.Code
      const lang = code.lang?.match(/^[\w+-]+/)?.[0]
      return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(code.text)}</code></pre>`
    }
    case 'blockquote':
      return `<blockquote>${blocks((token as Tokens.Blockquote).tokens)}</blockquote>`
    case 'list': {
      const list = token as Tokens.List
      const start = typeof list.start === 'number' ? list.start : 1
      return list.items
        .map((item, i) => {
          const bullet = indent ? '◦' : '•'
          const mark = item.task
            ? item.checked
              ? '☑'
              : '☐'
            : list.ordered
              ? `${start + i}.`
              : bullet
          const [first, ...rest] = item.tokens
          // Telegram drops leading spaces; no-break spaces keep a nested list indented.
          const deeper = `${indent}\u00a0\u00a0\u00a0\u00a0`
          const lead = first ? block(first, deeper) : ''
          const more = rest.map((t) => block(t, deeper)).filter(Boolean)
          return [`${indent}${mark} ${lead}`, ...more].join('\n')
        })
        .join('\n')
    }
    case 'table': {
      // Telegram has no tables, and a phone is too narrow for columns: each row
      // is a line, led by its first cell, with the others named by their header.
      const table = token as Tokens.Table
      const head = table.header.map((cell) => inline(cell.tokens))
      return table.rows
        .map((row) => {
          const [first, ...rest] = row.map((cell) => inline(cell.tokens))
          const named = rest.map((cell, i) => (head[i + 1] ? `${head[i + 1]}: ${cell}` : cell))
          return [`• <b>${first ?? ''}</b>`, ...named].join(' · ')
        })
        .join('\n')
    }
    case 'hr':
      return '──────────'
    case 'text': {
      const text = token as Tokens.Text
      return text.tokens ? inline(text.tokens) : escapeHtml(text.text)
    }
    default:
      return escapeHtml(token.raw.trim())
  }
}

function blocks(tokens: Token[]): string {
  return tokens
    .map((t) => block(t))
    .filter(Boolean)
    .join('\n\n')
}

/** Text in pieces that each fit a message, split at line ends where it can be. */
function pieces(text: string, max = MAX_MESSAGE): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const end = rest.lastIndexOf('\n', max)
    const at = end > max / 2 ? end : max
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  if (rest.trim()) out.push(rest)
  return out
}

/** Plain text as messages, split to fit. */
export function plainMessages(text: string): OutText[] {
  return pieces(text.trim()).map((piece) => ({ html: escapeHtml(piece), plain: piece }))
}

/**
 * An agent's Markdown as messages: its blocks are packed into messages that
 * fit, and a block too long for one (a long code block) is split on its own.
 */
export function markdownMessages(markdown: string): OutText[] {
  const out: OutText[] = []
  let html = ''
  let plain = ''
  const flush = (): void => {
    if (html.trim()) out.push({ html: html.trim(), plain: plain.trim() })
    html = ''
    plain = ''
  }
  for (const token of marked.lexer(markdown)) {
    const part = block(token)
    if (!part) continue
    if (part.length > MAX_MESSAGE) {
      flush()
      const raw = token.type === 'code' ? (token as Tokens.Code).text : token.raw.trim()
      for (const piece of pieces(raw, MAX_MESSAGE - 30)) {
        out.push({
          html: token.type === 'code' ? `<pre>${escapeHtml(piece)}</pre>` : escapeHtml(piece),
          plain: piece
        })
      }
      continue
    }
    if (html && html.length + part.length + 2 > MAX_MESSAGE) flush()
    html += `${html ? '\n\n' : ''}${part}`
    plain += `${plain ? '\n\n' : ''}${token.raw.trim()}`
  }
  flush()
  return out
}

/** How a chat a card shows is doing. */
export type CardState = 'working' | 'waiting' | 'done' | 'failed' | 'stopped' | 'deleted' | 'idle'

const MARKS: Record<CardState, string> = {
  working: '🟢',
  waiting: '🟡',
  done: '✅',
  failed: '🔴',
  stopped: '⏹',
  deleted: '🗑',
  idle: '⚪'
}

const SUBAGENT_STATUS: Record<ToolStatus, string> = {
  pending: 'starting',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed',
  interrupted: 'stopped'
}

/**
 * Each kind of call's icon. Telegram has no colored text, so these emoji are
 * what tells reads, edits and commands apart at a glance, as the chat view's
 * icons do.
 */
const KIND_ICONS: Record<Category, string> = {
  tool: '🔧',
  read: '📖',
  edit: '✏️',
  run: '💻',
  fetch: '🌐',
  browser: '🧭',
  device: '📱',
  chats: '💬'
}

/** A list of calls shows the latest this many, and how many came before. */
const MAX_LISTED_CALLS = 40

/** What a chat did on its current task, or the linked chat between two of its answers. */
export interface Progress {
  /** How long it has worked on it. */
  elapsedMs?: number
  /** Its calls, oldest first, its subagents among them. */
  calls: ToolItem[]
}

const running = (tool: ToolItem): boolean =>
  tool.status === 'pending' || tool.status === 'in_progress'

/** A call's mark: how it is going while it runs or when it went wrong, else its kind's icon. */
function callMark(tool: ToolItem): string {
  if (running(tool)) return '⏳'
  if (tool.status === 'failed') return '❌'
  if (tool.status === 'interrupted') return '⏹'
  if (spokenText(tool) !== undefined) return '🗣'
  if (callKind(tool) === 'search' || isWebSearch(tool)) return '🔍'
  return KIND_ICONS[category(tool)]
}

/** One call in the chat view's words: "Ran npm test", "Reading src/a.ts". */
function callLine(tool: ToolItem): string {
  const [done, doing] = callVerb(tool)
  const [, target] = toolKindAndTarget(tool)
  return cut(`${running(tool) ? doing : done} ${target}`, 100)
}

/** Every call as a list, folded into a quote that opens on a tap. */
function callList(calls: ToolItem[]): string[] {
  if (calls.length === 0) return []
  const shown = calls.slice(-MAX_LISTED_CALLS)
  const lines = shown.map((t) => `${callMark(t)} ${escapeHtml(callLine(t))}`)
  if (calls.length > shown.length) lines.unshift(`<i>${calls.length - shown.length} earlier</i>`)
  return [`<blockquote expandable>${lines.join('\n')}</blockquote>`]
}

/** What a run of calls did, as the chat view sums it up: "Read files, ran commands". */
function summary(calls: ToolItem[], elapsedMs: number | undefined): string {
  const failed = calls.filter((t) => t.status === 'failed').length
  return [
    calls.length > 0 ? groupSummary(calls) : undefined,
    elapsedMs !== undefined ? formatDuration(elapsedMs) : undefined,
    failed > 0 ? `${failed} failed` : undefined
  ]
    .filter(Boolean)
    .join(' · ')
}

function subagentLines(subagents: ToolItem[]): string[] {
  return subagents.map(
    (s) => `🤖 <b>${escapeHtml(cut(s.title, 70))}</b> · ${SUBAGENT_STATUS[s.status]}`
  )
}

function split(progress: Progress): { calls: ToolItem[]; subagents: ToolItem[] } {
  return {
    calls: progress.calls.filter((t) => t.toolKind !== 'agent'),
    subagents: progress.calls.filter((t) => t.toolKind === 'agent')
  }
}

/**
 * The card of a chat the linked chat started: its state, what it runs on,
 * what it is doing, its subagents, and its calls folded underneath. `waiting`
 * is what it asks the user, while it does.
 */
export function workerCard(view: {
  title: string
  runsOn: string
  state: CardState
  progress: Progress
  waiting?: string
  error?: string
}): string {
  const { progress, state } = view
  const { calls, subagents } = split(progress)
  const status: Record<CardState, string> = {
    working: 'working',
    waiting: 'waiting for you',
    done: 'done',
    failed: 'failed',
    stopped: 'stopped',
    deleted: 'done, chat deleted',
    idle: 'idle'
  }
  const time = progress.elapsedMs !== undefined ? ` ${formatDuration(progress.elapsedMs)}` : ''
  const meta = [view.runsOn, `${status[state]}${time}`].filter(Boolean)
  const lines = [
    `${MARKS[state]} <b>${escapeHtml(cut(view.title))}</b>`,
    `<i>${escapeHtml(meta.join(' · '))}</i>`
  ]
  if (view.waiting) lines.push(`Asks: <b>${escapeHtml(cut(view.waiting, 200))}</b>`)
  const now = state === 'working' ? calls.findLast(running) : undefined
  if (now) lines.push(`⏳ <b>${escapeHtml(callLine(now))}</b>`)
  if (calls.length > 0) lines.push(escapeHtml(summary(calls, undefined)))
  lines.push(...subagentLines(subagents), ...callList(calls))
  if (view.error) lines.push(`Error: ${escapeHtml(cut(view.error, 300))}`)
  return lines.join('\n')
}

/**
 * The calls the linked chat makes between two of its answers, as one message
 * that keeps up with them: what it is doing now, what the calls did so far,
 * and the calls folded underneath. Once its turn ends, the summary leads.
 */
export function stepsMessage(progress: Progress, ended: boolean): string {
  const { calls, subagents } = split(progress)
  const sum = summary(calls, progress.elapsedMs) || 'Working'
  const now = ended ? undefined : calls.findLast(running)
  const failed = calls.some((t) => t.status === 'failed')
  const head = ended
    ? `${failed ? '⚠️' : '✅'} <b>${escapeHtml(sum)}</b>`
    : `⏳ <b>${escapeHtml(now ? callLine(now) : 'Working')}</b>\n<i>${escapeHtml(sum)}</i>`
  return [head, ...subagentLines(subagents), ...callList(calls)].join('\n')
}
