import { app, dialog, type BrowserWindow } from 'electron'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  senderChat,
  type AppState,
  type Chat,
  type ChatItem,
  type Project,
  type Theme
} from '../shared/types'
import { cleanStoredOutput } from './tool-output'
import { chatPreview } from './preview'
import { removeChatImages } from './images'
import { addPrompt, historyPrompt, PROMPT_HISTORY_LIMIT } from '../shared/prompt-history'
import { topicIcon } from './topic-icon'

const dataDir = join(app.getPath('userData'), 'data')
const chatsDir = join(dataDir, 'chats')
const statePath = join(dataDir, 'state.json')

mkdirSync(chatsDir, { recursive: true })

/** A file's JSON, or `damaged` when it exists but cannot be parsed. */
type Read<T> = { value: T } | { damaged: string }

function readJson<T>(path: string, fallback: T): Read<T> {
  if (!existsSync(path)) return { value: fallback }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as T }
  } catch (error) {
    return { damaged: (error as Error).message }
  }
}

/**
 * Move a file that cannot be read out of the way, next to where it was, so it
 * is not overwritten and can still be recovered by hand. Returns where it went.
 */
function keepDamaged(path: string, reason: string): string {
  const kept = `${path}.damaged-${Date.now()}`
  renameSync(path, kept)
  console.error(`${path} could not be read (${reason}); it was moved to ${kept}.`)
  return kept
}

/**
 * Write via a temp file so a crash mid-write never leaves a truncated file;
 * synced before the rename so a power loss cannot leave an empty one.
 */
function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/** Where a damaged state file was moved at launch, for telling the user once the window is up. */
let damagedState: string | undefined

const state = loadState()

/** The saved state; without it the app would not start, so a damaged file is set aside. */
function loadState(): AppState {
  const read = readJson<AppState>(statePath, { projects: [], chats: [] })
  if ('value' in read) return read.value
  damagedState = keepDamaged(statePath, read.damaged)
  return { projects: [], chats: [] }
}

/** Say that the saved projects and chats could not be read, if so (see loadState). */
export function reportDamagedState(window: BrowserWindow): void {
  if (!damagedState) return
  void dialog.showMessageBox(window, {
    type: 'warning',
    message: 'Barebone could not read its saved projects and chats',
    detail: `The file was damaged, so the app started without them. The damaged file was kept at:\n\n${damagedState}\n\nEach chat's messages are stored separately and were not touched.`
  })
  damagedState = undefined
}

for (const chat of state.chats) {
  // Nothing can be running or waiting right after launch.
  chat.running = false
  chat.waiting = false
  delete chat.waitingMessages
  delete chat.background
  // The browser and code panels start closed; an agent or the header buttons open them.
  chat.browserOpen = false
  chat.codeOpen = false
  // Chats from before sidebar previews, or before the chat that started a chat was recorded,
  // get them once from their messages; they are saved from then on.
  if (chat.preview === undefined || chat.startedBy === undefined) {
    const read = readJson<ChatItem[]>(join(chatsDir, `${chat.id}.json`), [])
    const items = 'value' in read ? read.value : []
    chat.preview ??= chatPreview(items)
    // Only a chat's first message can come from the chat that started it (see startChat).
    const first = items.find((i) => i.kind === 'user')
    chat.startedBy ??= (first?.kind === 'user' && senderChat(first.from)) || null
  }
  // Before tabs, a chat's browser kept one page.
  const legacy = chat as Chat & { browserUrl?: string }
  if (legacy.browserUrl) {
    chat.browserTabs ??= { urls: [legacy.browserUrl], active: 0 }
    delete legacy.browserUrl
  }
}

/** How many of the chats used most recently a new chat's hue keeps away from. */
const HUE_NEIGHBORS = 8

/** The hue farthest from all of these, so a chat looks different from the chats around it. */
function freeHue(taken: number[]): number {
  if (taken.length === 0) return 220
  let best = 0
  let bestGap = -1
  for (let hue = 0; hue < 360; hue++) {
    const gap = Math.min(...taken.map((t) => Math.min(Math.abs(hue - t), 360 - Math.abs(hue - t))))
    if (gap > bestGap) {
      best = hue
      bestGap = gap
    }
  }
  return best
}

// Chats from before chat hues get one. The sidebar lists chats by when they were last used, so
// from the latest back, each keeps away from the hues of the chats used just after it.
{
  const after: number[] = []
  for (const chat of [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
    chat.hue ??= freeHue(after.slice(-HUE_NEIGHBORS))
    after.push(chat.hue)
  }
}

// A chat left without a message or a draft is of no use; those left from earlier launches go.
const emptyChats = state.chats.filter((chat) => {
  if (chat.preview || chat.draft) return false
  const read = readJson<ChatItem[]>(join(chatsDir, `${chat.id}.json`), [])
  return 'value' in read && read.value.length === 0
})
if (emptyChats.length > 0) {
  state.chats = state.chats.filter((c) => !emptyChats.includes(c))
  for (const chat of emptyChats) rmSync(join(chatsDir, `${chat.id}.json`), { force: true })
  writeJson(statePath, state)
}

const messages = new Map<string, ChatItem[]>()
/**
 * Each project's prompt history (see shared/prompt-history.ts), built on the
 * first ask and kept up to date as messages are sent. A pending build is kept
 * too, so asks during it share one read of the chats.
 */
const promptHistories = new Map<string, Promise<string[]>>()
const dirtyChats = new Set<string>()
let flushTimer: NodeJS.Timeout | undefined

function scheduleFlush(): void {
  flushTimer ??= setTimeout(flush, 500)
}

export function flush(): void {
  clearTimeout(flushTimer)
  flushTimer = undefined
  writeJson(statePath, state)
  for (const chatId of dirtyChats) {
    const items = messages.get(chatId)
    if (items) writeJson(join(chatsDir, `${chatId}.json`), items)
  }
  dirtyChats.clear()
}

/** The file a chat's messages are saved in. */
export function chatFile(chatId: string): string {
  return join(chatsDir, `${chatId}.json`)
}

/**
 * Where the app saves the user's chats, for agents: when the user refers to an
 * earlier chat, or a chat switches agent (see AgentManager.changeAgent), the
 * agent reads what happened there.
 */
export function savedChatsNote(chatId: string): string {
  return `Barebone saves every chat of the user's. ${statePath} lists them (id, projectId, title, agent, createdAt), and each chat's messages are in ${chatsDir}/<chat id>.json, as the user saw them: their messages, the agent's answers, and its tool calls with their output. This chat's own are in ${chatFile(chatId)}. When the user refers to an earlier chat or asks you to continue a topic, find the chat by its title and read its messages to see what was done or what went wrong. The files can be long, so search them before reading them whole. Only read them, never change them.`
}

export function getState(): AppState {
  return state
}

export function setTheme(theme: Theme): void {
  state.theme = theme
  scheduleFlush()
}

/** Save the user's instructions; empty removes them. */
export function setInstructions(text: string): void {
  state.instructions = text.trim() || undefined
  scheduleFlush()
}

/** Turn the browser tools that draw on pages, and their skill, on or off. */
export function setAnnotations(on: boolean): void {
  state.annotations = on || undefined
  scheduleFlush()
}

/** Turn the walkthrough tool, which walks the user through code in the code panel, on or off. */
export function setCodeTours(on: boolean): void {
  state.codeTours = on || undefined
  scheduleFlush()
}

/** Turn the browser tools that record a tab as a video on or off. */
export function setRecording(on: boolean): void {
  state.recording = on || undefined
  scheduleFlush()
}

/** Turn the device tools, for mobile apps, on or off. */
export function setMobile(on: boolean): void {
  state.mobile = on || undefined
  scheduleFlush()
}

/** Speech is on unless the user turned it off. */
export function setSpeech(on: boolean): void {
  state.speech = on ? undefined : false
  scheduleFlush()
}

export function speechOn(): boolean {
  return state.speech !== false
}

export function addProject(project: Project): void {
  state.projects.push(project)
  scheduleFlush()
}

export function removeProject(projectId: string): void {
  for (const chat of state.chats.filter((c) => c.projectId === projectId)) removeChat(chat.id)
  state.projects = state.projects.filter((p) => p.id !== projectId)
  scheduleFlush()
}

export function updateProject(
  projectId: string,
  patch: Partial<Pick<Project, 'color' | 'icon'>>
): void {
  Object.assign(getProject(projectId), patch)
  scheduleFlush()
}

export function getProject(projectId: string): Project {
  const project = state.projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`Unknown project ${projectId}`)
  return project
}

/** Add a new, empty chat. */
export function createChat({
  projectId,
  agent,
  settings,
  bypassPermissions,
  projectOnly,
  startedBy = null
}: Pick<Chat, 'projectId' | 'agent' | 'settings' | 'bypassPermissions' | 'projectOnly'> &
  Pick<Partial<Chat>, 'startedBy'>): Chat {
  const chat: Chat = {
    id: crypto.randomUUID(),
    projectId,
    title: 'New chat',
    agent,
    settings,
    bypassPermissions,
    projectOnly,
    startedBy,
    hue: freeHue(
      [...state.chats]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, HUE_NEIGHBORS)
        .flatMap((c) => (c.hue === undefined ? [] : [c.hue]))
    ),
    running: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  state.chats.push(chat)
  messages.set(chat.id, [])
  dirtyChats.add(chat.id)
  scheduleFlush()
  return chat
}

export function getChat(chatId: string): Chat {
  const chat = state.chats.find((c) => c.id === chatId)
  if (!chat) throw new Error(`Unknown chat ${chatId}`)
  return chat
}

export function updateChat(chatId: string, patch: Partial<Chat>): Chat {
  const chat = getChat(chatId)
  Object.assign(chat, patch)
  scheduleFlush()
  return chat
}

/** The text of the first message in a chat's items, which says what the chat is for. */
function firstMessage(items: ChatItem[]): string {
  const first = items.find((i) => i.kind === 'user')
  return first?.kind === 'user' ? first.text : ''
}

/**
 * Match the chat's topic icon to its title and first message again (see
 * topic-icon.ts), after either changed. Resolves to whether the icon changed.
 */
export async function refreshTopic(chatId: string): Promise<boolean> {
  const chat = getChat(chatId)
  const icon = await topicIcon(chat.title, firstMessage(getMessages(chatId)))
  // The chat may have been deleted while the icons loaded.
  if (!state.chats.includes(chat) || chat.icon === icon) return false
  chat.icon = icon
  scheduleFlush()
  return true
}

/**
 * Give chats from before topic icons theirs, once. Their messages are read
 * from disk one chat at a time, without keeping them in memory. Resolves to
 * whether any chat got one.
 */
export async function matchMissingTopics(): Promise<boolean> {
  let changed = false
  for (const chat of state.chats.filter((c) => c.icon === undefined)) {
    let items: ChatItem[] = []
    try {
      items = JSON.parse(await readFile(join(chatsDir, `${chat.id}.json`), 'utf8'))
    } catch {
      // No messages saved, or a damaged file (getMessages sets that aside when it is opened):
      // the title alone says what the chat is about.
    }
    const icon = await topicIcon(chat.title, firstMessage(messages.get(chat.id) ?? items))
    if (!state.chats.includes(chat) || chat.icon !== undefined) continue
    chat.icon = icon
    changed = true
  }
  if (changed) scheduleFlush()
  return changed
}

export function removeChat(chatId: string): void {
  const chat = state.chats.find((c) => c.id === chatId)
  // Its prompts go with it: the history is built again when next asked for.
  if (chat) promptHistories.delete(chat.projectId)
  state.chats = state.chats.filter((c) => c.id !== chatId)
  messages.delete(chatId)
  dirtyChats.delete(chatId)
  rmSync(join(chatsDir, `${chatId}.json`), { force: true })
  removeChatImages(chatId)
  scheduleFlush()
}

export function getMessages(chatId: string): ChatItem[] {
  let items = messages.get(chatId)
  if (!items) {
    const path = join(chatsDir, `${chatId}.json`)
    const read = readJson<ChatItem[]>(path, [])
    if ('value' in read) {
      items = read.value
    } else {
      // The chat stays usable; what it showed before is kept aside, and the chat says so.
      const kept = keepDamaged(path, read.damaged)
      items = [
        {
          kind: 'error',
          id: crypto.randomUUID(),
          text: `This chat's earlier messages could not be read, so they are not shown. The damaged file was kept at ${kept}.`
        }
      ]
      dirtyChats.add(chatId)
      scheduleFlush()
    }
    for (const item of items) {
      // A permission prompt or form cannot survive a restart: the agent process that asked is gone.
      if (item.kind === 'permission' && !item.resolved) item.resolved = 'cancelled'
      if (item.kind === 'form' && !item.resolved) item.resolved = 'cancelled'
      // Nor a tool call that was still running when the app quit.
      if (item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
        item.status = 'interrupted'
      }
      // Earlier versions kept tool output whole, screenshots included; slim it once.
      if (item.kind === 'tool' && item.output) {
        const output = cleanStoredOutput(item.output)
        if (output !== item.output) {
          item.output = output
          dirtyChats.add(chatId)
          scheduleFlush()
        }
      }
    }
    messages.set(chatId, items)
  }
  return items
}

/** Insert or replace an item by id. Returns the stored item. */
export function upsertItem(chatId: string, item: ChatItem): ChatItem {
  const items = getMessages(chatId)
  const index = items.findIndex((i) => i.id === item.id)
  if (index === -1) {
    items.push(item)
    rememberPrompt(chatId, item)
  } else {
    items[index] = item
  }
  dirtyChats.add(chatId)
  scheduleFlush()
  return item
}

export function findItem(chatId: string, itemId: string): ChatItem | undefined {
  return getMessages(chatId).find((i) => i.id === itemId)
}

export function lastItem(chatId: string): ChatItem | undefined {
  const items = getMessages(chatId)
  return items[items.length - 1]
}

/** What the user sent in the project's chats, newest first, for the composer to complete from. */
export function promptHistory(projectId: string): Promise<string[]> {
  let history = promptHistories.get(projectId)
  if (!history) {
    history = buildPromptHistory(projectId)
    promptHistories.set(projectId, history)
  }
  return history
}

/** A message the user typed: not one another chat's agent or a command sent. */
function typedPrompt(item: ChatItem): string | undefined {
  return item.kind === 'user' && !item.from ? historyPrompt(item.text) : undefined
}

/**
 * Read the prompts from every chat of the project. Chats not open are read
 * from disk one at a time and not kept, so this holds only the prompts.
 */
async function buildPromptHistory(projectId: string): Promise<string[]> {
  const sent: { prompt: string; at: number; order: number }[] = []
  for (const chat of state.chats.filter((c) => c.projectId === projectId)) {
    const items = messages.get(chat.id) ?? (await readStoredMessages(chat.id))
    for (const item of items) {
      const prompt = typedPrompt(item)
      if (!prompt) continue
      // Messages from before sentAt was saved count from their chat's start, in order.
      const at = (item.kind === 'user' && item.sentAt) || chat.createdAt
      sent.push({ prompt, at, order: sent.length })
    }
  }
  sent.sort((a, b) => b.at - a.at || b.order - a.order)
  const history = new Set<string>()
  for (const { prompt } of sent) {
    history.add(prompt)
    if (history.size === PROMPT_HISTORY_LIMIT) break
  }
  return [...history]
}

/** A chat's saved messages without loading them into the store; none when unreadable. */
async function readStoredMessages(chatId: string): Promise<ChatItem[]> {
  try {
    return JSON.parse(await readFile(join(chatsDir, `${chatId}.json`), 'utf8')) as ChatItem[]
  } catch {
    // Missing, or damaged: getMessages sets a damaged file aside when the chat is opened.
    return []
  }
}

/** Put a newly sent message first in its project's history, if that history was built. */
function rememberPrompt(chatId: string, item: ChatItem): void {
  const prompt = typedPrompt(item)
  const chat = prompt && state.chats.find((c) => c.id === chatId)
  const history = chat && promptHistories.get(chat.projectId)
  if (!chat || !history) return
  promptHistories.set(
    chat.projectId,
    history.then((prompts) => addPrompt(prompts, prompt))
  )
}
