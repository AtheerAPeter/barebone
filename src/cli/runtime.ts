import { homedir } from 'node:os'
import { join } from 'node:path'
import { setRuntime } from '../main/runtime'

/**
 * The command's runtime (main/runtime.ts), set up by the entry's first import.
 * Its data is in BAREBONE_HOME, or else in the XDG data folder.
 */
export const dataHome =
  process.env.BAREBONE_HOME ||
  join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'barebone')

/** Where links go: a server has no browser for them, so `start` sends them to Telegram. */
let openLink: ((url: string) => void) | undefined

export function openLinksWith(open: (url: string) => void): void {
  openLink = open
}

setRuntime({
  userData: dataHome,
  version: BAREBONE_VERSION,
  openExternal: async (url) => {
    if (!openLink) throw new Error(`There is no browser on this server to open ${url}.`)
    openLink(url)
  }
})
