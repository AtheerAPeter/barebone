import { net, protocol, type CustomScheme } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { botColor } from '../shared/colors'
import {
  BOT_SCHEME,
  type BotShape,
  type Chat,
  type Project,
  type ProjectColor
} from '../shared/types'
import * as store from './store'

/**
 * Bots: projects a chat makes for an ongoing job, such as applying for jobs
 * or looking for a flat. Each has a folder of its own, made here, with
 * AGENTS.md saying who it is and how it keeps its folder: what it learns in
 * memory.md, its records in data/, and dashboard.html, a page it writes that
 * shows them. The window shows that page in the bot's chat, loaded from the
 * folder with the bot: scheme (or through the remote link, see
 * remote/server.ts); nothing on it can reach outside the folder.
 */

/** Where bots' folders are made: a place the user can find them, outside the app's own data. */
export const BOTS_DIR = join(homedir(), 'Barebone', 'Bots')

export const DASHBOARD = 'dashboard.html'
export const MEMORY = 'memory.md'
/** Barebone's look for a dashboard, made for each bot (see stylesheet); no file of the folder. */
export const STYLESHEET = '_barebone.css'

/** A bot's name, as the user would say it; also its folder's name. */
const MAX_NAME = 40

export interface NewBot {
  name: string
  job: string
  /** Who it is: how it talks and behaves, in the chat's words. */
  personality: string
  /** What it does and how, for its AGENTS.md: the user's wishes, in the chat's words. */
  instructions: string
  shape: BotShape
  color: ProjectColor
}

/** The bot's AGENTS.md: who it is, its job, and how it keeps its folder. */
function agentsFile(bot: NewBot, path: string): string {
  return `# ${bot.name}

You are ${bot.name}, a bot the user made in Barebone. Your job: ${bot.job}.

## Who you are

${bot.personality.trim()}

Stay this character the whole time: talk as yourself, in the first person, the way a person who does this job for the user would. You are not a general assistant, and you need not say you are an AI unless asked.

## Your job

${bot.instructions.trim()}

## One conversation

The user has one conversation with you, which goes on for good: they come back to it whenever there is something to do, as they would message a person. When it grows long, it is shortened behind the scenes, or goes on in a fresh session, and the older messages are gone from what you see. \`${MEMORY}\` is what carries over. So read it before you answer at the start and whenever earlier messages seem missing, and keep it up to date as you go, with anything you would need to know next week.

## Routines

When the user asks for regular work ("every weekday at 8, look for new jobs"), set a routine with set_routine: a note of what to do, and when. list_routines shows yours, and cancel_routine ends one. Each run arrives in this conversation as a message with your note. Do the work then, and start your answer with one line saying what came of it: when the user is away, Barebone shows that line in a notification.

## Your folder

Everything you keep goes in this folder (${path}). Work from here.

- \`${MEMORY}\` is what you know about the user and the work. When you learn something that will matter later (a preference, a rule, a decision, a site that worked or did not, where a task stands), add it as one short line, and tell the user in one line what you added. Take a line out once it is wrong.
- \`data/\` holds your records as JSON files: what you found, what you did and what you wait on. Update them as you go, not only at the end. You and your dashboard read them.
- \`files/\` holds documents: the ones the user gives you and the ones you write for them.
- \`${DASHBOARD}\` shows your work to the user. Barebone shows it under Dashboard, next to your chat. Make it once you have something to show, and change it when the user asks or what you keep track of changes.

## Your dashboard

It shows in Barebone, in your chat's place, on your color, so it should look like part of Barebone:

- Link Barebone's stylesheet first: \`<link rel="stylesheet" href="${STYLESHEET}">\`. It gives the page Barebone's font, text and line colors and your color, in light and dark mode, and leaves the background clear so your pane shows through. Barebone serves it; it is no file in your folder.
- Style with its variables rather than colors of your own: \`--text\`, \`--text-soft\`, \`--text-muted\`, \`--accent\` (your color), \`--accent-text\`, \`--accent-soft\`, \`--border\`, \`--card\`, \`--card-edge\`, \`--hover\`, \`--ok\`, \`--warn\`, \`--danger\`, \`--radius\`, \`--radius-lg\`, \`--radius-pill\`, \`--font\`, \`--mono\`. The class \`card\` is a panel as Barebone draws one, and \`muted\` quiet text. The page then follows light and dark mode by itself.
- Past that, lay it out however suits your job: tables, cards, counts, lists, charts.
- One HTML file with its own styles and scripts. It cannot load anything from the internet, only files in this folder.
- It reads your records with \`fetch('data/<name>.json')\` and shows them. Keep the data in \`data/\`, not in the page.
- It fits a pane 700 to 1000 pixels wide.
- It only shows; it does not change your records.
- Links to web pages are plain links (no \`target\`): Barebone opens them in your browser panel.
- Barebone reloads it whenever the page or your records change.

## Before anything goes out

Before you send, submit, post, pay or sign up for anything in the user's name, ask them with ask_approval, unless your job above or \`${MEMORY}\` says they allowed it. Give it a short question that names what goes out and where ("Send the application to N26?") and, as details, the draft in full, exactly as it will go out: the letter or message and who it goes to, or for an order what, how much and to whom. Then do as they answer:

- Send: send it exactly as shown, right away.
- Change: revise it as they say, and ask again with the new draft.
- Skip: leave it, and note in \`${MEMORY}\` if it tells you something for next time.

If they have not answered yet, end your turn: their answer comes to you as a message. In the browser, Barebone refuses a click on a send button (Send, Submit, Apply, Pay, Bewerben, Absenden and the like) until the user has answered Send in the last 10 minutes, so ask there every time.
`
}

/** A folder name for the bot: its name, without what a folder name cannot have, made unique. */
function freeFolder(name: string): string {
  const base =
    name
      .replace(/[/\\:]/g, '-')
      .replace(/^\.+/, '')
      .trim() || 'Bot'
  let path = join(BOTS_DIR, base)
  for (let n = 2; existsSync(path); n++) path = join(BOTS_DIR, `${base} ${n}`)
  return path
}

/** Make a bot: its folder, with its instructions and an empty memory, and its project. */
export function createBot(bot: NewBot): Project {
  const name = bot.name.trim()
  if (!name) throw new Error('"name" is empty.')
  if (name.length > MAX_NAME) throw new Error(`"name" is longer than ${MAX_NAME} characters.`)
  if (!bot.job.trim()) throw new Error('"job" is empty.')
  const path = freeFolder(name)
  mkdirSync(join(path, 'data'), { recursive: true })
  mkdirSync(join(path, 'files'), { recursive: true })
  const look = { ...bot, name, job: bot.job.trim() }
  writeFileSync(join(path, 'AGENTS.md'), agentsFile(look, path))
  // Claude Code reads CLAUDE.md, which takes in AGENTS.md; the other agents read AGENTS.md.
  writeFileSync(join(path, 'CLAUDE.md'), '@AGENTS.md\n')
  writeFileSync(join(path, MEMORY), `# What ${name} knows\n`)
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    path,
    createdAt: Date.now(),
    color: bot.color,
    bot: { shape: bot.shape, job: look.job }
  }
  store.addProject(project)
  return project
}

function botProject(projectId: string): Project | undefined {
  return store.getState().projects.find((p) => p.id === projectId && p.bot)
}

/**
 * Whether a chat is a bot's one conversation: the oldest one in its project
 * the user started, as the window opens it (see openBot).
 */
export function isBotConversation(chatId: string): boolean {
  const { projectId } = store.getChat(chatId)
  if (!botProject(projectId)) return false
  const conversation = store
    .getState()
    .chats.filter((c) => c.projectId === projectId && !c.startedBy)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  return conversation?.id === chatId
}

/** A bot's conversation goes on in a fresh session once its context is this full. */
export const RENEW_AT = 0.8

/** What a fresh session is shown of the conversation: its last messages, each and all cut to size. */
const RECENT_MESSAGES = 10
const RECENT_MESSAGE_CHARS = 1500
const RECENT_CHARS = 8000

/**
 * Told with the first message of a bot's fresh session (see
 * AgentManager.renewIfFull): that the conversation goes on, where what the
 * bot knows is kept, and the last messages before `current`, the message it
 * answers, so it can pick up where it left off.
 */
export function renewalNote(chatId: string, current: string): string {
  const project = store.getProject(store.getChat(chatId).projectId)
  const items = store.getMessages(chatId)
  const end = items.findIndex((i) => i.id === current)
  const said: { who: string; text: string }[] = []
  for (const item of items.slice(0, end < 0 ? items.length : end)) {
    if (item.kind !== 'user' && item.kind !== 'text') continue
    const text = item.text.trim()
    if (!text) continue
    // Wakes and other chats' messages come through Barebone, not from the user.
    const who = item.kind === 'text' ? project.name : item.from ? 'Barebone' : 'User'
    const last = said.at(-1)
    // An answer's parts between its tool calls read as one.
    if (item.kind === 'text' && last?.who === who) last.text += `\n\n${text}`
    else said.push({ who, text })
  }
  const recent: string[] = []
  let chars = 0
  for (const { who, text } of said.slice(-RECENT_MESSAGES).reverse()) {
    const cut =
      text.length > RECENT_MESSAGE_CHARS ? `${text.slice(0, RECENT_MESSAGE_CHARS)} […]` : text
    const line = `${who}: ${cut}`
    if (recent.length > 0 && chars + line.length > RECENT_CHARS) break
    recent.unshift(line)
    chars += line.length
  }
  return [
    `(This is your ongoing conversation with the user, continued in a fresh session because the old one grew long, so you do not have the earlier messages. Before you answer, read ${join(project.path, MEMORY)} and your records in ${join(project.path, 'data')}. The whole conversation so far is saved in ${store.chatFile(chatId)}: search it when you need something from earlier.${recent.length > 0 ? ' The last messages before this one:)' : ')'}`,
    ...recent,
    '(The new message:)'
  ].join('\n\n')
}

/**
 * A bot's one conversation: its oldest chat that no other chat started, as the
 * window opens it; undefined until the user first opens the bot.
 */
export function botConversation(projectId: string): Chat | undefined {
  if (!botProject(projectId)) return undefined
  return store
    .getState()
    .chats.filter((c) => c.projectId === projectId && !c.startedBy)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

/**
 * Where a file a bot's dashboard asks for is, inside the bot's folder;
 * undefined when it is not there, or the path leads out of the folder (by
 * `..` or a link).
 */
export async function botFile(projectId: string, file: string): Promise<string | undefined> {
  const project = botProject(projectId)
  if (!project || file.includes('\0')) return undefined
  const path = resolve(project.path, file)
  if (!path.startsWith(project.path + sep)) return undefined
  try {
    const [root, real] = await Promise.all([realpath(project.path), realpath(path)])
    if (!real.startsWith(root + sep) || !(await stat(real)).isFile()) return undefined
    return real
  } catch {
    return undefined
  }
}

/** Whether a bot has made its dashboard yet. */
export function hasDashboard(projectId: string): boolean {
  const project = botProject(projectId)
  return Boolean(project && existsSync(join(project.path, DASHBOARD)))
}

/** What a bot knows, from its memory.md; null when it has none. */
export async function memory(projectId: string): Promise<string | null> {
  const path = await botFile(projectId, MEMORY)
  return path ? readFile(path, 'utf8') : null
}

/**
 * Call `changed` when anything in a bot's folder changes, at most every 300 ms,
 * until the returned function stops it.
 */
export function watchBot(projectId: string, changed: () => void): () => void {
  const project = botProject(projectId)
  if (!project) return () => undefined
  let timer: NodeJS.Timeout | undefined
  const watcher = watch(project.path, { recursive: true }, () => {
    timer ??= setTimeout(() => {
      timer = undefined
      changed()
    }, 300)
  })
  // A folder removed while watched ends the watch; the bot's pane shows it is gone.
  watcher.on('error', () => watcher.close())
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
}

export function botFileType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Barebone's look for a bot's dashboard (STYLESHEET): the window's own tokens
 * (renderer/src/styles.css), with the bot's color as the accent, in light and
 * dark mode, and a few base styles. The page's background stays clear, so the
 * bot's tinted pane shows through.
 */
export function stylesheet(projectId: string): string | undefined {
  const project = botProject(projectId)
  if (!project) return undefined
  const accent = botColor(project)
  return `/* Barebone's look for ${project.name}'s dashboard. Made by Barebone; changes here are not kept. */
:root {
  color-scheme: light dark;
  --accent: ${accent};
  --accent-text: color-mix(in oklab, ${accent} 78%, black);
  --accent-soft: color-mix(in srgb, ${accent} 14%, transparent);
  --text: #0d0d0d;
  --text-soft: #5d5d5d;
  --text-muted: #737373;
  --border: rgba(0, 0, 0, 0.1);
  --border-strong: rgba(0, 0, 0, 0.2);
  --card: rgba(255, 255, 255, 0.55);
  --card-edge: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 0 0 0.5px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  --hover: rgba(0, 0, 0, 0.04);
  --ok: #12814a;
  --warn: #b54708;
  --danger: #d92d20;
  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 16px;
  --radius-pill: 999px;
  --font: ui-sans-serif, -apple-system, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif;
  --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --accent-text: color-mix(in oklab, ${accent} 70%, white);
    --accent-soft: color-mix(in srgb, ${accent} 22%, transparent);
    --text: #ededed;
    --text-soft: #afafaf;
    --text-muted: #8f8f8f;
    --border: rgba(255, 255, 255, 0.1);
    --border-strong: rgba(255, 255, 255, 0.2);
    --card: rgba(255, 255, 255, 0.07);
    --card-edge: inset 0 1px 0 rgba(255, 255, 255, 0.14), inset 0 0 0 0.5px rgba(255, 255, 255, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3);
    --hover: rgba(255, 255, 255, 0.05);
    --ok: #4cc38a;
    --warn: #e7a14a;
    --danger: #ff6b64;
  }
}
html {
  background: transparent;
}
body {
  margin: 0;
  padding: 16px 28px 32px;
  font: 14px/1.5 var(--font);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
h1 {
  margin: 0 0 4px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
h2 {
  margin: 24px 0 8px;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
h3 {
  margin: 16px 0 6px;
  font-size: 14px;
  font-weight: 600;
}
a {
  color: var(--accent-text);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th {
  padding: 6px 12px 6px 0;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
}
td {
  padding: 8px 12px 8px 0;
  border-top: 0.5px solid var(--border);
}
code {
  font-family: var(--mono);
  font-size: 12.5px;
}
.card {
  padding: 14px 16px;
  background: var(--card);
  border-radius: var(--radius-lg);
  box-shadow: var(--card-edge);
}
.muted {
  color: var(--text-muted);
}
`
}

/**
 * What a dashboard may load: its own folder's files, inline scripts and
 * styles in it, and nothing from anywhere else.
 */
export const DASHBOARD_POLICY =
  "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'"

const DASHBOARD_HEADERS = {
  'Content-Security-Policy': DASHBOARD_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
}

/** Must be registered before the app is ready, with the app's other schemes. */
export const botScheme: CustomScheme = {
  scheme: BOT_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true }
}

/**
 * Serve bots' folders to the window as bot://<project id>/<file>. Each bot is
 * an origin of its own, apart from the window's, so a dashboard cannot reach
 * the app or another bot's files. Only the window's session has the scheme;
 * the browser panel's pages do not.
 */
export function handleBotRequests(): void {
  protocol.handle(BOT_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url)
    const file = decodeURIComponent(pathname.slice(1))
    const css = file === STYLESHEET ? stylesheet(host) : undefined
    if (css)
      return new Response(css, { headers: { ...DASHBOARD_HEADERS, 'Content-Type': TYPES['.css'] } })
    const path = await botFile(host, file)
    if (!path) return new Response('Not found.', { status: 404 })
    const body = await net.fetch(pathToFileURL(path).href)
    return new Response(body.body, {
      headers: { ...DASHBOARD_HEADERS, 'Content-Type': botFileType(path) }
    })
  })
}

/**
 * How long a dashboard's key for the remote link works. The page asks for a
 * new one each time it shows the dashboard, so this only needs to outlast a look.
 */
const KEY_MS = 2 * 60 * 60 * 1000

/** A key's bot, and the paired session it was given to (see remoteKey). */
export interface DashboardKey {
  projectId: string
  sessionId: string
}

/** Keys the remote link's pages load dashboards with, as a page has no cookie there (see remoteKey). */
const keys = new Map<string, DashboardKey & { expires: number }>()

/**
 * A key for a page of the remote link to load a bot's folder with, as
 * /bot/<key>/<file>. The dashboard runs sandboxed there, in an origin of its
 * own, so it is sent no cookie: the key, given only to a paired page, is what
 * lets it in. It is kept with that page's session, so signing the device out
 * ends its keys too (the server checks, see remote/server.ts).
 */
export function remoteKey(projectId: string, sessionId: string): string {
  const now = Date.now()
  for (const [key, entry] of keys) if (entry.expires < now) keys.delete(key)
  const key = randomBytes(16).toString('hex')
  keys.set(key, { projectId, sessionId, expires: now + KEY_MS })
  return key
}

/** The bot and session a remote page's key is for; undefined for an unknown or expired key. */
export function keyedBot(key: string): DashboardKey | undefined {
  const entry = keys.get(key)
  if (!entry || entry.expires < Date.now()) return undefined
  return { projectId: entry.projectId, sessionId: entry.sessionId }
}
