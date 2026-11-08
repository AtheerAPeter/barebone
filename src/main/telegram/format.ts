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
 * Text for Telegram: agents' Markdown turned into the HTML Telegram shows,
 * split to fit a message, and the cards and steps messages that show what
 * chats are doing. Answers come as rich messages
 * (core.telegram.org/bots/api#rich-html-style: headings, tables, lists);
 * where Telegram refuses one, in the plainer HTML every message takes
 * (#html-style: b, i, s, code, pre, a, blockquote).
 */

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** A message's most text: Telegram's limit is 4096 characters after the tags are taken out. */
const MAX_MESSAGE = 4000

/**
 * A rich message's most text and blocks: Telegram allows 32768 characters and
 * 500 blocks (#rich-message-limits). This counts tags as text, so it stays under.
 */
const RICH_MAX = 30000
const RICH_MAX_BLOCKS = 450

/** A table's most columns in a rich message. */
const RICH_MAX_COLUMNS = 20

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

/** Inline Markdown as HTML; a line break is `<br>` in a rich message, a newline elsewhere. */
function inline(tokens: Token[] | undefined, rich = false): string {
  return (tokens ?? []).map((t) => inlineToken(t, rich)).join('')
}

function inlineToken(token: Token, rich: boolean): string {
  switch (token.type) {
    case 'strong':
      return `<b>${inline((token as Tokens.Strong).tokens, rich)}</b>`
    case 'em':
      return `<i>${inline((token as Tokens.Em).tokens, rich)}</i>`
    case 'del':
      return `<s>${inline((token as Tokens.Del).tokens, rich)}</s>`
    case 'codespan':
      return `<code>${escapeHtml((token as Tokens.Codespan).text)}</code>`
    case 'link': {
      const link = token as Tokens.Link
      return `<a href="${attribute(link.href)}">${inline(link.tokens, rich)}</a>`
    }
    case 'image': {
      const image = token as Tokens.Image
      return `<a href="${attribute(image.href)}">${escapeHtml(image.text || image.href)}</a>`
    }
    case 'br':
      return rich ? '<br>' : '\n'
    case 'text': {
      const text = token as Tokens.Text
      return text.tokens ? inline(text.tokens, rich) : escapeHtml(text.text)
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
          // A task's box is a token of its own: the mark above shows it.
          const [first, ...rest] = item.tokens.filter((t) => t.type !== 'checkbox')
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

// --- Rich messages -----------------------------------------------------------

/** A block of a rich message, and how many blocks Telegram counts in it. */
interface RichPart {
  html: string
  blocks: number
}

function richCode(code: Tokens.Code, text = code.text): string {
  const lang = code.lang?.match(/^[\w+-]+/)?.[0]
  return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(text)}</code></pre>`
}

/** A paragraph's or a text's inline Markdown as rich HTML. */
function richInline(token: Token): string {
  const { tokens, text } = token as Tokens.Text
  return tokens ? inline(tokens, true) : escapeHtml(text ?? token.raw.trim())
}

function richList(list: Tokens.List): RichPart {
  let blocks = 1
  const items = list.items.map((item) => {
    blocks++
    let html = item.task ? `<input type="checkbox"${item.checked ? ' checked' : ''}>` : ''
    let inlineBefore = false
    for (const token of item.tokens) {
      if (token.type === 'checkbox' || token.type === 'space') continue
      if (token.type === 'list') {
        const nested = richList(token as Tokens.List)
        blocks += nested.blocks
        html += nested.html
        inlineBefore = false
      } else if (token.type === 'code') {
        blocks++
        html += richCode(token as Tokens.Code)
        inlineBefore = false
      } else {
        // The paragraphs of a loose list's item, a line apart.
        html += `${inlineBefore ? '<br>' : ''}${richInline(token)}`
        inlineBefore = true
      }
    }
    return `<li>${html}</li>`
  })
  const tag = list.ordered ? 'ol' : 'ul'
  const start =
    list.ordered && typeof list.start === 'number' && list.start !== 1
      ? ` start="${list.start}"`
      : ''
  return { html: `<${tag}${start}>${items.join('')}</${tag}>`, blocks }
}

function richTable(table: Tokens.Table): RichPart {
  const cells = (row: Tokens.TableCell[], tag: 'th' | 'td'): string =>
    row
      .slice(0, RICH_MAX_COLUMNS)
      .map((cell, i) => {
        const align = table.align[i] ? ` align="${table.align[i]}"` : ''
        return `<${tag}${align}>${inline(cell.tokens, true)}</${tag}>`
      })
      .join('')
  const rows = [
    `<tr>${cells(table.header, 'th')}</tr>`,
    ...table.rows.map((row) => `<tr>${cells(row, 'td')}</tr>`)
  ]
  return { html: `<table bordered>${rows.join('')}</table>`, blocks: rows.length + 1 }
}

/** A block of Markdown as rich HTML. Raw HTML in it is shown as text, never read as tags. */
function richBlock(token: Token): RichPart | undefined {
  switch (token.type) {
    case 'space':
      return undefined
    case 'paragraph':
      return { html: `<p>${richInline(token)}</p>`, blocks: 1 }
    case 'heading': {
      const heading = token as Tokens.Heading
      // A phone's screen is narrow: the largest sizes would take it over.
      const level = Math.min(heading.depth + 2, 6)
      return { html: `<h${level}>${inline(heading.tokens, true)}</h${level}>`, blocks: 1 }
    }
    case 'code':
      return { html: richCode(token as Tokens.Code), blocks: 1 }
    case 'blockquote': {
      const lines = (token as Tokens.Blockquote).tokens
        .map((t) => (t.type === 'paragraph' || t.type === 'text' ? richInline(t) : ''))
        .filter(Boolean)
      return lines.length
        ? { html: `<blockquote>${lines.join('<br><br>')}</blockquote>`, blocks: 1 }
        : undefined
    }
    case 'list':
      return richList(token as Tokens.List)
    case 'table':
      return richTable(token as Tokens.Table)
    case 'hr':
      return { html: '<hr/>', blocks: 1 }
    default: {
      const raw = token.raw.trim()
      return raw ? { html: `<p>${escapeHtml(raw)}</p>`, blocks: 1 } : undefined
    }
  }
}

/** Markdown as rich HTML blocks; one too long for a message (a long log) is split. */
function richParts(markdown: string): RichPart[] {
  const parts: RichPart[] = []
  for (const token of marked.lexer(markdown)) {
    const part = richBlock(token)
    if (!part) continue
    if (part.html.length <= RICH_MAX / 2) {
      parts.push(part)
      continue
    }
    const code = token.type === 'code' ? (token as Tokens.Code) : undefined
    for (const piece of pieces(code ? code.text : token.raw.trim(), RICH_MAX / 4)) {
      parts.push({ html: code ? richCode(code, piece) : `<p>${escapeHtml(piece)}</p>`, blocks: 1 })
    }
  }
  return parts
}

/** Blocks packed into as few rich messages as fit them. */
function pack(parts: RichPart[]): string[] {
  const out: string[] = []
  let html = ''
  let blocks = 0
  for (const part of parts) {
    if (
      html &&
      (html.length + part.html.length > RICH_MAX || blocks + part.blocks > RICH_MAX_BLOCKS)
    ) {
      out.push(html)
      html = ''
      blocks = 0
    }
    html += part.html
    blocks += part.blocks
  }
  if (html) out.push(html)
  return out
}

/**
 * An agent's Markdown as rich messages (core.telegram.org/bots/api#rich-html-style):
 * headings, tables, lists and code as Telegram shows them, packed into as few
 * messages as fit.
 */
export function richMessages(markdown: string): string[] {
  return pack(richParts(markdown))
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

/** What a chat a card shows did on its current task. */
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
 * The card of a chat another chat started: its state, what it runs on,
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
 * The calls a chat makes between two of its messages, as one message that
 * keeps up with them: what it is doing now, what the calls did so far, and
 * the calls folded underneath. Once they end, the summary leads.
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
