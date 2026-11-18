import { existsSync } from 'node:fs'

/**
 * What agents run comes after the app: their programs, the commands they
 * start, and the terminal. A heavy job there (a transcription, a build) must
 * not starve the app, which answers the window and the remote link; on a
 * server, the link is the only way in.
 *
 * So these start through nice, which runs them, and everything they start in
 * turn, at a lower CPU priority (and with it a lower disk priority on Linux).
 * On Linux they start through choom too, so that when memory runs out the
 * kernel ends one of them rather than the app. Both replace themselves with
 * the program, which keeps its process id.
 */

/** Niceness: 10 of 19, so agents still get the whole CPU while the app is idle. */
const NICENESS = '10'
/** Added to the kernel's out-of-memory score (-1000 to 1000); the app keeps 0. */
const OOM_SCORE_ADJ = '500'

const NICE = '/usr/bin/nice'
const CHOOM = '/usr/bin/choom'
const hasNice = existsSync(NICE)
/** The programs that start another below the app, in front for a moment until they replace themselves. */
export const STARTERS = new Set(['nice', 'choom'])
const hasChoom = process.platform === 'linux' && existsSync(CHOOM)

export interface Command {
  command: string
  args: string[]
}

/** How to start the program below the app. */
export function belowApp({ command, args }: Command): Command {
  let started = { command, args }
  if (hasNice) started = { command: NICE, args: ['-n', NICENESS, started.command, ...started.args] }
  if (hasChoom) {
    started = {
      command: CHOOM,
      args: ['-n', OOM_SCORE_ADJ, '--', started.command, ...started.args]
    }
  }
  return started
}
