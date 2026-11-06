import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * What Control from Telegram keeps between launches: the bot token, who the
 * bot answers (the one Telegram user who paired with it), which chat it
 * controls, and the next update to read. Kept in its own file, readable only
 * by the user, since the token controls the bot; the window only sees the
 * token's last four characters.
 */
export interface TelegramConfig {
  token?: string
  /** The paired Telegram user, and their private chat with the bot. */
  owner?: { userId: number; chatId: number }
  linkedChatId?: string
  /** getUpdates' offset: the update after the last one handled. */
  offset?: number
}

const configPath = join(app.getPath('userData'), 'data', 'telegram.json')

let config: TelegramConfig = load()

function load(): TelegramConfig {
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as TelegramConfig
  } catch (error) {
    console.error(`${configPath} could not be read:`, (error as Error).message)
    return {}
  }
}

export function telegramConfig(): Readonly<TelegramConfig> {
  return config
}

/** Change what is kept; the file goes once nothing is. */
export function updateTelegramConfig(patch: Partial<TelegramConfig>): void {
  config = { ...config, ...patch }
  if (!config.token) {
    config = {}
    rmSync(configPath, { force: true })
    return
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
}

/** The saved token's last four characters; null when none is saved. */
export function telegramTokenHint(): string | null {
  return config.token ? config.token.slice(-4) : null
}
