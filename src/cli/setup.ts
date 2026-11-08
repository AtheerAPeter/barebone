import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { AGENTS, type AgentId } from '../shared/types'
import { AgentManager } from '../main/agents'
import * as store from '../main/store'
import { BotApi, TelegramError, type TelegramUser } from '../main/telegram/api'
import { telegramConfig, telegramTokenHint, updateTelegramConfig } from '../main/telegram/config'
import { serverConfig, updateServerConfig } from './config'
import { dataHome } from './runtime'

/**
 * `barebone setup`: the bot token, the projects (folders on this server), and
 * the agent new chats start with. Run it again to change any of them; Enter
 * keeps what is set.
 */
export async function setup(): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  // Answers are read as lines, which are kept until asked for: question() would
  // drop the lines that arrive while nothing is asked, as piped answers do.
  const lines = prompt[Symbol.asyncIterator]()
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question)
    const answer = await lines.next()
    if (answer.done) throw new Error('\nSetup stopped: the input ended before it was done.')
    return answer.value.trim()
  }
  try {
    console.log(`Barebone keeps its data in ${dataHome}\n`)
    await setToken(ask)
    await addProjects(ask)
    await pickAgent(ask)
    store.flush()
    console.log(
      '\nDone. Run `barebone start`, open the pairing link it prints on your phone, and the bot is yours.' +
        '\nTo keep it running after you log out and across reboots, install it as a service: `barebone service`.'
    )
  } finally {
    prompt.close()
  }
}

type Ask = (question: string) => Promise<string>

/** The bot from @BotFather. A new token pairs again and links no chat, as in the app. */
async function setToken(ask: Ask): Promise<void> {
  const hint = telegramTokenHint()
  for (;;) {
    const token = await ask(
      hint
        ? `Telegram bot token (saved: …${hint}; Enter keeps it): `
        : 'Telegram bot token, from @BotFather: '
    )
    if (!token && hint) return
    if (!token) continue
    try {
      const me = await new BotApi(token).call<TelegramUser>('getMe')
      if (token !== telegramConfig().token) {
        updateTelegramConfig({
          token,
          owner: undefined,
          linkedChatId: undefined,
          offset: undefined
        })
      }
      console.log(`Bot: @${me.username}\n`)
      return
    } catch (error) {
      console.log(
        error instanceof TelegramError && (error.code === 401 || error.code === 404)
          ? 'Telegram didn’t accept this token. Copy it again from @BotFather.'
          : `Couldn’t reach Telegram: ${(error as Error).message}`
      )
    }
  }
}

async function addProjects(ask: Ask): Promise<void> {
  const list = (): void => {
    const { projects } = store.getState()
    console.log(
      projects.length
        ? `Projects:\n${projects.map((p) => `  ${p.name}  ${p.path}`).join('\n')}`
        : 'No projects yet.'
    )
  }
  list()
  for (;;) {
    const answer = await ask('Add a project folder (its path; Enter when done): ')
    if (!answer) {
      if (store.getState().projects.length) break
      console.log('Add at least one: chats work in a project folder.')
      continue
    }
    const path = resolve(answer.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      console.log(`${path} is not a folder.`)
      continue
    }
    if (store.getState().projects.some((p) => p.path === path)) {
      console.log(`${path} is a project already.`)
      continue
    }
    store.addProject({ id: crypto.randomUUID(), name: basename(path), path, createdAt: Date.now() })
    list()
  }
  console.log()
}

/** The agent new chats start with; /model in Telegram switches a chat to another agent or model. */
async function pickAgent(ask: Ask): Promise<void> {
  console.log('Checking which agents are installed…')
  const agents = new AgentManager(
    {
      item: () => undefined,
      options: () => undefined,
      commands: () => undefined,
      stateChanged: () => undefined
    },
    () => undefined
  )
  const statuses = await Promise.all(AGENTS.map(({ id }) => agents.status(id)))
  const available = AGENTS.filter((_, n) => statuses[n].available)
  if (!available.length) {
    console.log(
      'No agent is ready on this server. Install one (opencode, cline, codex, Claude Code or Command Code) and sign it in, then run setup again.'
    )
    return
  }
  const current = serverConfig().agent
  available.forEach(({ id, label }, n) =>
    console.log(`  ${n + 1}. ${label}${id === current ? ' (now)' : ''}`)
  )
  for (;;) {
    const answer = await ask(`Agent new chats start with${current ? ' (Enter keeps it)' : ''}: `)
    if (!answer && current) return
    const picked = available[Number(answer) - 1]
    if (picked) {
      updateServerConfig({ agent: picked.id as AgentId })
      return
    }
  }
}
