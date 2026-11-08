import type { AgentOption, ChatItem, TelegramStatus } from '../shared/types'
import { AgentManager } from '../main/agents'
import {
  chatsMcpEndpoint,
  SERVER_NAME as BROWSER_SERVER,
  startBrowserMcp
} from '../main/browser-mcp'
import { SERVER_NAME as CHATS_SERVER } from '../main/chats-mcp'
import { registerWithCline } from '../main/cline-mcp'
import * as store from '../main/store'
import { TelegramBridge } from '../main/telegram/bridge'
import { telegramConfig } from '../main/telegram/config'
import { serverConfig } from './config'
import { HeadlessBrowser } from './headless-browser'
import { openLinksWith } from './runtime'

/** How long stopping waits for the agents and the browser. */
const STOP_DEADLINE = 5000

/**
 * `barebone start`: the agents and the Telegram bot, in the foreground, wired
 * as the app wires them (main/index.ts), with a headless browser in place of
 * the panel and no window.
 */
export async function start(): Promise<void> {
  if (!telegramConfig().token) {
    console.error('No bot token is set. Run `barebone setup` first.')
    process.exitCode = 1
    return
  }
  const damaged = store.takeDamagedState()
  if (damaged) {
    console.error(
      `The saved projects and chats could not be read; Barebone started without them. The damaged file was kept at ${damaged}.`
    )
  }

  const isRunning = (chatId: string): boolean =>
    store.getState().chats.some((c) => c.id === chatId && c.running)
  const browser = new HeadlessBrowser(isRunning, {
    get: (chatId) => store.getState().chats.find((c) => c.id === chatId)?.browserTabs,
    set: (chatId, tabs) => {
      if (store.getState().chats.some((c) => c.id === chatId)) {
        store.updateChat(chatId, { browserTabs: tabs })
      }
    }
  })

  const agents = new AgentManager(
    {
      item: (chatId: string, item: ChatItem) => telegram.item(chatId, item),
      options: (chatId: string, options: AgentOption[]) => telegram.options(chatId, options),
      // The window's slash-command menu; Telegram sends commands as typed.
      commands: () => undefined,
      stateChanged: () => {
        telegram.stateChanged()
        // A chat that stopped running no longer needs its browser.
        browser.prune()
      }
    },
    () => undefined
  )

  const deleteChat = async (chatId: string): Promise<void> => {
    await agents.deleteChat(chatId)
    browser.closeChat(chatId)
  }

  let lastStatus = ''
  const telegram: TelegramBridge = new TelegramBridge({
    machine: 'the server',
    linksOpen: 'here',
    // Voice notes are written out on the Mac only.
    send: (chatId, text, attachments) => agents.send(chatId, text, attachments),
    createChat: (projectId, like) =>
      store.createChat({
        projectId,
        agent: like.agent,
        settings: { ...like.settings },
        bypassPermissions: like.bypassPermissions,
        projectOnly: like.projectOnly
      }),
    newChatDefaults: () => {
      const { agent } = serverConfig()
      return agent ? { agent, settings: {} } : undefined
    },
    deleteChat,
    openChat: (chatId) => agents.open(chatId),
    agentStatus: (agent) => agents.status(agent),
    agentModels: (agent, projectId) => agents.models(agent, projectId),
    setOption: (chatId, optionId, value) => agents.setOption(chatId, optionId, value),
    changeAgent: (chatId, agent, settings) => agents.changeAgent(chatId, agent, settings),
    cancel: (chatId) => agents.cancel(chatId),
    resolvePermission: (chatId, permissionId, optionId) =>
      agents.resolvePermission(chatId, permissionId, optionId),
    answerForm: (chatId, formId, answers) => agents.answerForm(chatId, formId, answers),
    turnEnd: (chatId) => agents.turnEnd(chatId),
    statusChanged: (status) => {
      const line = describe(status)
      if (line && line !== lastStatus) console.log(line)
      lastStatus = line
    }
  })
  openLinksWith((url) => telegram.openLink(url))

  const endpoint = await startBrowserMcp({
    browser,
    routing: {
      chatForBrowserId: (id) => store.getState().chats.find((c) => c.id.startsWith(id))?.id,
      fallbackChat: () => agents.latestActiveChat()
    },
    chats: agents
  })
  telegram.start()
  console.log(`Barebone ${BAREBONE_VERSION} is running. Stop it with Ctrl+C.`)

  // Cline keeps servers in its own settings; one at a time, as each rewrites them.
  void agents.status('cline').then(async ({ available }) => {
    if (!available) return
    for (const [name, at] of [
      [BROWSER_SERVER, endpoint],
      [CHATS_SERVER, chatsMcpEndpoint()]
    ] as const) {
      await registerWithCline(name, at).catch((error) =>
        console.error(`Could not register ${name} with cline:`, error.message)
      )
    }
  })

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    console.log('Stopping…')
    telegram.stop()
    const stopped = agents.stopAll()
    try {
      store.flush()
    } catch (error) {
      console.error('Could not save before stopping:', error)
    }
    const deadline = new Promise((resolve) => setTimeout(resolve, STOP_DEADLINE))
    void Promise.race([Promise.allSettled([stopped, browser.close()]), deadline]).then(() =>
      process.exit(0)
    )
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** The bot's status as a log line. */
function describe(status: TelegramStatus): string {
  switch (status.state) {
    case 'off':
      return 'Telegram: no bot token.'
    case 'error':
      return `Telegram: ${status.error}`
    case 'pairing':
      return status.bot && status.code
        ? `Telegram: open https://t.me/${status.bot}?start=${status.code} on your phone to pair with @${status.bot}.${status.error ? ` (${status.error})` : ''}`
        : `Telegram: connecting…${status.error ? ` (${status.error})` : ''}`
    case 'ready':
      return `Telegram: @${status.bot ?? 'bot'} is ready${status.linkedTitle ? `, controlling “${status.linkedTitle}”` : ''}.${status.error ? ` (${status.error})` : ''}`
  }
}
