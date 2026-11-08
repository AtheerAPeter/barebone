import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentId } from '../shared/types'
import { userDataPath } from '../main/runtime'

/**
 * What `barebone setup` keeps besides the projects and the bot: the agent new
 * chats start with when there is no chat to take it from. On the Mac the
 * window keeps that; a server has none.
 */
export interface ServerConfig {
  agent?: AgentId
}

const path = (): string => join(userDataPath(), 'data', 'server.json')

export function serverConfig(): ServerConfig {
  if (!existsSync(path())) return {}
  try {
    return JSON.parse(readFileSync(path(), 'utf8')) as ServerConfig
  } catch (error) {
    console.error(`${path()} could not be read:`, (error as Error).message)
    return {}
  }
}

export function updateServerConfig(patch: Partial<ServerConfig>): void {
  mkdirSync(dirname(path()), { recursive: true })
  writeFileSync(path(), JSON.stringify({ ...serverConfig(), ...patch }), { mode: 0o600 })
}
