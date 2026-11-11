// First: moves the data folder of the app's former name before anything uses it.
import './former-name'
import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme, protocol } from 'electron'
import { handle, handleAs, listen, MAC_ONLY, onCallerGone, type Caller } from './remote/registry'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../resources/icon.png?asset'
import type {
  AgentCommand,
  Attachment,
  AgentId,
  AgentOption,
  ChatItem,
  ChatPermissions,
  CodeDoc,
  CustomProviderInput,
  FormAnswers,
  GitBranch,
  GitChange,
  GitStatus,
  OrbState,
  WalkControl,
  Project,
  Rect,
  SkillScope,
  Theme,
  DownloadId,
  Downloads,
  VoiceModelId
} from '../shared/types'
import { BOT_SCHEME, REMOTE_BOTS } from '../shared/types'
import * as store from './store'
import { AgentManager } from './agents'
import { BotNotices } from './bot-notices'
import { Routines } from './routines'
import { BuiltinBrowser } from './browser'
import {
  chatsMcpEndpoint,
  devicesMcpEndpoint,
  SERVER_NAME as BROWSER_SERVER,
  startBrowserMcp
} from './browser-mcp'
import {
  SERVER_NAME as CHATS_SERVER,
  provideBots,
  providePhone,
  provideRoutines
} from './chats-mcp'
import { registerWithCline, unregisterFromCline } from './cline-mcp'
import { DeviceManager } from './devices'
import { SERVER_NAME as DEVICES_SERVER } from './devices-mcp'
import { TelegramBridge } from './telegram/bridge'
import { RemoteLink } from './remote'
import { exaKeyHint, setExaKey } from './exa-key'
import { microphoneAccess, setVoiceKey, transcribe, voiceKeyHint } from './voice'
import {
  checkCustomProvider,
  customProviders,
  removeCustomProvider,
  saveCustomProvider
} from './harness/custom'
import { installMenu } from './menu'
import { AgentOrb } from './orb'
import { PageRecorder } from './recording'
import { MAX_MUSIC_SECONDS, Speech } from './speech'
import type { Language } from './speech/supertonic'
import { VideoTools } from './video'
import { loadShellPath } from './shell-env'
import * as skills from './skills'
import { listProjectFiles } from './files'
import * as git from './git'
import { WalkPlayer } from './walkthrough'
import { chooseProjectIcon, projectIcon } from './project-icon'
import { handleImageRequests, imageScheme, thumbnail } from './images'
import {
  botScheme,
  createBot,
  DASHBOARD,
  handleBotRequests,
  hasDashboard,
  memory,
  remoteKey,
  watchBot
} from './bots'
import { availableUpdate, checkForUpdates, installUpdate, watchForUpdates } from './updates'

/**
 * An error nothing caught is written to ~/Library/Logs/Barebone/main.log.
 * Electron's own handler shows a box instead, and the box holds this whole
 * process until someone at the Mac clicks OK: the remote link and Telegram
 * stop answering with it, locking out a user who is away.
 */
function logUncaught(kind: string, error: unknown): void {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`${kind}:`, text)
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main.log'), `${new Date().toISOString()} ${kind}: ${text}\n`)
  } catch {
    // Nowhere to write it; the console has it.
  }
}
process.on('uncaughtException', (error) => logUncaught('Uncaught exception', error))
process.on('unhandledRejection', (reason) => logUncaught('Unhandled rejection', reason))

let mainWindow: BrowserWindow
let browser: BuiltinBrowser | undefined
/** The voice agents speak with; made once the app has its name, which its data folder is under. */
let speech: Speech
/** ffmpeg, for videos' thumbnails; made with the voice. */
let videoTools: VideoTools
/** Records browser tabs as videos, in the window; made with the window. */
let recorder: PageRecorder | undefined
/** Plays agents' code walkthroughs, with the voice; made with the voice. */
let walks: WalkPlayer
/** Set once the app is quitting: closing the window then really closes it. */
let quitting = false
/** How long quitting waits for the agents and the browser to stop. */
const QUIT_DEADLINE = 5000

/**
 * Tell the window, and the pages of the remote link that show it; false when
 * there is no window to tell.
 */
function send(channel: string, ...args: unknown[]): boolean {
  remote.event(channel, args)
  // Nothing to tell before the window exists; it asks for the state it shows when it loads.
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.webContents.send(channel, ...args)
  return true
}

/** This app in a browser anywhere, through zrok (remote/index.ts). */
const remote = new RemoteLink({
  state: () => store.getState(),
  statusChanged: (status) => send('remote:status', status)
})

/** What is downloaded, and what is downloading: the voices, the music model and ffmpeg. */
function downloads(): Downloads {
  return { ...speech.downloads(), ffmpeg: videoTools.ffmpeg.status() }
}

/**
 * Download Supertonic when speech is on and no voice is on this Mac: the
 * first time, and after the user deleted every voice and turned speech on.
 */
function fetchFirstVoice(): void {
  const { supertonic, voxcpm2 } = speech.downloads()
  if (supertonic.state === 'missing' && voxcpm2.state === 'missing') void speech.fetch('supertonic')
}

/** Chats, projects or settings changed: the window and the Telegram bot show them anew. */
function stateChanged(): void {
  send('state:changed', store.getState())
  telegram.stateChanged()
}

/** Notifications for bots that reach out while the user looks elsewhere; a click opens the bot. */
const notices = new BotNotices(
  () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
  (chatId) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    // Only the Mac's window: a page of the remote link keeps the chat it shows.
    mainWindow.webContents.send('window:openChat', chatId)
  }
)

const agents = new AgentManager(
  {
    item: (chatId: string, item: ChatItem) => {
      send('chat:item', chatId, item)
      telegram.item(chatId, item)
    },
    options: (chatId: string, options: AgentOption[]) => {
      send('chat:options', chatId, options)
      telegram.options(chatId, options)
    },
    commands: (chatId: string, commands: AgentCommand[]) => send('chat:commands', chatId, commands),
    turnEnded: (chatId, end) => {
      telegram.turnEnded(chatId, end)
      notices.turnEnded(chatId, end)
    },
    stateChanged: () => {
      stateChanged()
      notices.stateChanged()
      // A chat that stopped running may no longer need its browser page, and
      // no longer controls a tab.
      browser?.prune()
      browser?.endControl()
      // A chat's turn began or ended: its recording pauses while the agent thinks.
      recorder?.refresh()
    }
  },
  (chatId) => browser?.state(chatId)
)

/** Bots' routines, which wake their conversations at the times the user asked for. */
const routines = new Routines((chatId, note) => agents.runRoutine(chatId, note), stateChanged)

/** Stop a chat's turn, as its Stop button does: what it says out loud stops too. */
function cancelChat(chatId: string): Promise<void> {
  speech.stop(chatId)
  return agents.cancel(chatId)
}

/** Delete a chat, with its browser page and walkthrough. */
async function deleteChat(chatId: string): Promise<void> {
  await agents.deleteChat(chatId)
  browser?.closeChat(chatId)
  walks.forget(chatId)
}

/** Control from Telegram: the linked chat and the chats it starts, on the user's phone. */
const telegram = new TelegramBridge({
  send: (chatId, text, attachments, id) =>
    agents.send(chatId, text, attachments, undefined, false, id),
  createChat: (projectId, like) => {
    const chat = store.createChat({
      projectId,
      agent: like.agent,
      settings: { ...like.settings },
      bypassPermissions: like.bypassPermissions,
      projectOnly: like.projectOnly,
      autoMode: like.autoMode
    })
    stateChanged()
    return chat
  },
  deleteChat,
  renameChat: (chatId, title) => agents.renameChat(chatId, title),
  openChat: (chatId) => agents.open(chatId),
  agentStatus: (agent) => agents.status(agent),
  agentModels: (agent, projectId) => agents.models(agent, projectId),
  setOption: (chatId, optionId, value) => agents.setOption(chatId, optionId, value),
  changeAgent: (chatId, agent, settings) => agents.changeAgent(chatId, agent, settings),
  cancel: cancelChat,
  resolvePermission: (chatId, permissionId, optionId) =>
    agents.resolvePermission(chatId, permissionId, optionId),
  answerForm: (chatId, formId, answers) => agents.answerForm(chatId, formId, answers),
  turnEnd: (chatId) => agents.turnEnd(chatId),
  statusChanged: (status) => send('telegram:status', status)
})

function createWindow(): BuiltinBrowser {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 560,
    show: false,
    titleBarStyle: 'hiddenInset',
    // Centred on the sidebar's 48px top row.
    trafficLightPosition: { x: 16, y: 17 },
    // On the Mac, see-through so the Liquid Glass behind the page shows where the
    // page is (addGlass); macOS then blends the window with what is behind it on
    // every frame. Elsewhere opaque, in the chat's background color.
    ...(process.platform === 'darwin'
      ? { transparent: true }
      : { backgroundColor: windowBackground() }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      // What agents say (the speak tool) plays without the user having clicked first.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  // A sheet attached in the same tick as show() is never drawn; the show event comes after.
  mainWindow.once('show', () => store.reportDamagedState(mainWindow))
  mainWindow.on('ready-to-show', () => mainWindow.show())
  // As in other Mac apps, closing the window hides it and the app stays in the
  // Dock: chats keep running, and the window comes back as it was. Quitting
  // (⌘Q) closes it for real and stops the agents.
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    // A full-screen window would leave an empty space behind; it leaves full screen first.
    if (mainWindow.isFullScreen()) {
      mainWindow.once('leave-full-screen', () => mainWindow.hide())
      mainWindow.setFullScreen(false)
    } else {
      mainWindow.hide()
    }
  })
  // A crashed renderer leaves the window blank. Chats live in this process, so
  // loading the window again loses nothing; one that keeps crashing is left to the user.
  let lastReload = 0
  // The voice plays in the window (lib/speech.ts): what it was playing is gone with it.
  // So are the videos it was recording (lib/recording.ts).
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      speech.stop()
      recorder?.abandon("Barebone's window reloaded")
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`The window's renderer is gone: ${details.reason} (${details.exitCode})`)
    speech.stop()
    recorder?.abandon("Barebone's window crashed")
    if (details.reason === 'clean-exit' || mainWindow.isDestroyed()) return
    if (Date.now() - lastReload < 30_000) {
      // A sheet on the window: an error box would hold the whole app, and the remote link with it.
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        message: 'Barebone stopped responding',
        detail: 'The window crashed again right after reloading. Quit and open the app again.'
      })
      return
    }
    lastReload = Date.now()
    mainWindow.webContents.reload()
  })
  if (process.platform === 'darwin') {
    // The package adds the glass once the page has loaded; it stays across reloads.
    mainWindow.webContents.once('did-finish-load', () => addGlass(mainWindow))
  }
  // Clear on the Mac, so the glass shows, except in full screen: nothing is
  // behind the window there but black, which would darken the glass in light mode.
  const setBackground = (): void => {
    if (mainWindow.isDestroyed()) return
    const clear = process.platform === 'darwin' && !mainWindow.isFullScreen()
    mainWindow.setBackgroundColor(clear ? '#00000000' : windowBackground())
  }
  nativeTheme.on('updated', setBackground)
  mainWindow.on('enter-full-screen', setBackground)
  mainWindow.on('leave-full-screen', setBackground)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }

  const browser = new BuiltinBrowser(
    mainWindow,
    (state) => send('browser:state', state),
    (chatId) => {
      if (!store.getState().chats.find((c) => c.id === chatId)?.browserOpen) {
        setBrowserOpen(chatId, true)
      }
    },
    (chatId) => store.getState().chats.some((c) => c.id === chatId && c.running),
    {
      get: (chatId) => store.getState().chats.find((c) => c.id === chatId)?.browserTabs,
      set: (chatId, tabs) => {
        if (store.getState().chats.some((c) => c.id === chatId)) {
          store.updateChat(chatId, { browserTabs: tabs })
        }
      }
    }
  )

  // The folded chat's orb, over the browser's page.
  const orb = new AgentOrb(mainWindow, () => send('orb:unfold'))
  browser.onPageArea = (area) => orb.setArea(area)
  ipcMain.on('orb:state', (event, state: OrbState | null) => {
    if (event.sender === mainWindow.webContents) orb.setState(state)
  })
  ipcMain.on('orb:level', (event, level: number) => {
    if (event.sender === mainWindow.webContents) orb.setLevel(level)
  })
  ipcMain.on('orb:draft', (event, text: string) => {
    if (event.sender === mainWindow.webContents) orb.draft(text)
  })
  // Right ⌘ held while the app lost focus: its keyup goes elsewhere, so the recording ends here.
  mainWindow.on('blur', () => send('voice:blur'))

  // Links in chat messages open in the built-in browser, not the system one.
  // Other schemes (mailto: and the like) still go to their macOS handler.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:/i.test(details.url)) browser.open(details.url).catch(() => undefined)
    else shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // A link on a bot's dashboard opens in the chat's browser panel. The dashboard
  // only moves between its own pages, and goes nowhere else.
  // The window lets frames go to web pages (index.html's frame-src) only so that
  // such a navigation reaches this handler, which stops it.
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || !event.frame?.url.startsWith(`${BOT_SCHEME}:`)) return
    // URL gives a custom scheme no origin, so the bot is told by its host, its project ID.
    const to = new URL(event.url)
    if (to.protocol === `${BOT_SCHEME}:` && to.host === new URL(event.frame.url).host) return
    event.preventDefault()
    if (/^https?:$/.test(to.protocol)) browser.open(event.url).catch(() => undefined)
  })

  return browser
}

/**
 * The window's color behind the page where it has no glass (outside the Mac, and
 * in full screen), matching the chat's in styles.css.
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff'
}

/**
 * macOS 26's Liquid Glass behind the whole page: Apple's NSGlassEffectView,
 * through electron-liquid-glass. It follows the window's light or dark
 * appearance; before macOS 26 the package puts the older window blur there.
 * Loaded on demand, as the package only installs on the Mac.
 */
async function addGlass(window: BrowserWindow): Promise<void> {
  const { default: liquidGlass } = await import('electron-liquid-glass')
  if (liquidGlass.addView(window.getNativeWindowHandle()) === -1) {
    console.error('Liquid Glass could not be added to the window')
  }
}

/**
 * nativeTheme drives prefers-color-scheme in the app and in browser pages, and
 * the window background, so one setting switches everything.
 */
function setTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  store.setTheme(theme)
  installMenu((command) => send('menu', command), theme, setTheme)
  stateChanged()
}

/**
 * The browser panel is open or closed per chat, saved with the chat. It
 * shares its place with the code panel: opening one closes the other.
 */
function setBrowserOpen(chatId: string, open: boolean): void {
  if (!store.getState().chats.some((c) => c.id === chatId)) return
  store.updateChat(chatId, open ? { browserOpen: true, codeOpen: false } : { browserOpen: false })
  stateChanged()
}

/** The code panel is open or closed per chat, in the browser panel's place. */
function setCodeOpen(chatId: string, open: boolean): void {
  if (!store.getState().chats.some((c) => c.id === chatId)) return
  store.updateChat(chatId, open ? { codeOpen: true, browserOpen: false } : { codeOpen: false })
  stateChanged()
}

/** The simulators, emulators and phones, for the device tools. */
const devices = new DeviceManager()

/** The device tools, for mobile apps: Settings turns them on and off. */
function registerDevicesIpc(): void {
  handle('mobile:set', (on: boolean) => {
    store.setMobile(on)
    stateChanged()
    // Cline keeps servers in its own settings: add the device tools there, or take them out.
    void agents.status('cline').then(({ available }) => {
      if (!available) return
      const change = on ? registerWithCline : unregisterFromCline
      return change(DEVICES_SERVER, devicesMcpEndpoint()).catch((error) =>
        console.error(`Could not update ${DEVICES_SERVER} in cline:`, error.message)
      )
    })
  })
  handle('devices:checks', () => devices.checks())
}

/** The folder of a chat's project. */
function projectPathOf(chatId: string): string | undefined {
  const { chats, projects } = store.getState()
  const chat = chats.find((c) => c.id === chatId)
  return projects.find((p) => p.id === chat?.projectId)?.path
}

/** The repository a project is in, by its top folder; throws when it is in none. */
async function repoOf(projectId: string): Promise<string> {
  const project = store.getState().projects.find((p) => p.id === projectId)
  if (!project) throw new Error('This project is no longer open.')
  const root = await git.repoRoot(project.path)
  if (!root) throw new Error(`${project.name} is not in a git repository.`)
  return root
}

/** Ask before something that cannot be undone; true when the user goes ahead. */
async function confirm(message: string, detail: string, action: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    message,
    detail,
    buttons: [action, 'Cancel'],
    defaultId: 0,
    cancelId: 1
  })
  return response === 0
}

/** Source control for the code panel (git.ts), by project. */
function registerGitIpc(): void {
  handle('code:setOpen', (chatId: string, open: boolean) => setCodeOpen(chatId, open))
  handle('walk:get', (chatId: string) => walks.current(chatId) ?? null)
  handle('walk:control', (chatId: string, action: WalkControl, index?: number) =>
    walks.control(chatId, action, index)
  )

  handle('git:status', (projectId: string): Promise<GitStatus> => {
    const project = store.getState().projects.find((p) => p.id === projectId)
    return project ? git.status(project.path) : Promise.resolve({ repo: false })
  })
  handle(
    'git:diff',
    async (projectId: string, change: GitChange, staged: boolean): Promise<CodeDoc> => {
      const root = await repoOf(projectId)
      const path = join(root, change.path)
      // A conflicted file has no stage to compare: it shows as it is, markers and all.
      if (change.kind === 'conflicted') {
        return { kind: 'file', path, text: await readFile(path, 'utf8') }
      }
      return { kind: 'diff', path, staged, ...(await git.diff(root, change, staged)) }
    }
  )
  handle('git:stage', async (projectId: string, changes: GitChange[]) =>
    git.stage(await repoOf(projectId), changes)
  )
  handle('git:unstage', async (projectId: string, changes: GitChange[]) =>
    git.unstage(await repoOf(projectId), changes)
  )
  handle(
    'git:discard',
    async (projectId: string, changes: GitChange[]) => {
      const root = await repoOf(projectId)
      const untracked = changes.filter((c) => c.kind === 'untracked').length
      const one = changes.length === 1 ? basename(changes[0].path) : undefined
      const sure = await confirm(
        one
          ? untracked
            ? `Delete ${one}?`
            : `Discard the changes in ${one}?`
          : `Discard the changes in ${changes.length} files?`,
        untracked
          ? `${untracked === 1 ? 'A file that git does not track is' : `${untracked} files that git does not track are`} deleted, and cannot be brought back.`
          : 'This cannot be undone.',
        one && untracked ? 'Delete' : 'Discard'
      )
      if (sure) await git.discard(root, changes)
      return sure
    },
    MAC_ONLY
  )
  handleAs('git:commit', async (caller, projectId: string, message: string) => {
    const root = await repoOf(projectId)
    const repo = await git.status(root)
    if (!repo.repo) return false
    if (repo.conflicts.length) throw new Error('Resolve the merge conflicts before committing.')
    // As VS Code's smart commit: with nothing staged, offer to commit every change.
    const all = repo.staged.length === 0
    if (all) {
      if (!repo.unstaged.length) throw new Error('There are no changes to commit.')
      // The offer is a dialog on the Mac, which a page of the remote link cannot answer.
      if (caller !== 'window') throw new Error('Nothing is staged. Stage the changes to commit.')
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        message: 'There are no staged changes to commit.',
        detail: 'Stage all your changes and commit them?',
        buttons: ['Stage all and commit', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (response !== 0) return false
    }
    await git.commit(root, message, all)
    return true
  })
  handle('git:branches', async (projectId: string) => git.branches(await repoOf(projectId)))
  handle('git:checkout', async (projectId: string, branch: GitBranch) =>
    git.checkout(await repoOf(projectId), branch)
  )
  handle('git:createBranch', async (projectId: string, name: string) =>
    git.createBranch(await repoOf(projectId), name)
  )
  handle('git:sync', async (projectId: string) => git.sync(await repoOf(projectId)))

  // The open panel's repository is watched, so its list follows what changes on disk.
  // The window and pages of the remote link each open panels: a repository is
  // watched while any of them has it open.
  const watching = new Map<string, { stop?: () => void; by: Set<Caller> }>()
  const unwatch = (projectId: string, caller: Caller): void => {
    const watch = watching.get(projectId)
    if (!watch?.by.delete(caller) || watch.by.size > 0) return
    watch.stop?.()
    watching.delete(projectId)
  }
  handleAs('git:watch', async (caller, projectId: string) => {
    const existing = watching.get(projectId)
    if (existing) return void existing.by.add(caller)
    const watch: { stop?: () => void; by: Set<Caller> } = { by: new Set([caller]) }
    watching.set(projectId, watch)
    const root = await repoOf(projectId).catch(() => undefined)
    // Unwatched while the repository was looked up: nothing to start.
    if (!root || watching.get(projectId) !== watch) return void watching.delete(projectId)
    watch.stop = git.watchRepo(root, () => send('git:changed', projectId))
  })
  handleAs('git:unwatch', (caller, projectId: string) => unwatch(projectId, caller))
  onCallerGone((caller) => {
    for (const projectId of [...watching.keys()]) unwatch(projectId, caller)
  })
}

/** Bots (bots.ts): chats make them, and the window shows their dashboards and memory. */
function registerBotsIpc(): void {
  provideBots({
    create: (_caller, bot) => {
      const project = createBot(bot)
      stateChanged()
      return project
    }
  })
  provideRoutines(routines)
  // The chat the window shows: a bot notifies only while the user is not looking at it.
  listen('window:chat', (chatId: string | null) => notices.showing(chatId ?? undefined), MAC_ONLY)
  // The window loads a dashboard with the bot: scheme; a page of the remote link, with a key.
  handleAs('bots:dashboard', (caller, projectId: string) => {
    if (!hasDashboard(projectId)) return null
    if (caller === 'window') return `${BOT_SCHEME}://${projectId}/${DASHBOARD}`
    const sessionId = remote.sessionOf(caller)
    return sessionId ? `${REMOTE_BOTS}/${remoteKey(projectId, sessionId)}/${DASHBOARD}` : null
  })
  handle('bots:memory', (projectId: string) => memory(projectId))

  // A bot's folder is watched while its dashboard or memory is open anywhere, so they show changes.
  const watching = new Map<string, { stop: () => void; by: Set<Caller> }>()
  const unwatch = (projectId: string, caller: Caller): void => {
    const watch = watching.get(projectId)
    if (!watch?.by.delete(caller) || watch.by.size > 0) return
    watch.stop()
    watching.delete(projectId)
  }
  handleAs('bots:watch', (caller, projectId: string) => {
    const existing = watching.get(projectId)
    if (existing) return void existing.by.add(caller)
    const stop = watchBot(projectId, () => send('bots:changed', projectId))
    watching.set(projectId, { stop, by: new Set([caller]) })
  })
  handleAs('bots:unwatch', (caller, projectId: string) => unwatch(projectId, caller))
  onCallerGone((caller) => {
    for (const projectId of [...watching.keys()]) unwatch(projectId, caller)
  })
}

function registerIpc(browser: BuiltinBrowser): void {
  handle(
    'browser:setOpen',
    (chatId: string, open: boolean) => setBrowserOpen(chatId, open),
    MAC_ONLY
  )
  handle('theme:set', (theme: Theme) => setTheme(theme))
  handle('instructions:set', (text: string) => {
    store.setInstructions(text)
    stateChanged()
  })
  handle('annotations:set', (on: boolean) => {
    store.setAnnotations(on)
    stateChanged()
  })
  handle('codeTours:set', (on: boolean) => {
    store.setCodeTours(on)
    stateChanged()
  })
  handle('recording:set', (on: boolean) => {
    store.setRecording(on)
    stateChanged()
  })
  // Speech: turning it on downloads Supertonic when no voice is on this Mac yet.
  handle('speech:set', (on: boolean) => {
    store.setSpeech(on)
    stateChanged()
    if (on) fetchFirstVoice()
    else speech.stop()
  })
  handle('speech:setVoiceOn', (model: VoiceModelId, on: boolean) => {
    store.setVoiceOn(model, on)
    stateChanged()
  })
  handle('speech:setVoiceFor', (which: 'arabic' | 'other', model: VoiceModelId) => {
    store.setVoiceFor(which, model)
    stateChanged()
  })
  handle('speech:setSupertonicInChats', (on: boolean) => {
    store.setSupertonicInChats(on)
    stateChanged()
  })
  handle('speech:makeVoice', (description: string) => speech.makeVoice(description))
  handle('speech:sample', (text: string, language: Language, model?: VoiceModelId) => {
    speech.speak(undefined, text, language, {}, { model })
  })
  handle('music:set', (on: boolean) => {
    store.setMusic(on)
    stateChanged()
  })
  // What is downloaded: the voices, the music model, and ffmpeg for thumbnails.
  handle('downloads:status', () => downloads())
  handle(
    'downloads:fetch',
    (id: DownloadId) => void (id === 'ffmpeg' ? videoTools.ffmpeg.fetch() : speech.fetch(id))
  )
  handle('downloads:cancel', (id: DownloadId) =>
    id === 'ffmpeg' ? videoTools.ffmpeg.cancel() : speech.cancel(id)
  )
  handle('downloads:remove', (id: DownloadId) =>
    id === 'ffmpeg' ? videoTools.ffmpeg.remove() : speech.remove(id)
  )
  handle('speech:stop', (chatId?: string) => speech.stop(chatId))
  listen('speech:begun', (id: string) => speech.begun(id))
  listen('speech:ended', (id: string) => speech.ended(id))
  handle('state:get', () => store.getState())
  handle('app:version', () => app.getVersion())
  handle('update:available', () => availableUpdate())
  handle('update:check', () => checkForUpdates(), MAC_ONLY)
  handle('update:install', () => installUpdate(), MAC_ONLY)
  handle('exa:keyHint', () => exaKeyHint())
  handle('exa:setKey', (key: string | null) => setExaKey(key))
  handle('voice:keyHint', () => voiceKeyHint())
  handle('voice:setKey', (key: string | null) => setVoiceKey(key))
  handle('voice:microphone', () => microphoneAccess(), MAC_ONLY)
  handle('telegram:keyHint', () => telegram.tokenHint())
  handle('telegram:setKey', (token: string | null) => telegram.setToken(token))
  handle('telegram:status', () => telegram.status())
  handle('telegram:link', (chatId: string | null) => telegram.link(chatId))
  handle('voice:transcribe', (audio: Uint8Array, mimeType: string) => transcribe(audio, mimeType))
  handle('providers:list', () => customProviders())
  handle('providers:save', async (input: CustomProviderInput) => {
    const saved = saveCustomProvider(input)
    await agents.customProvidersChanged()
    return saved
  })
  handle('providers:remove', async (id: string) => {
    removeCustomProvider(id)
    await agents.customProvidersChanged()
  })
  handle('providers:check', (id: string) => checkCustomProvider(id))

  handle(
    'project:add',
    async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Add project'
      })
      const path = result.filePaths[0]
      if (result.canceled || !path) return null
      const existing = store.getState().projects.find((p) => p.path === path)
      if (existing) return existing
      const project = { id: crypto.randomUUID(), name: basename(path), path, createdAt: Date.now() }
      store.addProject(project)
      stateChanged()
      return project
    },
    MAC_ONLY
  )

  handle('project:remove', (projectId: string) => {
    store.removeProject(projectId)
    stateChanged()
  })

  handle(
    'project:setStyle',
    (projectId: string, style: Partial<Pick<Project, 'color' | 'icon'>>) => {
      store.updateProject(projectId, style)
      stateChanged()
    }
  )
  handle('project:icon', (projectId: string) => projectIcon(store.getProject(projectId).path))
  handle(
    'project:chooseIcon',
    async (projectId: string) => {
      const icon = await chooseProjectIcon(mainWindow, store.getProject(projectId).path)
      if (icon === undefined) return undefined
      // The chosen image shows in place of any other icon.
      store.updateProject(projectId, { icon: undefined })
      stateChanged()
      return icon
    },
    MAC_ONLY
  )

  handle(
    'chat:create',
    (
      projectId: string,
      agent: AgentId,
      settings: Record<string, string>,
      permissions: ChatPermissions = {}
    ) => {
      const chat = store.createChat({ projectId, agent, settings, ...permissions })
      stateChanged()
      return chat
    }
  )

  handle('chat:delete', (chatId: string) => deleteChat(chatId))

  // A chat the user leaves before sending anything is of no use, so it goes.
  handle('chat:leave', async (chatId: string) => {
    const chat = store.getState().chats.find((c) => c.id === chatId)
    if (!chat || chat.running || chat.draft || store.getMessages(chatId).length > 0) return
    await deleteChat(chatId)
  })

  // The composer saves its draft before it is left (Composer.tsx), so a chat
  // with only a draft is kept by chat:leave above.
  handle('chat:draft', (chatId: string, text: string) => {
    if (!store.getState().chats.some((c) => c.id === chatId)) return
    store.updateChat(chatId, { draft: text || undefined })
    stateChanged()
  })

  handle('chat:rename', (chatId: string, title: string) => agents.renameChat(chatId, title))
  handle('chat:pin', (chatId: string, pinned: boolean) => {
    store.updateChat(chatId, { pinned: pinned || undefined })
    stateChanged()
  })
  handle('chat:messages', (chatId: string) => store.getMessages(chatId))

  handle('chat:setAgent', (chatId: string, agent: AgentId, settings: Record<string, string>) =>
    agents.changeAgent(chatId, agent, settings)
  )
  handle('chat:open', (chatId: string) => agents.open(chatId))

  // Fire and forget: progress arrives through chat:item and state:changed events.
  handle('chat:send', (chatId: string, text: string, attachments?: Attachment[]) => {
    void agents.send(chatId, text, attachments)
  })
  handle(
    'files:pick',
    async (): Promise<Attachment[]> => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        buttonLabel: 'Attach'
      })
      return result.canceled ? [] : result.filePaths.map((path) => ({ name: basename(path), path }))
    },
    MAC_ONLY
  )
  handle('files:thumbnail', (path: string) => thumbnail(path))
  handle('chat:setPermissions', (chatId: string, permissions: ChatPermissions) =>
    agents.setPermissions(chatId, permissions)
  )
  handle('chat:cancel', (chatId: string) => cancelChat(chatId))
  handle('chat:takeWaiting', (chatId: string, id: string) => agents.takeWaiting(chatId, id))
  handle('chat:stopCommand', (chatId: string, pid: number) => agents.stopCommand(chatId, pid))
  handle('chat:stopSubagent', (chatId: string, id: string) => agents.stopSubagent(chatId, id))
  handle('chat:clearTimer', (chatId: string) => {
    agents.clearTimer(chatId)
  })
  handle('chat:setOption', (chatId: string, optionId: string, value: string) =>
    agents.setOption(chatId, optionId, value)
  )
  handle('chat:permission', (chatId: string, permissionId: string, optionId: string) =>
    agents.resolvePermission(chatId, permissionId, optionId)
  )
  handle('chat:answerForm', (chatId: string, formId: string, answers: FormAnswers | null) =>
    agents.answerForm(chatId, formId, answers)
  )

  handle('agents:status', (agent: AgentId) => agents.status(agent))
  handle('agents:models', (agent: AgentId, projectId: string) => agents.models(agent, projectId))

  listen(
    'browser:setChat',
    (chatId: string | null) => browser.setActiveChat(chatId ?? undefined),
    MAC_ONLY
  )
  listen('browser:setBounds', (rect: Rect | null) => browser.setBounds(rect), MAC_ONLY)
  listen('browser:setHidden', (hidden: boolean) => browser.setPanelHidden(hidden), MAC_ONLY)
  handle('browser:capture', () => browser.capturePanel(), MAC_ONLY)
  handle(
    'browser:navigate',
    (url: string) => browser.navigate(url).catch(() => undefined),
    MAC_ONLY
  )
  handle('browser:back', () => browser.back(), MAC_ONLY)
  handle('browser:forward', () => browser.forward(), MAC_ONLY)
  handle('browser:reload', () => browser.reload(), MAC_ONLY)
  handle('browser:selectTab', (tabId: string) => browser.selectActiveChatTab(tabId), MAC_ONLY)
  handle('browser:closeTab', (tabId: string) => browser.closeActiveChatTab(tabId), MAC_ONLY)
  handle('browser:newTab', () => browser.newActiveChatTab(), MAC_ONLY)
  handle('browser:fillPanel', () => browser.fillPanel(), MAC_ONLY)
  listen('browser:menu', (x: number, y: number) => browser.showMenu(x, y), MAC_ONLY)
  handle('browser:state', () => browser.state(), MAC_ONLY)

  handle('files:list', (projectPath: string) => listProjectFiles(projectPath))
  handle('prompts:history', (projectId: string) => store.promptHistory(projectId))
  handle('skills:list', (projectPath?: string) => skills.listSkills(projectPath))
  handle('skills:read', (path: string, projectPath?: string) => skills.readSkill(path, projectPath))
  handle('skills:create', (name: string, scope: SkillScope, projectPath?: string) =>
    skills.createSkill(name, scope, projectPath)
  )
  handle('skills:save', (path: string, content: string, projectPath?: string) =>
    skills.saveSkill(path, content, projectPath)
  )
  handle('skills:delete', (path: string, projectPath?: string) =>
    skills.deleteSkill(path, projectPath)
  )
  handle('skills:reveal', (path: string) => shell.showItemInFolder(path), MAC_ONLY)
}

// One instance only: a second one would share the same data files and browser profile.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
})

// Clicking the Dock icon brings back a closed (hidden) window.
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
})

// Right ⌘ held alone is push to talk (renderer/src/lib/voice.ts), wherever the
// keyboard is: the chat, a browser page or the agent orb. The window learns
// when right ⌘ goes down and up, and that another key went down with it (a
// shortcut, not talking); never which keys are typed.
app.on('web-contents-created', (_event, contents) => {
  contents.on('before-input-event', (_e, input) => {
    if (!mainWindow || (input.type !== 'keyDown' && input.type !== 'keyUp')) return
    if (input.code === 'MetaRight') send('voice:key', input.type, input.isAutoRepeat)
    else if (input.type === 'keyDown' && input.meta) send('voice:key', 'combo', false)
  })
})

app.setName('Barebone')
// Electron takes the app's schemes in one call, before it is ready.
protocol.registerSchemesAsPrivileged([imageScheme, botScheme])

app.whenReady().then(async () => {
  // A packaged build takes its icon from the bundle; in development the Electron
  // binary's own icon would show, so set it here.
  if (!app.isPackaged) app.dock?.setIcon(appIcon)
  electronApp.setAppUserModelId('dev.barebone.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Only commands need PATH, and they wait for it; the window does not.
  void loadShellPath()
  handleImageRequests()
  handleBotRequests()
  // Set before the window exists so it opens in the right appearance.
  nativeTheme.themeSource = store.getState().theme ?? 'system'
  installMenu((command) => send('menu', command), nativeTheme.themeSource, setTheme)
  const announce = (): void => void send('downloads:status', downloads())
  speech = new Speech(
    app.getPath('userData'),
    () => {
      const state = store.getState()
      return {
        on: store.speechOn(),
        off: state.voicesOff ?? [],
        voiceFor: state.voiceFor ?? {},
        supertonicInChats: state.supertonicInChats === true,
        description: state.voiceDescription
      }
    },
    {
      downloads: announce,
      described: (description) => {
        store.setVoiceDescription(description)
        stateChanged()
      },
      audio: (audio) => send('speech:audio', audio),
      stop: (which) => send('speech:stop', which)
    }
  )
  videoTools = new VideoTools(announce)
  // A walkthrough speaks only while a voice is on and on this Mac, as the speak tool does.
  walks = new WalkPlayer(
    (chatId, text, language, pace) =>
      language && speech.offered() ? speech.speak(chatId, text, language, { pace }) : undefined,
    (chatId, at) => send('walk:at', chatId, at)
  )
  browser = createWindow()
  recorder = new PageRecorder(
    mainWindow.webContents,
    (chatId) => store.getState().chats.find((chat) => chat.id === chatId)?.running === true,
    (chatId, video) => telegram.video(chatId, video),
    (path, at) => videoTools.thumbnail(path, at),
    () => videoTools.ffmpeg.ready()
  )
  registerIpc(browser)
  telegram.start()
  remote.start(browser)
  providePhone({
    on: () => telegram.sendsFiles(),
    sendFile: (chatId, path, caption) => telegram.sendFile(chatId, path, caption)
  })
  registerGitIpc()
  registerBotsIpc()
  registerDevicesIpc()
  // On by default: the voice downloads in the background the first time.
  if (store.speechOn()) fetchFirstVoice()
  watchForUpdates((version) => send('update:available', version))
  const endpoint = await startBrowserMcp(
    browser,
    {
      chatForBrowserId: (id) => store.getState().chats.find((c) => c.id.startsWith(id))?.id,
      fallbackChat: () => agents.latestActiveChat()
    },
    agents,
    {
      // Offered once a voice is on this Mac, so an agent never speaks into a missing one.
      on: () => speech.offered(),
      natural: () => speech.natural(),
      music: () => store.getState().music === true && speech.musicReady(),
      maxMusicSeconds: MAX_MUSIC_SECONDS,
      makeVoice: (description) => speech.makeVoice(description),
      makeMusic: (path, description, seconds) => speech.makeMusic(path, description, seconds),
      speak: (chatId, text, language, delivery) => {
        // What a chat says while it records goes into its video, in the voice Settings picks.
        const spoken = speech.speak(chatId, text, language, delivery, {
          recorded: recorder?.recording(chatId) === true
        })
        // What the chat says is in its video: it records from just before the voice to its end.
        void spoken.started.then((begun) => {
          if (begun) void spoken.ended.then(recorder?.hold(chatId))
        })
        return spoken
      },
      save: (path, text, language, delivery) => speech.save(path, text, language, delivery),
      said: (chatId) => speech.said(chatId)
    },
    recorder,
    {
      projectPath: projectPathOf,
      start: (chatId, walk, language, pace) => {
        setCodeOpen(chatId, true)
        send('walk:start', chatId, walk)
        walks.start(chatId, walk, language, pace)
      }
    },
    {
      manager: devices,
      routing: {
        chatFor: (id) =>
          (id ? store.getState().chats.find((c) => c.id.startsWith(id))?.id : undefined) ??
          agents.latestActiveChat(),
        projectPath: projectPathOf,
        allowCommand: (chatId, title, command) => agents.allowCommand(chatId, title, { command })
      }
    }
  )
  // Once agents can reach the chat tools: a routine due while the app was closed runs now.
  routines.start()
  // Only when cline is installed; failures are logged and the app works without it.
  // One at a time: each rewrites cline's settings file.
  agents.status('cline').then(async ({ available }) => {
    if (!available) return
    for (const [name, at] of [
      [BROWSER_SERVER, endpoint],
      [CHATS_SERVER, chatsMcpEndpoint()],
      // The device tools only while Settings has them on.
      ...(store.getState().mobile ? [[DEVICES_SERVER, devicesMcpEndpoint()] as const] : [])
    ] as const) {
      await registerWithCline(name, at).catch((error) =>
        console.error(`Could not register ${name} with cline:`, error.message)
      )
    }
  })
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  telegram.stop()
  const unlinked = remote.stop()
  const stopped = agents.stopAll()
  // A failed save (a full disk) must not keep the app from quitting.
  try {
    store.flush()
  } catch (error) {
    console.error('Could not save before quitting:', error)
  }
  // Before the tabs close, so videos end as stopped, not as cut off.
  const recorded = recorder?.stopAll()
  browser?.closeAll()
  // The devices keep running, as they do when started from Xcode or Android Studio.
  devices.stopAll()
  speech.dispose()
  // Waited for up to a limit: one that never settles (an MCP server that never
  // answers) would otherwise keep the app open, and the updater replaces it.
  const waits = {
    agents: stopped,
    browser: browser?.flush(),
    recordings: recorded,
    remote: unlinked
  }
  const unfinished = new Set(Object.keys(waits))
  const settled = Object.entries(waits).map(([name, wait]) =>
    Promise.resolve(wait)
      .catch(() => undefined)
      .finally(() => unfinished.delete(name))
  )
  const deadline = new Promise((resolve) => setTimeout(resolve, QUIT_DEADLINE))
  Promise.race([Promise.all(settled), deadline]).then(() => {
    if (unfinished.size > 0)
      console.error(`Quit before these stopped: ${[...unfinished].join(', ')}`)
    app.quit()
  })
})

// Closing the window only hides it, so it closes for good only while quitting.
// Should it go any other way, the app quits rather than run without a window.
app.on('window-all-closed', () => app.quit())
