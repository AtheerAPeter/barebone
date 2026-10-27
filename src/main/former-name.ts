import { app, dialog } from 'electron'
import { existsSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The app was called Just Harness up to 1.0.63, and Electron keeps an app's
 * data in a folder named after it. On the first start under the new name, move
 * the old folder in: projects, chats, settings and the browser profile. This
 * runs when imported, first thing in index.ts, before other modules read or
 * create files there. Electron has made the new folder by then, empty.
 */
const FORMER_NAME = 'Just Harness'

const from = join(app.getPath('appData'), FORMER_NAME)
const to = app.getPath('userData')

if (existsSync(from) && isEmpty(to)) {
  // Moving the folder from under a running Just Harness would leave it writing
  // to files that are no longer there.
  if (running(from)) {
    dialog.showErrorBox(
      `Quit ${FORMER_NAME} first`,
      `${FORMER_NAME} is now called ${app.getName()}. Quit ${FORMER_NAME}, then open ${app.getName()} again to bring over your projects, chats and settings.`
    )
    process.exit(0)
  }
  rmSync(to, { recursive: true, force: true })
  renameSync(from, to)
}

function isEmpty(dir: string): boolean {
  return !existsSync(dir) || readdirSync(dir).length === 0
}

/**
 * Whether the app holding the folder still runs. Chromium links SingletonLock
 * to "<host>-<pid>" while it runs, and a crash leaves the link behind.
 */
function running(dir: string): boolean {
  try {
    const pid = Number(readlinkSync(join(dir, 'SingletonLock')).split('-').pop())
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
