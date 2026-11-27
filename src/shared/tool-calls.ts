import type { ChatItem } from './types'

/**
 * How tool calls are put into words, the way Codex does: the verb and what a
 * call acted on ("Ran npm test", "Tapped “Sign in”"), and what a run of calls
 * did ("Read files, ran commands"). The chat view and the Telegram bot
 * (main/telegram) both describe calls with these.
 */

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

// MCP tools go by "mcp__server__tool", "server__tool", or with Codex "mcp.server.tool".
const BROWSER_TOOL = /^(?:mcp(?:__|\.))?harness_browser(?:_{1,2}|\.)(\w+)/
/** The speak tool (chats-mcp.ts), under the names agents give MCP tools. */
const SPEAK_TOOL = /^(?:mcp(?:__|\.))?harness_chats(?:_{1,2}|\.)speak$/

/** The app's own MCP servers (devices-mcp.ts, browser-mcp.ts, chats-mcp.ts). */
export type Harness = 'devices' | 'browser' | 'chats'
const HARNESS_TOOL = /^(?:mcp(?:__|\.))?harness_(devices|browser|chats)(?:_{1,2}|\.)(\w+)/

/** Codex's MCP calls: "mcp.server.tool", with the call's arguments under `arguments`. */
const CODEX_MCP_TOOL = /^mcp\.([^.\s]+)\.(\S+)$/

/** Which of the app's own servers a call went to, and the tool's name there. */
export function harnessTool(tool: ToolItem): { server: Harness; name: string } | undefined {
  const match = tool.title.match(HARNESS_TOOL)
  return match ? { server: match[1] as Harness, name: match[2] } : undefined
}

/** The app's own tools' verbs, finished and in progress, in plain words. */
const HARNESS_VERBS: Partial<Record<Harness, Record<string, [string, string]>>> = {
  browser: {
    navigate: ['Opened', 'Opening'],
    snapshot: ['Read the page', 'Reading the page'],
    click: ['Clicked on the page', 'Clicking on the page'],
    click_at: ['Clicked on the page', 'Clicking on the page'],
    hover: ['Pointed at something on the page', 'Pointing at something on the page'],
    type: ['Typed', 'Typing'],
    type_text: ['Typed', 'Typing'],
    select_option: ['Picked an option', 'Picking an option'],
    press_key: ['Pressed', 'Pressing'],
    handle_dialog: ['Answered a dialog', 'Answering a dialog'],
    paste_image: ['Pasted an image', 'Pasting an image'],
    scroll: ['Scrolled the page', 'Scrolling the page'],
    move_mouse: ['Moved the mouse', 'Moving the mouse'],
    drag: ['Dragged on the page', 'Dragging on the page'],
    back: ['Went back', 'Going back'],
    upload: ['Uploaded a file', 'Uploading a file'],
    tabs: ['Checked the tabs', 'Checking the tabs'],
    new_tab: ['Opened a tab', 'Opening a tab'],
    select_tab: ['Switched tabs', 'Switching tabs'],
    close_tab: ['Closed a tab', 'Closing a tab'],
    download: ['Downloaded a file', 'Downloading a file'],
    downloads: ['Checked the downloads', 'Checking the downloads'],
    screenshot: ['Took a screenshot', 'Taking a screenshot'],
    set_viewport: ['Resized the page', 'Resizing the page'],
    pdf: ['Saved the page as a PDF', 'Saving the page as a PDF'],
    evaluate: ['Checked something on the page', 'Checking something on the page'],
    console: ['Checked the page for errors', 'Checking the page for errors'],
    annotate: ['Marked up the page', 'Marking up the page'],
    clear_annotations: ['Cleared the marks', 'Clearing the marks'],
    show_step: ['Showed a step', 'Showing a step'],
    point: ['Pointed at something', 'Pointing at something'],
    caption: ['Showed a caption', 'Showing a caption'],
    wait_for_click: ['Waited for your click', 'Waiting for your click'],
    walkthrough: ['Showed a walkthrough', 'Showing a walkthrough'],
    start_recording: ['Started recording', 'Starting to record'],
    stop_recording: ['Stopped recording', 'Stopping the recording'],
    play: ['Played the recording', 'Playing the recording'],
    mark_thumbnail: ['Picked a thumbnail', 'Picking a thumbnail']
  },
  devices: {
    devices: ['Checked the devices', 'Checking the devices'],
    screen: ['Looked at the screen', 'Looking at the screen'],
    tap: ['Tapped', 'Tapping'],
    swipe: ['Swiped', 'Swiping'],
    type: ['Typed', 'Typing'],
    press: ['Pressed', 'Pressing'],
    wait_for: ['Waited for', 'Waiting for'],
    app: ['Used an app', 'Using an app'],
    settings: ['Changed device settings', 'Changing device settings'],
    logs: ['Read the logs', 'Reading the logs'],
    metro: ['Used Metro', 'Using Metro']
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
    create_bot: ['Made a bot', 'Making a bot'],
    see_app: ['Looked at Barebone', 'Looking at Barebone'],
    rename_chat: ['Renamed the chat', 'Renaming the chat'],
    change_look: ['Changed how Barebone looks', 'Changing how Barebone looks'],
    ask_approval: ['Asked for your approval', 'Asking for your approval'],
    set_routine: ['Set a routine', 'Setting a routine'],
    list_routines: ['Checked the routines', 'Checking the routines'],
    cancel_routine: ['Cancelled a routine', 'Cancelling a routine'],
    set_voice: ['Changed the voice', 'Changing the voice'],
    make_music: ['Made music', 'Making music']
  }
}

/** The phone's app and Metro calls, by what they were asked to do. */
const DEVICE_ACTIONS: Record<string, Record<string, [string, string]>> = {
  app: {
    open_url: ['Opened', 'Opening'],
    launch: ['Opened the app', 'Opening the app'],
    restart: ['Restarted the app', 'Restarting the app'],
    terminate: ['Closed the app', 'Closing the app'],
    install: ['Installed the app', 'Installing the app'],
    uninstall: ['Removed the app', 'Removing the app'],
    list: ['Checked the installed apps', 'Checking the installed apps'],
    push: ['Sent a notification', 'Sending a notification'],
    add_media: ['Added a photo', 'Adding a photo']
  },
  metro: {
    start: ['Started Metro', 'Starting Metro'],
    stop: ['Stopped Metro', 'Stopping Metro'],
    reload: ['Reloaded the app', 'Reloading the app'],
    status: ['Checked Metro', 'Checking Metro']
  }
}

/** A call to one of the app's own tools in words: its verbs and what it acted on. */
function harnessWords(tool: ToolItem): { verbs: [string, string]; target: string } | undefined {
  const harness = harnessTool(tool)
  if (!harness) return undefined
  const input = toolInput(tool) ?? {}
  const action = typeof input.action === 'string' ? input.action : ''
  const verbs =
    (harness.server === 'devices' && DEVICE_ACTIONS[harness.name]?.[action]) ||
    HARNESS_VERBS[harness.server]?.[harness.name]
  return verbs && { verbs, target: harnessTarget(harness.server, harness.name, input) }
}

/** Claude Code's own tools that are not about files or commands, in words. */
const CLAUDE_TOOLS: Record<string, [string, string]> = {
  ToolSearch: ['Loaded tools', 'Loading tools'],
  TodoWrite: ['Updated the todos', 'Updating the todos'],
  SendMessage: ['Messaged an agent', 'Messaging an agent'],
  ListAgents: ['Checked the agents', 'Checking the agents'],
  TaskStop: ['Stopped a background task', 'Stopping a background task'],
  TaskOutput: ['Checked a background task', 'Checking a background task'],
  Monitor: ['Watched a background task', 'Watching a background task'],
  ScheduleWakeup: ['Scheduled a check-in', 'Scheduling a check-in'],
  EnterPlanMode: ['Started planning', 'Starting to plan'],
  ExitPlanMode: ['Shared the plan', 'Sharing the plan'],
  Skill: ['Used a skill', 'Using a skill']
}

/** A Claude Code tool's words: the tool goes by its title, alone or with what it acted on. */
function claudeTool(tool: ToolItem): [string, string] | undefined {
  return CLAUDE_TOOLS[tool.title.split(/[\s:]/)[0]]
}

/** What a device or chats call acted on: the element tapped, the text typed, the task given. */
function harnessTarget(server: Harness, name: string, input: Record<string, unknown>): string {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value.replace(/\s+/g, ' ').trim() : undefined
  const quoted = (value: unknown): string | undefined => text(value) && `“${text(value)}”`
  // Refs and coordinates mean nothing to the user: an element goes by its text, or by none.
  const element = quoted(input.text)
  // A page by its address without the scheme, "localhost:5195/settings", or
  // by its site alone when the whole address is long: "mail.google.com".
  const page = (value: unknown): string | undefined => {
    const address = text(value)
      ?.replace(/^[a-z]+:\/\/(www\.)?/, '')
      .replace(/\/$/, '')
    return address && address.length > 40 ? address.split(/[/?#]/)[0] : address
  }
  const parts =
    server === 'browser'
      ? {
          navigate: [page(input.url)],
          new_tab: [page(input.url)],
          type: [quoted(input.text)],
          type_text: [quoted(input.text)],
          press_key: [text(input.key)],
          caption: [quoted(input.text)]
        }[name]
      : server === 'devices'
        ? {
            tap: [element ?? 'the screen'],
            swipe: [text(input.direction)],
            type: [quoted(input.value)],
            press: [text(input.button)],
            wait_for: [quoted(input.text), input.gone ? 'to go' : undefined],
            app: [input.action === 'open_url' ? page(input.url) : undefined]
          }[name]
        : {
            start_chat: [text(input.prompt)],
            send_message: [text(input.message)],
            run_in_background: [
              typeof input.command === 'string' ? describeCommand(input.command).target : undefined
            ],
            set_timer: [text(input.note)],
            create_bot: [quoted(input.name)]
          }[name]
  const target = (parts ?? []).filter(Boolean).join(' ')
  return target.length > 120 ? `${target.slice(0, 119)}…` : target
}

/** What an agent said out loud with the speak tool; undefined for any other call. */
export function spokenText(tool: ToolItem): string | undefined {
  if (!SPEAK_TOOL.test(tool.title.split(':')[0].trim())) return undefined
  const text = toolInput(tool)?.text
  return typeof text === 'string' ? text : ''
}

/**
 * A short name for a tool call: drops arguments (agents put them after ":") and
 * MCP server prefixes, e.g. "harness_browser__click: {...}" -> "Browser · click",
 * and the app's own agent's "mcp__github__create_issue" -> "Github · Create issue".
 */
export function toolLabel(title: string): string {
  const name = title.split(':')[0].trim()
  const mcp =
    name.match(/^mcp__(.+?)__(.+)$/) ??
    name.match(/^harness_(\w+?)_{1,2}(\w+)$/) ??
    name.match(CODEX_MCP_TOOL)
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
  if (!input || typeof input !== 'object') return undefined
  // Codex wraps an MCP call's arguments: {"server", "tool", "arguments": {...}}.
  const { arguments: args } = input as { arguments?: unknown }
  if (CODEX_MCP_TOOL.test(tool.title) && args && typeof args === 'object')
    return args as Record<string, unknown>
  return input as Record<string, unknown>
}

/**
 * Codex's reads, listings and searches come with no arguments, only a title:
 * "Read file '/a/b.ts'", "List files in 'src'", "Search for 'x' in src".
 */
const EXPLORE_TITLE = /^(Read file|List files in|Search for) '(.+?)'(?: in '?(.+?)'?)?$/

function exploreCall(tool: ToolItem): { verbs: [string, string]; target: string } | undefined {
  const match = tool.title.match(EXPLORE_TITLE)
  if (!match) return undefined
  const [, action, what, where] = match
  if (action === 'Read file') return { verbs: ['Read', 'Reading'], target: fileName(what) ?? what }
  if (action === 'List files in')
    return { verbs: ['Listed files in', 'Listing files in'], target: shortPath(what) }
  return {
    verbs: ['Searched for', 'Searching for'],
    target: where ? `${what} in ${shortPath(where)}` : what
  }
}

/** A short detail for a call: the URL, path, command or query it acted on. */
export function toolDetail(tool: ToolItem): string | undefined {
  const fields = toolInput(tool)
  if (!fields) return undefined
  for (const key of [
    'url',
    'path',
    'filePath',
    'file_path',
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
  const harnessCall = harnessWords(tool)
  if (harness && harnessCall)
    return [
      { devices: 'Device', browser: 'Browser', chats: 'Chats' }[harness.server],
      harnessCall.target
    ]
  if (claudeTool(tool)) {
    const skill = toolInput(tool)?.skill
    return ['Tool', typeof skill === 'string' ? skill : '']
  }
  const detail = toolDetail(tool)
  const browser = tool.title.match(BROWSER_TOOL)
  if (browser) return ['Browser', [humanize(browser[1]), detail].filter(Boolean).join(' ')]
  const kind = (tool.toolKind && KIND_WORDS[tool.toolKind]) || 'Tool'
  const explore = exploreCall(tool)
  if (explore) return [kind, explore.target]
  if (CODEX_MCP_TOOL.test(tool.title)) return ['Tool', toolLabel(tool.title)]
  // A command says what it does; the command itself shows when the call is opened.
  if (callKind(tool) === 'run') return [kind, commandWords(tool).target]
  // A file read or edited goes by its name, as Codex links it: "Read ChatView.tsx".
  const file = tool.toolKind === 'read' || callKind(tool) === 'edit'
  return [kind, (file && detail && fileName(detail)) || detail || toolLabel(tool.title)]
}

/**
 * The command a call ran, whole, without what agents wrap it in: a shell
 * ("bash -lc '…'"), or with Codex, double quotes around it all.
 */
export function commandText(tool: ToolItem): string {
  const command = toolInput(tool)?.command
  const text = Array.isArray(command)
    ? command.map(String).join(' ')
    : typeof command === 'string'
      ? command
      : tool.title
  const wrapped =
    text.match(/^(?:\/bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/) ?? text.match(/^(")([^"]*)"$/)
  return (wrapped ? wrapped[2] : text).trim()
}

/** What a command does in words, when the agent said so (Claude Code does): "List the src folder". */
function commandDescription(tool: ToolItem): string | undefined {
  const description = toolInput(tool)?.description
  if (typeof description !== 'string' || !description.trim()) return undefined
  const text = description.trim().replace(/\.$/, '')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Programs better named with what they were asked to do: "git log", "pnpm test". */
const WITH_SUBCOMMAND = new Set([
  'git',
  'gh',
  'glab',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'docker',
  'kubectl',
  'cargo',
  'go',
  'make',
  'brew',
  'xcrun',
  'swift',
  'flutter',
  'pip',
  'uv'
])

/** Programs that print files, list folders and search, which Codex words as reading, listing and searching. */
const READERS = new Set(['cat', 'head', 'tail', 'nl', 'sed', 'less', 'bat'])
const LISTERS = new Set(['ls', 'find', 'tree', 'fd'])
const SEARCHERS = new Set(['rg', 'grep', 'ag', 'ack'])
/** A searcher's options followed by a value that is not the pattern. */
const SEARCH_VALUED = new Set([
  '-g',
  '--glob',
  '-t',
  '--type',
  '-m',
  '--max-count',
  '-A',
  '-B',
  '-C'
])

/** A command in words, and whether it only looked around: read a file, listed files or searched. */
interface CommandWords {
  verbs: [string, string]
  target: string
  looks?: Looks
}

type Looks = 'read' | 'list' | 'search'

/**
 * Whether a command or Codex call only looked around, as Codex counts it with
 * the reads ("Read files") rather than the commands; undefined when it did more.
 */
export function looksAround(tool: ToolItem): Looks | undefined {
  const explore = tool.title.match(EXPLORE_TITLE)?.[1]
  if (explore)
    return explore === 'Read file' ? 'read' : explore === 'Search for' ? 'search' : 'list'
  return callKind(tool) === 'run' ? commandWords(tool).looks : undefined
}

/**
 * A command in words, as Codex puts it, for a line that reads as words: what
 * the agent said it does, or "Read config.ts", "Listed files in src",
 * "Searched for groupSummary", else "Ran git log" by the program it ran. The
 * first step counts, after moving into a folder; variables set before it are skipped.
 */
function commandWords(tool: ToolItem): CommandWords {
  const described = commandDescription(tool)
  if (described) return { verbs: [described, described], target: '' }
  return describeCommand(commandText(tool))
}

/** A command the agent did not describe, in words from what it runs. */
function describeCommand(command: string): CommandWords {
  // Its words, then its steps between && || ; | and new lines outside quotes.
  // A quote may run to the end: agents cut long titles short.
  const tokens = command.match(/"[^"]*"?|'[^']*'?|&&|\|\||[;|\n]|[^\s;|&"']+|&/g) ?? []
  const steps: string[][] = [[]]
  for (const token of tokens) {
    if (/^(&&|\|\||[;|\n])$/.test(token)) steps.push([])
    else steps.at(-1)!.push(token)
  }
  const step = steps.find((s) => s.length > 0 && s[0] !== 'cd') ?? []
  const words = step
    .filter((word) => !/^\w+=/.test(word))
    .map((word) => word.replace(/^(["'])([\s\S]*?)\1?$/, '$2'))
  const program = words[0]?.split('/').at(-1) ?? ''
  const args = words.slice(1)
  if (READERS.has(program)) {
    const file = args.filter((arg) => !arg.startsWith('-') && /[./]/.test(arg)).at(-1)
    if (file) return { verbs: ['Read', 'Reading'], target: fileName(file) ?? file, looks: 'read' }
  }
  if (LISTERS.has(program) || (program === 'rg' && args.includes('--files'))) {
    const folder = args.find(
      (arg, i) => !arg.startsWith('-') && arg !== '.' && !SEARCH_VALUED.has(args[i - 1])
    )
    return folder
      ? { verbs: ['Listed files in', 'Listing files in'], target: shortPath(folder), looks: 'list' }
      : { verbs: ['Listed files', 'Listing files'], target: '', looks: 'list' }
  }
  if (SEARCHERS.has(program)) {
    let pattern: string | undefined
    for (let i = 0; i < args.length && pattern === undefined; i++) {
      if (args[i] === '-e') pattern = args[i + 1]
      else if (SEARCH_VALUED.has(args[i])) i++
      else if (!args[i].startsWith('-')) pattern = args[i]
    }
    if (pattern)
      return { verbs: ['Searched for', 'Searching for'], target: pattern, looks: 'search' }
  }
  const sub = args[0]
  const name =
    WITH_SUBCOMMAND.has(program) && sub && /^[\w:.-]+$/.test(sub) && !sub.startsWith('-')
      ? `${program} ${sub}`
      : program || command
  return { verbs: ['Ran', 'Running'], target: name.length > 60 ? `${name.slice(0, 59)}…` : name }
}

/** The name at the end of a path; nothing when the text is not one path (a command, a query). */
function fileName(text: string): string | undefined {
  if (!text.includes('/') || /\s/.test(text)) return undefined
  return text.split('/').filter(Boolean).at(-1)
}

/** What a call did, for the words that describe it and for summing up a group. */
export type CallKind =
  'read' | 'search' | 'edit' | 'run' | 'fetch' | 'browser' | 'device' | 'chats' | 'other'

export function callKind(tool: ToolItem): CallKind {
  const harness = harnessTool(tool)?.server
  if (harness) return harness === 'devices' ? 'device' : harness
  // Codex sends its MCP calls as commands; they are tool calls.
  if (CODEX_MCP_TOOL.test(tool.title)) return 'other'
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
  const harnessCall = harnessWords(tool)
  if (harnessCall) return harnessCall.verbs
  const claude = claudeTool(tool)
  if (claude) return claude
  const explore = exploreCall(tool)
  if (explore) return explore.verbs
  if (callKind(tool) === 'run') return commandWords(tool).verbs
  switch (tool.toolKind) {
    case 'delete':
      return ['Deleted', 'Deleting']
    case 'move':
      return ['Moved', 'Moving']
  }
  const verbs: Record<CallKind, [string, string]> = {
    read: ['Read', 'Reading'],
    search: ['Searched for', 'Searching for'],
    edit: ['Edited', 'Editing'],
    run: ['Ran', 'Running'],
    fetch: ['Fetched', 'Fetching'],
    browser: ['Used the browser to', 'Using the browser to'],
    device: ['Called', 'Calling'],
    chats: ['Called', 'Calling'],
    other: ['Called', 'Calling']
  }
  return verbs[callKind(tool)]
}

/**
 * What a group of calls did, in Codex's words and order: "Used the browser,
 * edited files, read files, ran commands". Each kind of call says so once,
 * without counts, and its icon leads the line.
 */
export type Category = 'tool' | 'read' | 'edit' | 'run' | 'fetch' | 'browser' | 'device' | 'chats'

const CATEGORY_ORDER: Category[] = [
  'browser',
  'device',
  'chats',
  'tool',
  'edit',
  'read',
  'run',
  'fetch'
]

export function category(tool: ToolItem): Category {
  const kind = callKind(tool)
  // A command that only read, listed or searched is one of the reads, as Codex counts it.
  if (kind === 'run' && looksAround(tool)) return 'read'
  return kind === 'search' ? 'read' : kind === 'other' ? 'tool' : kind
}

/** Each category's words for one call and for several. Reads, searches and listings are all "read files". */
const CATEGORY_WORDS: Record<Category, [string, string]> = {
  tool: ['called a tool', 'called tools'],
  read: ['read files', 'read files'],
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
      if (c === 'fetch' && calls.every(isWebSearch)) return 'searched the web'
      // Edits count the files they touched, not the calls.
      const count =
        c === 'edit' ? new Set(calls.map((t) => toolDetail(t) ?? t.id)).size : calls.length
      return CATEGORY_WORDS[c][count === 1 ? 0 : 1]
    })
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** One call in plain words, as its line says it: "Read schema.prisma", "Opened localhost:5195". */
export function callWords(tool: ToolItem, live = false): string {
  const [done, doing] = callVerb(tool)
  return `${live ? doing : done} ${toolKindAndTarget(tool)[1]}`.replace(/\s+/g, ' ').trim()
}

/**
 * What a run of calls did, step by step in plain words: "Find commits touching
 * the browser, read browser.ts, took a screenshot". A step said twice is said once.
 */
export function groupSteps(tools: ToolItem[]): string {
  const steps = [...new Set(tools.map((tool) => callWords(tool)))]
  return steps
    .map((step, index) =>
      // Later steps run on in the sentence, unless they start with a name ("MCP", "README.md").
      index > 0 && /^[A-Z][a-z]/.test(step) ? step.charAt(0).toLowerCase() + step.slice(1) : step
    )
    .join(', ')
}
