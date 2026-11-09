import type { ChatItem } from './types'

/**
 * How tool calls are put into words, the way Codex does: the verb and what a
 * call acted on ("Ran npm test", "Tapped “Sign in”"), and what a run of calls
 * did ("Read files, ran commands"). The chat view and the Telegram bot
 * (main/telegram) both describe calls with these.
 */

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

export const BROWSER_TOOL = /^(?:mcp__)?harness_browser_{1,2}(\w+)/
/** The speak tool (chats-mcp.ts), under the names agents give MCP tools. */
const SPEAK_TOOL = /^(?:mcp__)?harness_chats_{1,2}speak$/

/** The app's own MCP servers (devices-mcp.ts, browser-mcp.ts, chats-mcp.ts). */
export type Harness = 'devices' | 'browser' | 'chats'
const HARNESS_TOOL = /^(?:mcp__)?harness_(devices|browser|chats)_{1,2}(\w+)/

/** Which of the app's own servers a call went to, and the tool's name there. */
export function harnessTool(tool: ToolItem): { server: Harness; name: string } | undefined {
  const match = tool.title.match(HARNESS_TOOL)
  return match ? { server: match[1] as Harness, name: match[2] } : undefined
}

/** The device and chats tools' verbs, finished and in progress. The browser has its own. */
const HARNESS_VERBS: Partial<Record<Harness, Record<string, [string, string]>>> = {
  devices: {
    devices: ['Checked the devices', 'Checking the devices'],
    screen: ['Looked at the screen', 'Looking at the screen'],
    tap: ['Tapped', 'Tapping'],
    swipe: ['Swiped', 'Swiping'],
    type: ['Typed', 'Typing'],
    press: ['Pressed', 'Pressing'],
    wait_for: ['Waited for', 'Waiting for'],
    app: ['Used the app', 'Using the app'],
    settings: ['Changed device settings', 'Changing device settings'],
    logs: ['Read the logs', 'Reading the logs'],
    metro: ['Metro', 'Metro']
  },
  chats: {
    start_chat: ['Started a chat', 'Starting a chat'],
    list_chats: ['Listed the chats', 'Listing the chats'],
    list_models: ['Listed the models', 'Listing the models'],
    send_message: ['Messaged a chat', 'Messaging a chat'],
    delete_chat: ['Deleted a chat', 'Deleting a chat'],
    run_in_background: ['Started in the background', 'Starting in the background'],
    list_background: ['Listed background commands', 'Listing background commands'],
    read_background: ['Read a background command', 'Reading a background command'],
    stop_background: ['Stopped a background command', 'Stopping a background command'],
    set_timer: ['Set a timer', 'Setting a timer'],
    cancel_timer: ['Cancelled a timer', 'Cancelling a timer'],
    create_bot: ['Made a bot', 'Making a bot']
  }
}

/** What a device or chats call acted on: the element tapped, the text typed, the task given. */
function harnessTarget(server: Harness, name: string, input: Record<string, unknown>): string {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value.replace(/\s+/g, ' ').trim() : undefined
  const quoted = (value: unknown): string | undefined => text(value) && `“${text(value)}”`
  const element =
    quoted(input.text) ??
    text(input.ref) ??
    (typeof input.x === 'number' ? `at ${input.x}, ${input.y}` : undefined)
  const parts =
    server === 'devices'
      ? {
          tap: [element],
          swipe: [text(input.direction), element && `from ${element}`],
          type: [quoted(input.value)],
          press: [text(input.button)],
          wait_for: [quoted(input.text), input.gone ? 'to go' : undefined],
          devices: [text(input.action), text(input.device)],
          app: [text(input.action), text(input.url) ?? text(input.app)],
          metro: [text(input.action)]
        }[name]
      : {
          start_chat: [text(input.prompt)],
          send_message: [text(input.message)],
          run_in_background: [text(input.command)],
          set_timer: [text(input.note)],
          create_bot: [quoted(input.name)]
        }[name]
  const target = (parts ?? []).filter(Boolean).join(' ')
  return target.length > 120 ? `${target.slice(0, 119)}…` : target
}

/** What an agent said out loud with the speak tool; undefined for any other call. */
export function spokenText(tool: ToolItem): string | undefined {
  if (!SPEAK_TOOL.test(tool.title.split(':')[0].trim())) return undefined
  try {
    const { text } = JSON.parse(tool.input ?? '{}') as { text?: unknown }
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/**
 * A short name for a tool call: drops arguments (agents put them after ":") and
 * MCP server prefixes, e.g. "harness_browser__click: {...}" -> "Browser · click",
 * and the app's own agent's "mcp__github__create_issue" -> "Github · Create issue".
 */
export function toolLabel(title: string): string {
  const name = title.split(':')[0].trim()
  const mcp = name.match(/^mcp__(.+?)__(.+)$/) ?? name.match(/^harness_(\w+?)_{1,2}(\w+)$/)
  // Snake-case tool ids read better humanized; commands and paths stay as typed.
  const label = mcp
    ? `${humanize(mcp[1])} · ${humanize(mcp[2])}`
    : /^[a-z]+(_[a-z]+)+$/i.test(name)
      ? humanize(name)
      : shortPath(name)
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

/** Absolute paths keep their informative end: ".../05-buying-clothes/story.js". */
export function shortPath(text: string): string {
  const parts = text.split('/')
  return text.startsWith('/') && parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : text
}

/** "fetch_web_content" -> "Fetch web content" */
export function humanize(name: string): string {
  const words = name.replace(/[_.]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A call's arguments, when the agent gave them as a JSON object. */
export function toolInput(tool: ToolItem): Record<string, unknown> | undefined {
  if (!tool.input) return undefined
  let input: unknown
  try {
    input = JSON.parse(tool.input)
  } catch {
    return undefined
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined
}

/** A short detail for a call: the URL, path, command or query it acted on. */
export function toolDetail(tool: ToolItem): string | undefined {
  const fields = toolInput(tool)
  if (!fields) return undefined
  for (const key of [
    'url',
    'path',
    'filePath',
    'command',
    'commands',
    'query',
    'queries',
    'pattern',
    'files'
  ]) {
    const value = fields[key]
    let first = Array.isArray(value) ? value[0] : value
    // Cline lists files as objects: {"files": [{"path": "..."}]}.
    if (first && typeof first === 'object') first = (first as Record<string, unknown>).path
    if (typeof first === 'string' && first) {
      const text = shortPath(first)
      return text.length > 80 ? `${text.slice(0, 79)}…` : text
    }
  }
  return undefined
}

/** The word in the kind column for each ACP tool kind. */
const KIND_WORDS: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  fetch: 'Fetch'
}

/** The kind column and what the call acted on. */
export function toolKindAndTarget(tool: ToolItem): [string, string] {
  const said = spokenText(tool)
  if (said !== undefined) return ['Voice', said.length > 120 ? `${said.slice(0, 119)}…` : said]
  const harness = harnessTool(tool)
  if (harness && HARNESS_VERBS[harness.server]?.[harness.name])
    return [
      harness.server === 'devices' ? 'Device' : 'Chats',
      harnessTarget(harness.server, harness.name, toolInput(tool) ?? {})
    ]
  const detail = toolDetail(tool)
  const browser = tool.title.match(BROWSER_TOOL)
  if (browser) return ['Browser', [humanize(browser[1]), detail].filter(Boolean).join(' ')]
  const kind = (tool.toolKind && KIND_WORDS[tool.toolKind]) || 'Tool'
  return [kind, detail ?? toolLabel(tool.title)]
}

/** What a call did, for the words that describe it and for summing up a group. */
export type CallKind =
  'read' | 'search' | 'edit' | 'run' | 'fetch' | 'browser' | 'device' | 'chats' | 'other'

export function callKind(tool: ToolItem): CallKind {
  const harness = harnessTool(tool)?.server
  if (harness) return harness === 'devices' ? 'device' : harness
  switch (tool.toolKind) {
    case 'read':
    case 'search':
    case 'fetch':
      return tool.toolKind
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit'
    case 'execute':
      return 'run'
    default:
      return 'other'
  }
}

/** The harness agent's web search, a fetch that reads better as a search. */
export const isWebSearch = (tool: ToolItem): boolean => tool.title === 'websearch'

/** The verb for a call, finished and in progress: "Ran" and "Running". */
export function callVerb(tool: ToolItem): [string, string] {
  if (spokenText(tool) !== undefined) return ['Said', 'Saying']
  if (isWebSearch(tool)) return ['Searched the web for', 'Searching the web for']
  const harness = harnessTool(tool)
  const harnessVerbs = harness && HARNESS_VERBS[harness.server]?.[harness.name]
  if (harnessVerbs) return harnessVerbs
  switch (tool.toolKind) {
    case 'delete':
      return ['Deleted', 'Deleting']
    case 'move':
      return ['Moved', 'Moving']
  }
  const verbs: Record<CallKind, [string, string]> = {
    read: ['Read', 'Reading'],
    search: ['Searched', 'Searching'],
    edit: ['Edited', 'Editing'],
    run: ['Ran', 'Running'],
    fetch: ['Fetched', 'Fetching'],
    browser: ['Browser', 'Browser'],
    device: ['Called', 'Calling'],
    chats: ['Called', 'Calling'],
    other: ['Called', 'Calling']
  }
  return verbs[callKind(tool)]
}

/**
 * What a group of calls did, in Codex's words and order: "Loaded a tool, read
 * files, ran commands". Each kind of call says so once, and its icon leads the
 * line.
 */
export type Category = 'tool' | 'read' | 'edit' | 'run' | 'fetch' | 'browser' | 'device' | 'chats'

const CATEGORY_ORDER: Category[] = [
  'tool',
  'read',
  'edit',
  'run',
  'fetch',
  'browser',
  'device',
  'chats'
]

export function category(tool: ToolItem): Category {
  const kind = callKind(tool)
  return kind === 'search' ? 'read' : kind === 'other' ? 'tool' : kind
}

/** Each category's words for one call and for several. */
const CATEGORY_WORDS: Record<Category, [string, string]> = {
  tool: ['used a tool', 'used tools'],
  read: ['read a file', 'read files'],
  edit: ['edited a file', 'edited files'],
  run: ['ran a command', 'ran commands'],
  fetch: ['fetched a page', 'fetched pages'],
  browser: ['used the browser', 'used the browser'],
  device: ['used the phone', 'used the phone'],
  chats: ['used Barebone', 'used Barebone']
}

export function groupCategories(tools: ToolItem[]): Category[] {
  const present = new Set(tools.map(category))
  return CATEGORY_ORDER.filter((c) => present.has(c))
}

export function groupSummary(tools: ToolItem[]): string {
  const text = groupCategories(tools)
    .map((c) => {
      const calls = tools.filter((t) => category(t) === c)
      if (c === 'read' && calls.every((t) => callKind(t) === 'search')) return 'searched the code'
      if (c === 'fetch' && calls.every(isWebSearch)) return 'searched the web'
      // Edits count the files they touched, not the calls.
      const count =
        c === 'edit' ? new Set(calls.map((t) => toolDetail(t) ?? t.id)).size : calls.length
      return CATEGORY_WORDS[c][count === 1 ? 0 : 1]
    })
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
