import { app } from 'electron'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  AGENTS,
  BOT_SHAPES,
  PROJECT_COLORS,
  WEEKDAYS,
  type AgentId,
  type BotRoutine,
  type Project
} from '../shared/types'
import { approvalText, type Approval } from './approvals'
import type { Finished, Running } from './background'
import type { NewBot } from './bots'
import type { Routines } from './routines'
import type { Spoken } from './speech'
import { LANGUAGES, type Language } from './speech/supertonic'
import * as store from './store'

/**
 * An MCP server that lets a chat start other chats in its project and message
 * them: hand a task to a new chat, which reports back when done, and
 * coordinate with chats working alongside. It is served next to the browser's
 * (see browser-mcp.ts), so every agent gets it the same way.
 *
 * A message starts a turn in the chat it is sent to, or waits until that
 * chat's turn ends. Agents are told to start chats only when the user asks
 * (GUIDANCE, which agents put in their system prompt), and a chat takes only
 * so many messages from other chats between the user's own, so two chats
 * cannot keep each other going.
 *
 * A chat calls with its own private key, which proves who calls: chat IDs are
 * how chats name each other, so anyone may know them. A message cannot reach a
 * chat with broader permissions than the sender's, and a chat whose turn
 * another chat started cannot start chats, so a chain of chats ends there.
 */

export const SERVER_NAME = 'harness_chats'

/** Messages from other chats, commands and timers a chat takes since the user last wrote in it. */
export const MAX_FROM_CHATS = 20

/** The longest a timer can be set for: a day. */
const MAX_TIMER_SECONDS = 24 * 60 * 60

/** Sent to the model as the server's instructions; the harness puts it in its system prompt. */
export const CHATS_GUIDANCE =
  "These tools start and message other chats of the user's project in Barebone. Start new " +
  'chats only when the user asks for them; each one runs on its own and costs its own requests, ' +
  'so otherwise do the work yourself. A chat you start works alongside you and reports back with ' +
  'send_message. Its report arrives as a new message once your turn has ended, and when it ends ' +
  'its turn without reporting (it finished, failed or was stopped), you are told that instead, ' +
  'with why. So never wait or poll for it: end your turn, and you are woken. A chat you start runs ' +
  'on your agent, model and thinking level unless the user asks for others, which list_models ' +
  'finds. list_chats shows how each chat you started is doing, and send_message gets a stopped ' +
  'one going again. delete_chat removes a chat you started. Treat the chats you start as ' +
  'subagents: once one has reported back and you have used its result, delete it, unless the ' +
  'user may want to follow up in it. Before starting new chats, check list_chats: give ' +
  'follow-up work to an idle chat of yours that has the context, and delete the ones no longer ' +
  'of use, so only chats that are working or still needed are left. run_in_background runs a long ' +
  'command (a download, a long build or test run, a dev server) and wakes this chat with its ' +
  'result when it ends; run one that ends within a couple of minutes with your own shell tool ' +
  'instead. list_background, read_background and stop_background check on it and stop it. ' +
  'set_timer wakes this chat later, to check on something nothing else tells you about.'

/** "45s", "3m 12s", "1h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/**
 * What chats' keys are made from, kept on disk, readable only by the user. A
 * chat's key stays the same across launches, as an agent may keep the prompt
 * that first told it its key: a resumed Claude Code session keeps its system
 * prompt, so a key made anew at each launch would no longer be its own.
 */
const secretPath = join(app.getPath('userData'), 'data', 'chat-keys.json')

let secret: Buffer | undefined

function keySecret(): Buffer {
  if (secret) return secret
  try {
    if (existsSync(secretPath)) {
      const saved = JSON.parse(readFileSync(secretPath, 'utf8')) as { secret?: unknown }
      if (typeof saved.secret === 'string' && saved.secret.length >= 64) {
        return (secret = Buffer.from(saved.secret, 'hex'))
      }
    }
  } catch (error) {
    console.error(`${secretPath} could not be read:`, (error as Error).message)
  }
  secret = randomBytes(32)
  mkdirSync(dirname(secretPath), { recursive: true })
  writeFileSync(secretPath, JSON.stringify({ secret: secret.toString('hex') }), { mode: 0o600 })
  return secret
}

/** The key a chat passes to these tools: only Barebone, which holds the secret, can make it. */
export function chatKey(chatId: string): string {
  return createHmac('sha256', keySecret()).update(chatId).digest('hex').slice(0, 32)
}

/** The chat a key belongs to; throws a message the model can act on. */
function chatForKey(key: string): string {
  for (const chat of store.getState().chats) if (chatKey(chat.id) === key) return chat.id
  throw new Error(
    'Unknown key. Pass your own harness_chats key, given in the conversation, as "chat".'
  )
}

/**
 * What the chat tools do, implemented by the agent manager. The caller is a
 * chat's full id, taken from its key; other chats are named by their chat IDs.
 */
export interface ChatsApi {
  /**
   * Start a chat like the caller's and send it the task, on the agent and model
   * chosen, or the caller's own; returns its ID and title.
   */
  startChat(
    caller: string,
    prompt: string,
    choice: ModelChoice
  ): Promise<{ id: string; title: string }>
  /** The agents a started chat can run on, with their models, and what the caller runs on. */
  listModels(caller: string): Promise<ModelsListing>
  /** Send a message: 'started' when it started a turn, 'steering' when it joins the running turn at its next step. */
  message(caller: string, to: string, text: string): 'started' | 'steering'
  /** The chats the caller started, and the project's other working chats. */
  listChats(caller: string): ChatListing[]
  /** Delete a chat the caller started, stopping it first if it works; returns its title. */
  deleteStartedChat(caller: string, id: string): Promise<string>
  /**
   * Run a command in the caller's project, after the same permission check as
   * a shell command, stopped after `timeout` seconds if given; when it ends,
   * its result wakes the caller.
   */
  runInBackground(caller: string, command: string, timeout?: number): Promise<Running>
  /** The caller's running background commands, and its timer. */
  listBackground(caller: string): { commands: Running[]; timer?: Timer }
  /** One of the caller's running background commands, with the end of its output. */
  readBackground(caller: string, pid: number): Promise<Running & { output: string }>
  /** Stop one of the caller's background commands; resolves once it has ended. */
  stopBackground(caller: string, pid: number): Promise<Finished>
  /** Wake the caller with `note` after `seconds`, replacing its timer. */
  setTimer(caller: string, seconds: number, note: string): void
  /** Clear the caller's timer; false when it had none. */
  cancelTimer(caller: string): boolean
  /** Rename the caller, as the user does in the sidebar. */
  renameChat(caller: string, title: string): void
  /**
   * Show an approval card in the caller and wait for the user's answer, for
   * at most APPROVAL_WAIT_MS or until `signal` ends the call. Undefined when
   * the call ended first: the card stays, and its answer wakes the caller.
   */
  askApproval(
    caller: string,
    question: string,
    details: string,
    signal: AbortSignal
  ): Promise<Approval | undefined>
}

/** The Telegram bot (main/telegram), which sends files to the user's phone. */
export interface PhoneApi {
  /** Whether a user is paired and topics are on: send_file is offered only then. */
  on(): boolean
  /**
   * Send a file to the Telegram topic of the chat, or of the chat that
   * started it; resolves with what was sent, throws why it could not be.
   */
  sendFile(chatId: string, path: string, caption?: string): Promise<string>
}

/** The bot the chat servers send files with; given once, when the app starts. */
let phone: PhoneApi | undefined

export function providePhone(api: PhoneApi): void {
  phone = api
}

/** Making bots (main/bots.ts), and telling the window about a new one. */
export interface BotsApi {
  /** Make a bot for the caller's user; returns its project. */
  create(caller: string, bot: NewBot): Project
}

/** How the chat servers make bots; given once, when the app starts. */
let bots: BotsApi | undefined

export function provideBots(api: BotsApi): void {
  bots = api
}

/** Bots' routines (main/routines.ts), for the caller's bot. */
export type RoutinesApi = Pick<Routines, 'set' | 'list' | 'cancel'>

/** How the chat servers keep bots' routines; given once, when the app starts. */
let routines: RoutinesApi | undefined

export function provideRoutines(api: RoutinesApi): void {
  routines = api
}

/** A routine as the routine tools show it: its id, when it runs, and its note. */
function describeRoutine(routine: BotRoutine): string {
  const when = routine.time
    ? `at ${routine.time} ${routine.days ? `on ${routine.days.join(', ')}` : 'every day'}`
    : `every ${routine.everyHours === 1 ? 'hour' : `${routine.everyHours} hours`}`
  const next = new Date(routine.nextAt).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${routine.id}: ${when}, next ${next} (local time): ${routine.note}`
}

/** The voice agents speak with (main/speech), as the speak tool and show_step use it. */
export interface SpeechApi {
  /** Whether speech is on and the voice is on this Mac; the tools offer it only then. */
  on(): boolean
  /** Say a message out loud, after what plays already; throws why it cannot be said. */
  speak(chatId: string, text: string, language: Language, pace?: number): Spoken
  /** Say a message into a new WAV file; resolves with its length in seconds once written. */
  save(path: string, text: string, language: Language, pace?: number): Promise<number>
  /** Once everything the chat has said so far has been heard, or will not be. */
  said(chatId: string): Promise<void>
}

/** The voice the chat servers speak with; given once, when they start (browser-mcp.ts). */
let speech: SpeechApi | undefined

export function provideSpeech(api: SpeechApi): void {
  speech = api
}

/** Whether the chat servers offer the speak tool now, and show_step its `say`. */
export function speechOffered(): boolean {
  return speech?.on() === true
}

/** The voice, while it is offered. */
export function offeredSpeech(): SpeechApi | undefined {
  return speechOffered() ? speech : undefined
}

/** The language of something to say, as the voice takes it. */
export const languageArg = z
  .enum(LANGUAGES)
  .describe(
    'The language of the text: ar Arabic, en English, de German, fr French, es Spanish, and so on (ISO 639-1); na for a language not listed'
  )

/** How fast to say something, as the voice takes it. */
export const paceArg = z
  .number()
  .min(0.7)
  .max(1.5)
  .optional()
  .describe(
    'How fast to talk: 1 is normal (when left out); slower, down to 0.7, for something tricky or calming; faster, up to 1.5, for something light or quick'
  )

/** A chat as list_chats shows it. */
export interface ChatListing {
  id: string
  title: string
  self: boolean
  /** Started by the caller, with start_chat. */
  started: boolean
  /** "working", "waiting for the user", or how its last turn ended. */
  state: string
  /** The file its conversation is saved in, for the chats the caller started. */
  file?: string
}

/**
 * The agent and model a chat started with start_chat runs on, when the user
 * asked for others than the caller's. Each one left out is the caller's.
 */
export interface ModelChoice {
  agent?: AgentId
  /** The provider the model comes from, for an agent with several (as list_models names them). */
  provider?: string
  model?: string
  /** How hard the model thinks (low, medium, high, ...), as the chat's model offers it. */
  thinking?: string
}

/** A model as list_models shows it. */
export interface ListedModel {
  value: string
  name: string
}

/** What list_models shows: what the caller runs on, and every agent with its models. */
export interface ModelsListing {
  current: {
    agent: AgentId
    provider?: ListedModel
    model?: ListedModel
    /** The thinking level the caller's model is on, and the ones it offers, when it has any. */
    thinking?: { level: ListedModel; levels: ListedModel[] }
  }
  agents: {
    agent: AgentId
    /** Why the agent cannot be used now: not installed, not signed in, or its models not read. */
    error?: string
    sources: { provider?: ListedModel; models: ListedModel[]; error?: string }[]
  }[]
}

const agentLabel = (agent: AgentId): string => AGENTS.find((a) => a.id === agent)?.label ?? agent

/** A model or provider as list_models names it: its id, and its name when that differs. */
const quoted = (m: ListedModel): string =>
  m.name && m.name !== m.value ? `"${m.value}" (${m.name})` : `"${m.value}"`

/** One agent and its provider, as the headings of list_models name them. */
function sourceName(agent: AgentId, provider: ListedModel | undefined): string {
  return `${agentLabel(agent)}: agent "${agent}"${provider ? `, provider ${quoted(provider)}` : ''}`
}

/** The list_models answer: the caller's own agent and model, then each agent's models that match `search`. */
export function formatModels(listing: ModelsListing, search: string | undefined): string {
  const { current } = listing
  const lines = [
    `You run on ${sourceName(current.agent, current.provider)}${current.model ? `, model ${quoted(current.model)}` : ''}${current.thinking ? `, thinking level ${quoted(current.thinking.level)}` : ''}.`
  ]
  if (current.thinking) {
    lines.push(
      `Your model's thinking levels: ${current.thinking.levels.map(quoted).join(', ')}. Other models may have others; start_chat says which when the one asked for is not offered.`
    )
  }
  const query = search?.trim().toLowerCase()
  const hit = (...texts: (string | undefined)[]): boolean =>
    !query || texts.some((t) => t?.toLowerCase().includes(query))
  let shown = 0
  for (const { agent, error, sources } of listing.agents) {
    if (error) {
      if (hit(agent, agentLabel(agent)))
        lines.push('', `${sourceName(agent, undefined)}: cannot be used now: ${error}`)
      continue
    }
    for (const source of sources) {
      const whole = hit(agent, agentLabel(agent), source.provider?.value, source.provider?.name)
      const models = whole ? source.models : source.models.filter((m) => hit(m.value, m.name))
      if (!whole && models.length === 0) continue
      lines.push('', `${sourceName(agent, source.provider)}:`)
      if (source.error) lines.push(`  Its models could not be read: ${source.error}`)
      lines.push(...models.map((m) => `  ${quoted(m)}`))
      shown += models.length
    }
  }
  if (query && shown === 0) lines.push('', `No agent, provider or model matches "${search}".`)
  return lines.join('\n')
}

/** A chat's timer (see set_timer). */
export interface Timer {
  note: string
  /** When it goes off, in ms since the epoch. */
  at: number
}

/**
 * What a chat's agent is sent for a message from another chat. The first one
 * says where the sender's conversation is saved (`file`), to read if the task
 * leaves something out.
 */
export function fromChatPrompt(
  title: string,
  id: string,
  text: string,
  first: boolean,
  file: string
): string {
  if (first) {
    return `The chat "${title}" (chat ID ${id}) started this chat to hand you this task:

${text}

That chat's whole conversation is saved in ${file}: the user's messages, its answers and its tool calls with their output. If the task leaves out something you need, search that file for it. It can be long, so search it before reading it whole, and only read it, never change it.

Work on it on your own. When you are done, report back to that chat with send_message: what you did or found, and anything it must know or decide. Your report is all it sees of your work. If you cannot go on, report that too, with why.`
  }
  return `Message from the chat "${title}" (chat ID ${id}):

${text}

If it needs an answer, send it with send_message. Do not send messages only to acknowledge or thank.`
}

type ToolResult = { content: { type: 'text'; text: string }[] }

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] })

const chatArg = {
  chat: z
    .string()
    .describe('Your harness_chats key, given in the conversation. Never put it in a message.')
}

/** The chat tools for one request; a refusal is thrown and reaches the model as an error. */
export async function buildChatsServer(chats: ChatsApi): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const server = new McpServer(
    { name: SERVER_NAME, version: '1.0.0' },
    {
      instructions: CHATS_GUIDANCE
    }
  )

  server.registerTool(
    'start_chat',
    {
      description: `Start a new chat in this project, with the same permissions as yours, and send it a task. Only when the user asks for new chats; otherwise do the work yourself. A chat another chat started cannot start chats. It runs on the same agent, model and thinking level as yours. Only when the user asks for another agent, provider, model or thinking level for it, pick that one with "agent", "provider", "model" and "thinking", as list_models lists them; never pick one yourself. The new chat is not given this conversation, only told the file it is saved in, to look things up there: put everything it needs in "prompt" (the goal, the relevant paths, constraints, and what to report). It works on its own, alongside you, and reports back with send_message. Its report arrives here as a new message once your turn has ended; if it ends its turn without reporting (it finished, failed or was stopped), you are told that instead, with why. So do not wait or poll for it: start the chats you need, tell the user, and end your turn.`,
      inputSchema: {
        prompt: z.string().describe('The complete task, with all the context it needs'),
        agent: z
          .enum(AGENTS.map((a) => a.id) as [AgentId, ...AgentId[]])
          .optional()
          .describe(
            'Only when the user asks for it: the agent to run on, from list_models. Left out, it is yours.'
          ),
        provider: z
          .string()
          .optional()
          .describe(
            'Only with "model", for an agent whose models list_models shows by provider: the provider the model comes from'
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Only when the user asks for it: the model to run on, as list_models quotes it. Left out, it is yours, or the agent's default when you pick another agent."
          ),
        thinking: z
          .string()
          .optional()
          .describe(
            'Only when the user asks for it: how hard the model thinks, such as "low", "medium" or "high", from the levels the chat\'s model offers. Left out, it is yours when the chat is on your agent and its model offers it, or else the model\'s default. When the model does not offer it, the chat is not started and you are told the levels it has.'
          ),
        ...chatArg
      }
    },
    async ({ prompt, agent, provider, model, thinking, chat }) => {
      const started = await chats.startChat(chatForKey(chat), prompt, {
        agent,
        provider,
        model,
        thinking
      })
      const picks = [
        ...(agent || model ? [agent ? agentLabel(agent) : 'your agent'] : []),
        ...(model ? [`model "${model}"`] : []),
        ...(thinking ? [`thinking level "${thinking}"`] : [])
      ]
      const on = picks.length > 0 ? ` on ${picks.join(', ')}` : ''
      return text(
        `Started chat ${started.id} ("${started.title}")${on}. It reports back here when it is done.`
      )
    }
  )

  server.registerTool(
    'list_models',
    {
      description:
        'List the agents and models a chat you start with start_chat can run on, and the ones you run on, with your thinking level and the levels your model offers. Use it only when the user asks for new chats on another agent, provider, model or thinking level, to find the one they named; start_chat takes it with "agent", "provider", "model" and "thinking". It asks every installed agent for its models, so it can take a few seconds.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(
            'Only the agents, providers and models whose name or id has this text, such as "gpt" or "openrouter"; left out, all of them'
          ),
        ...chatArg
      },
      annotations: { readOnlyHint: true }
    },
    async ({ search, chat }) => text(formatModels(await chats.listModels(chatForKey(chat)), search))
  )

  server.registerTool(
    'send_message',
    {
      description: `Send a message to another chat of this project, by its chat ID (from start_chat, list_chats, or a message it sent you). It starts a turn in that chat, so it also gets a chat that stopped, failed or finished going again. If the chat is working, the message joins its turn at its next step, so you can steer it. Use it to report back to the chat that started you, or to coordinate with chats working alongside you. Do not send messages only to acknowledge or thank: a chat takes at most ${MAX_FROM_CHATS} messages from other chats between the user's messages. A chat with broader permissions than yours does not take messages from you, except the chat that started you.`,
      inputSchema: {
        to: z.string().describe('The chat ID of the chat to send it to'),
        message: z.string().describe('The message, with everything the other chat needs'),
        ...chatArg
      }
    },
    ({ to, message, chat }) =>
      text(
        {
          started: `Sent. Chat ${to} is working on it now.`,
          steering: `Sent. Chat ${to} is working, and reads your message at its next step.`
        }[chats.message(chatForKey(chat), to, message)]
      )
  )

  server.registerTool(
    'delete_chat',
    {
      description:
        'Delete a chat you started, by its chat ID, with all its messages. If it is working, it is stopped first. Only chats you started with start_chat can be deleted. Use it when the user asks, once a chat you started has reported back and you have used its result (unless the user may want to follow up in it), or to clear away one that is no longer needed, such as one you replace with a new one.',
      inputSchema: {
        to: z.string().describe('The chat ID of the chat to delete'),
        ...chatArg
      },
      annotations: { destructiveHint: true }
    },
    async ({ to, chat }) => {
      const title = await chats.deleteStartedChat(chatForKey(chat), to)
      return text(`Deleted chat ${to} ("${title}").`)
    }
  )

  server.registerTool(
    'rename_chat',
    {
      description:
        "Rename this chat: its title in Barebone's sidebar, and its topic in Telegram when it has one. Use it when the user asks for a new name.",
      inputSchema: {
        title: z.string().describe('The new title: a few words'),
        ...chatArg
      }
    },
    ({ title, chat }) => {
      const name = title.trim()
      if (!name) throw new Error('"title" is empty.')
      chats.renameChat(chatForKey(chat), name)
      return text(`Renamed this chat to "${name}".`)
    }
  )

  server.registerTool(
    'ask_approval',
    {
      description:
        'Ask the user to approve something before it goes out in their name: an email, a message, an application, a post, an order or a payment. Use it every time, right before you send, submit, post, pay, book or sign up for anything for them, unless they told you it may go out without asking. It shows a card in the chat (and in Telegram) with your question and the details, exactly what will go out, and the user answers Send, Change or Skip. It returns their answer: "approved" (send it now, exactly as shown), "skip" (do not send it) or "change: <what to change>" (revise it, then ask again). When they have not answered within a minute, it says so and the card stays: end your turn then, and their answer comes as a new message. In a bot\'s chat, a browser click on a send button is refused until the user answered Send in the last 10 minutes.',
      inputSchema: {
        question: z
          .string()
          .describe(
            'A short question naming what goes out and where: "Send the application to N26?"'
          ),
        details: z
          .string()
          .describe(
            'Exactly what goes out, as Markdown: the whole letter or message, and who it goes to; for an order or payment, what, how much and to whom. The user decides from this alone.'
          ),
        ...chatArg
      }
    },
    async ({ question, details, chat }, { signal }) => {
      if (!question.trim()) throw new Error('"question" is empty.')
      if (!details.trim()) throw new Error('"details" is empty: show exactly what goes out.')
      const approval = await chats.askApproval(chatForKey(chat), question.trim(), details, signal)
      return text(
        approval
          ? approvalText(approval)
          : 'The user has not answered yet. The card stays in the chat, and their answer comes to you as a new message. Do not send it before then: end your turn now.'
      )
    }
  )

  if (bots) {
    const maker = bots
    const taken = store
      .getState()
      .projects.flatMap((p) => (p.bot && p.color ? [`${p.name} is ${p.color}`] : []))
    server.registerTool(
      'create_bot',
      {
        description:
          "Make a bot: a helper with a personality, a memory and a folder of its own in Barebone, which the user talks to in one conversation that goes on for good, for an ongoing job they hand over, such as applying for jobs, looking for a flat or watching a page. Only when the user asks for a bot. Before you make it, ask the user what you need to know and they have not said: what it should do, where (sites, cities) and whether it may send, submit or pay on its own or must ask first. Ask with your question tool if you have one, in as few questions as you can. The bot's folder gets an AGENTS.md with your instructions and how it keeps its memory, its records and a dashboard it builds itself; its conversation starts from it. Files the user gave you for the bot (a CV, say) are not moved there: copy them into the folder's files/ after making it, with your own tools. Do not start on the bot's job in this chat: the user talks to the bot in its own conversation.",
        inputSchema: {
          name: z
            .string()
            .describe(
              'Its name, short and friendly, like a character\'s: "Jobby", "Nesty". It names its folder too.'
            ),
          job: z
            .string()
            .describe('What it does, in a few words: "Applies to marketing jobs in Berlin"'),
          personality: z
            .string()
            .describe(
              'Who it is, written to the bot as "You are…": how it talks and behaves, as a person would, such as cheerful and brief, calm and thorough, dry humour, calls the user by name. Fit it to its job and to what the user said they like. A few sentences.'
            ),
          instructions: z
            .string()
            .describe(
              "Everything it must know to do the job well, written to the bot: the goal, the user's wishes and limits, the sites and accounts to use, what may go out without asking and what must be asked first, and what to keep track of. Markdown, without a title: it goes under the bot's own."
            ),
          shape: z
            .enum(BOT_SHAPES)
            .describe(
              'Its character: box (an office type), round (a robot with an antenna), ghost (a watcher), house (for homes), cat, cloud. Pick one that fits its job.'
            ),
          color: z
            .enum(PROJECT_COLORS)
            .describe(
              `Its color, which marks its chats. Pick one the user's other bots do not have, if you can.${taken.length > 0 ? ` Their bots: ${taken.join(', ')}.` : ''}`
            ),
          ...chatArg
        }
      },
      ({ name, job, personality, instructions, shape, color, chat }) => {
        const project = maker.create(chatForKey(chat), {
          name,
          job,
          personality,
          instructions,
          shape,
          color
        })
        return text(
          `Made the bot "${project.name}" (project ID ${project.id}) in ${project.path}. Its folder is set up as it should be: leave it as it is, and only copy in files the user gave you for it, into ${join(project.path, 'files')}. The bot makes its own memory, records and dashboard as it works. Tell the user in a line or two what the bot will do; they open it from the card under your answer or from Bots in the sidebar.`
        )
      }
    )
  }

  // Offered once the user has a bot: only a bot's own conversation can use them.
  if (routines && store.getState().projects.some((p) => p.bot)) {
    const kept = routines
    server.registerTool(
      'set_routine',
      {
        description:
          'Only in a bot\'s own conversation. Set a routine: regular work the user asked for, such as "every weekday at 8, look for new jobs". Give a note of what to do and when: "time" (with "days" when not every day), or "everyHours". Each time it comes due, this conversation gets your note as a new message, and you do the work then. A run missed while the Mac was off or asleep happens once when it is back. Set one only when the user asks for regular work, and tell them when it first runs.',
        inputSchema: {
          note: z
            .string()
            .describe('What to do each time, written to yourself, with what you will need to know'),
          time: z
            .string()
            .optional()
            .describe('The local time it runs at, as "HH:MM" on a 24-hour clock, such as "08:00"'),
          days: z
            .array(z.enum(WEEKDAYS))
            .optional()
            .describe('Only with "time": the days it runs on. Left out, every day.'),
          everyHours: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Instead of "time": run every this many hours, at least 1'),
          ...chatArg
        }
      },
      ({ note, time, days, everyHours, chat }) => {
        const routine = kept.set(chatForKey(chat), { note, time, days, everyHours })
        return text(`Routine set. ${describeRoutine(routine)}`)
      }
    )

    server.registerTool(
      'list_routines',
      {
        description:
          "Only in a bot's own conversation. List your routines, the next one first: each one's id, when it runs, when it runs next and its note.",
        inputSchema: { ...chatArg },
        annotations: { readOnlyHint: true }
      },
      ({ chat }) => {
        const all = kept.list(chatForKey(chat))
        return text(all.length > 0 ? all.map(describeRoutine).join('\n') : 'You have no routines.')
      }
    )

    server.registerTool(
      'cancel_routine',
      {
        description:
          "Only in a bot's own conversation. End one of your routines, by its id from set_routine or list_routines, when the user no longer wants that regular work. To change one, cancel it and set a new one.",
        inputSchema: {
          id: z.string().describe("The routine's id"),
          ...chatArg
        },
        annotations: { destructiveHint: true }
      },
      ({ id, chat }) => {
        const routine = kept.cancel(chatForKey(chat), id)
        return text(`Cancelled routine ${routine.id}: ${routine.note}`)
      }
    )
  }

  if (phone?.on()) {
    const bot = phone
    server.registerTool(
      'send_file',
      {
        description:
          "Send a file from this Mac to the user's phone, in the Telegram topic of this chat (or of the chat that started it). Images come as photos, MP4 and MOV videos as videos, anything else as a file, up to 50 MB. Use it for something the user should see or keep: a video or image you made, a PDF, a report. Screenshots from the browser tools and videos from start_recording reach the phone by themselves.",
        inputSchema: {
          path: z.string().describe('Absolute path of the file to send'),
          caption: z.string().optional().describe('A line shown under it'),
          ...chatArg
        }
      },
      async ({ path, caption, chat }) => {
        if (!isAbsolute(path)) throw new Error(`"path" must be absolute: ${path}`)
        return text(await bot.sendFile(chatForKey(chat), path, caption))
      }
    )
  }

  server.registerTool(
    'run_in_background',
    {
      description:
        "Run a shell command in the project folder in the background, and be woken when it ends: a download, an install, a long build or test run, or a server that keeps running (a dev server, a watcher). A command that ends within a couple of minutes is better run with your own shell tool, which waits for it and gives you its output in this turn. Use it instead of your own shell's background mode or &: those cannot wake this chat, and cannot be checked on or stopped with these tools. It returns at once with the command's process ID. When the command ends, this chat gets a message with its exit code and the end of its output, as a new turn or at the next step of the current one. So for a command whose result you need, end your turn after starting it, without waiting or polling. read_background shows its output so far and stop_background stops it. Background commands stop when the app quits.",
      inputSchema: {
        command: z.string().describe('The bash command to run'),
        timeout: z
          .number()
          .positive()
          .optional()
          .describe(
            'Seconds after which the command is stopped, which wakes you as its end does. Leave it out for a server that should keep running.'
          ),
        ...chatArg
      }
    },
    async ({ command, timeout, chat }) => {
      const { pid, log } = await chats.runInBackground(chatForKey(chat), command, timeout)
      return text(
        `Started in the background (process ${pid}). Its output goes to ${log}. This chat is woken with the result when it ends, so if you need its result, end your turn now.`
      )
    }
  )

  server.registerTool(
    'list_background',
    {
      description:
        'List your background commands that are still running, with their process IDs and how long they have run, and your timer if one is set.',
      inputSchema: { ...chatArg },
      annotations: { readOnlyHint: true }
    },
    ({ chat }) => {
      const { commands, timer } = chats.listBackground(chatForKey(chat))
      const lines = commands.map(
        (c) =>
          `Process ${c.pid}, running for ${formatDuration(c.ms)}${c.timeout !== undefined ? ` of its ${formatDuration(c.timeout * 1000)} timeout` : ''}: ${c.command}`
      )
      if (lines.length === 0) lines.push('No background commands are running.')
      lines.push(
        timer
          ? `Your timer goes off in ${formatDuration(timer.at - Date.now())}: ${timer.note}`
          : 'No timer is set.'
      )
      return text(lines.join('\n'))
    }
  )

  server.registerTool(
    'read_background',
    {
      description:
        'Show a background command of yours that is still running: how long it has run and the end of its output so far. Use it to check on a server or a long run when you need to know now. For a final result, end your turn and be woken instead.',
      inputSchema: {
        pid: z.number().int().describe('Its process ID, from run_in_background or list_background'),
        ...chatArg
      },
      annotations: { readOnlyHint: true }
    },
    async ({ pid, chat }) => {
      const c = await chats.readBackground(chatForKey(chat), pid)
      return text(
        [
          `Process ${c.pid} has run for ${formatDuration(c.ms)}: ${c.command}`,
          c.output.trim()
            ? `End of its output so far:\n${c.output.trimEnd()}`
            : 'It has printed nothing yet.',
          `Full output: ${c.log}`
        ].join('\n\n')
      )
    }
  )

  server.registerTool(
    'stop_background',
    {
      description:
        'Stop a background command of yours, with every process it started, and get the end of its output. Stopping it does not wake you.',
      inputSchema: {
        pid: z.number().int().describe('Its process ID, from run_in_background or list_background'),
        ...chatArg
      },
      annotations: { destructiveHint: true }
    },
    async ({ pid, chat }) => {
      const f = await chats.stopBackground(chatForKey(chat), pid)
      return text(
        [
          `Stopped process ${f.pid} after ${formatDuration(f.ms)}: ${f.command}`,
          f.output.trim() ? `End of its output:\n${f.output.trimEnd()}` : 'It printed nothing.',
          `Full output: ${f.log}`
        ].join('\n\n')
      )
    }
  )

  server.registerTool(
    'set_timer',
    {
      description: `Wake this chat after a number of seconds, with a note to yourself of what to do then. Use it to check back on something nothing else tells you about, such as a deploy, a CI run or a page that updates; a background command and a chat you started wake you on their own. A chat has one timer: setting it again replaces the one before, and cancel_timer clears it. When it goes off, this chat gets your note as a new turn, or at the next step of the current one, so end your turn after setting it. The user's Stop clears it, and so does quitting the app. Each time it goes off counts toward the ${MAX_FROM_CHATS} messages a chat takes from other chats, commands and timers between the user's messages, so do not check more often than you need.`,
      inputSchema: {
        seconds: z
          .number()
          .min(1)
          .max(MAX_TIMER_SECONDS)
          .describe(`Seconds from now, at most ${MAX_TIMER_SECONDS} (a day)`),
        note: z.string().describe('What to do when it goes off'),
        ...chatArg
      }
    },
    ({ seconds, note, chat }) => {
      chats.setTimer(chatForKey(chat), seconds, note)
      return text(
        `Timer set: this chat is woken in ${formatDuration(seconds * 1000)} with your note. End your turn now.`
      )
    }
  )

  server.registerTool(
    'cancel_timer',
    {
      description: "Clear this chat's timer, when what it was for is done or no longer needed.",
      inputSchema: { ...chatArg }
    },
    ({ chat }) => text(chats.cancelTimer(chatForKey(chat)) ? 'Timer cleared.' : 'No timer was set.')
  )

  server.registerTool(
    'list_chats',
    {
      description:
        'List the chats you started, with how each is doing (working, waiting for the user, or how its last turn ended, with the error when it failed) and the file its conversation is saved in, and the other chats of this project that are working now. Use it to see why a chat you started stopped; send_message gets it going again.',
      inputSchema: { ...chatArg },
      annotations: { readOnlyHint: true }
    },
    ({ chat }) =>
      text(
        chats
          .listChats(chatForKey(chat))
          .map((c) =>
            [
              c.id,
              c.title,
              c.self ? 'this chat' : c.state,
              ...(c.started ? ['started by you'] : []),
              ...(c.file ? [`saved in ${c.file}`] : [])
            ].join('\t')
          )
          .join('\n')
      )
  )

  if (speech && speechOffered()) {
    const voice = speech
    server.registerTool(
      'speak',
      {
        description:
          "Say something out loud in Barebone's voice, a natural voice that runs on the user's Mac. It is the voice for anything spoken, so never use macOS say or another text-to-speech. Without path, it plays to the user now, alongside your written reply: when you need their answer or permission, when a long task is done or something went wrong, or to keep them in the loop while they watch the browser. Keep that short: one to three plain sentences, never code, file paths, URLs, lists or tables. It returns at once, while the voice plays. With path, it saves the speech to a new .wav file instead, for audio or a video you make yourself, and returns once it is written. To narrate a step of a tutorial or video in the browser, use show_step's say instead.",
        inputSchema: {
          text: z.string().describe('What to say: plain spoken sentences'),
          language: languageArg,
          pace: paceArg,
          path: z
            .string()
            .optional()
            .describe(
              'Absolute path of a new .wav file to save the speech to, instead of playing it'
            ),
          ...chatArg
        }
      },
      async ({ text: said, language, pace, path, chat }) => {
        const caller = chatForKey(chat)
        if (path === undefined) {
          voice.speak(caller, said, language, pace)
          return text('Speaking it to the user now.')
        }
        if (!isAbsolute(path)) throw new Error(`"path" must be absolute: ${path}`)
        if (!path.toLowerCase().endsWith('.wav')) {
          throw new Error(
            `The speech is saved as a WAV file: "path" must end in .wav, not ${path}.`
          )
        }
        const seconds = await voice.save(path, said, language, pace)
        return text(`Saved ${seconds.toFixed(1)}s of speech to ${path}.`)
      }
    )
  }

  return server
}
