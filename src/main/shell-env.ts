import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { delimiter, join } from 'node:path'

const MARKER = '__BAREBONE_PATH__'

let loading: Promise<void> | undefined

/**
 * Apps launched from Finder/Dock inherit launchd's minimal PATH, so CLIs installed
 * via Homebrew, npm or curl scripts are not found. Read PATH from the user's
 * interactive login shell instead, the same way terminals see it.
 *
 * Read once, starting at launch without holding up the window. Await it before
 * running a command found on PATH.
 */
export function loadShellPath(): Promise<void> {
  loading ??= readShellPath()
  return loading
}

function readShellPath(): Promise<void> {
  const shell = process.env.SHELL || userInfo().shell || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`],
      { timeout: 10_000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => {
        const match = stdout?.match(new RegExp(`${MARKER}(.*)${MARKER}`))
        if (match?.[1]) process.env.PATH = match[1]
        else if (error) console.error('Could not read PATH from login shell:', error.message)
        resolve()
      }
    )
  })
}

/** Where a CLI is on the user's PATH, or undefined when it is not installed. */
export async function commandPath(command: string): Promise<string | undefined> {
  await loadShellPath()
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const path = join(dir, command)
    try {
      await access(path, constants.X_OK)
      return path
    } catch {
      // Not in this folder.
    }
  }
  return undefined
}

/** What a CLI on the user's PATH prints for --version (its last line), or undefined when it is not installed. */
export async function commandVersion(command: string): Promise<string | undefined> {
  await loadShellPath()
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim().split('\n').pop())
    )
  })
}
