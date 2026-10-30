// First: moves the data folder of the app's former name before anything uses it.
import './former-name'
import { app, shell, BrowserWindow, ipcMain, dialog, nativeTheme } from 'electron'
import { basename, join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import appIcon from '../../resources/icon.png?asset'
import type {
  AgentCommand,
  Attachment,
  AgentId,
  AgentOption,
  Chat,
  ChatItem,
  CustomProviderInput,
  FormAnswers,
  OrbState,
  Project,
  Rect,
  SkillScope,
  Theme
} from '../shared/types'
import * as store from './store'
import { AgentManager } from './agents'
import { BuiltinBrowser } from './browser'
import { chatsMcpEndpoint, SERVER_NAME as BROWSER_SERVER, startBrowserMcp } from './browser-mcp'
import { SERVER_NAME as CHATS_SERVER } from './chats-mcp'
import { registerWithCline } from './cline-mcp'
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
import { Speech } from './speech'
import type { Language } from './speech/supertonic'
import { loadShellPath } from './shell-env'
import * as skills from './skills'
import { listProjectFiles } from './files'
import { chooseProjectIcon, projectIcon } from './project-icon'
import { handleImageRequests, registerImageScheme, thumbnail } from './images'
import { availableUpdate, checkForUpdates, installUpdate, watchForUpdates } from './updates'

let mainWindow: BrowserWindow
let browser: BuiltinBrowser | undefined
/** The voice agents speak with; made once the app has its name, which its data folder is under. */
let speech: Speech
/** Records browser tabs as videos, in the window; made with the window. */
let recorder: PageRecorder | undefined
/** Set once the app is quitting: closing the window then really closes it. */
let quitting = false
/** How long quitting waits for the agents and the browser to stop. */
const QUIT_DEADLINE = 5000

/** Tell the window; false when there is no window to tell. */
function send(channel: string, ...args: unknown[]): boolean {
  // Nothing to tell before the window exists; it asks for the state it shows when it loads.
  if (!mainWindow || mainWindow.isDestroyed()) return false
  mainWindow.webContents.send(channel, ...args)
  return true
}

const agents = new AgentManager(
  {
    item: (chatId: string, item: ChatItem) => send('chat:item', chatId, item),
    options: (chatId: string, options: AgentOption[]) => send('chat:options', chatId, options),
    commands: (chatId: string, commands: AgentCommand[]) => send('chat:commands', chatId, commands),
    stateChanged: () => {
      send('state:changed', store.getState())
      // A chat that stopped running may no longer need its browser page, and
      // no longer controls a tab.
      browser?.prune()
      browser?.endControl()
    }
  },
  (chatId) => browser?.state(chatId)
)

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
    // Opaque, in the chat's background color: a transparent window would make
    // macOS blend it with what is behind it on every frame.
    backgroundColor: windowBackground(),
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
      dialog.showErrorBox(
        'Barebone stopped responding',
        'The window crashed again right after reloading. Quit and open the app again.'
      )
      return
    }
    lastReload = Date.now()
    mainWindow.webContents.reload()
  })
  nativeTheme.on('updated', () => {
    if (!mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground())
  })

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

  return browser
}

/** The window's color behind the page, matching --canvas in styles.css. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#000000' : '#ffffff'
}

/**
 * nativeTheme drives prefers-color-scheme in the app and in browser pages, and
 * the window background, so one setting switches everything.
 */
function setTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  store.setTheme(theme)
  installMenu((command) => send('menu', command), theme, setTheme)
  send('state:changed', store.getState())
}

/** The browser panel is open or closed per chat, saved with the chat. */
function setBrowserOpen(chatId: string, open: boolean): void {
  if (!store.getState().chats.some((c) => c.id === chatId)) return
  store.updateChat(chatId, { browserOpen: open })
  send('state:changed', store.getState())
}

function registerIpc(browser: BuiltinBrowser): void {
  ipcMain.handle('browser:setOpen', (_e, chatId: string, open: boolean) =>
    setBrowserOpen(chatId, open)
  )
  ipcMain.handle('theme:set', (_e, theme: Theme) => setTheme(theme))
  ipcMain.handle('instructions:set', (_e, text: string) => {
    store.setInstructions(text)
    send('state:changed', store.getState())
  })
  ipcMain.handle('annotations:set', (_e, on: boolean) => {
    store.setAnnotations(on)
    send('state:changed', store.getState())
  })
  ipcMain.handle('recording:set', (_e, on: boolean) => {
    store.setRecording(on)
    send('state:changed', store.getState())
  })
  // Speech: turning it on downloads the voice when it is not on this Mac yet.
  ipcMain.handle('speech:set', (_e, on: boolean) => {
    store.setSpeech(on)
    send('state:changed', store.getState())
    if (on) void speech.fetchModel()
    else speech.stop()
  })
  ipcMain.handle('speech:status', () => speech.status())
  ipcMain.handle('speech:download', () => void speech.fetchModel())
  ipcMain.handle('speech:cancelDownload', () => speech.cancelDownload())
  ipcMain.handle('speech:remove', async () => {
    await speech.remove()
    store.setSpeech(false)
    send('state:changed', store.getState())
  })
  ipcMain.handle('speech:sample', (_e, text: string, language: Language) => {
    speech.speak(undefined, text, language)
  })
  ipcMain.handle('speech:stop', (_e, chatId?: string) => speech.stop(chatId))
  ipcMain.on('speech:begun', (_e, id: string) => speech.begun(id))
  ipcMain.on('speech:ended', (_e, id: string) => speech.ended(id))
  ipcMain.handle('state:get', () => store.getState())
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('update:available', () => availableUpdate())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('exa:keyHint', () => exaKeyHint())
  ipcMain.handle('exa:setKey', (_e, key: string | null) => setExaKey(key))
  ipcMain.handle('voice:keyHint', () => voiceKeyHint())
  ipcMain.handle('voice:setKey', (_e, key: string | null) => setVoiceKey(key))
  ipcMain.handle('voice:microphone', () => microphoneAccess())
  ipcMain.handle('voice:transcribe', (_e, audio: Uint8Array, mimeType: string) =>
    transcribe(audio, mimeType)
  )
  ipcMain.handle('providers:list', () => customProviders())
  ipcMain.handle('providers:save', async (_e, input: CustomProviderInput) => {
    const saved = saveCustomProvider(input)
    await agents.customProvidersChanged()
    return saved
  })
  ipcMain.handle('providers:remove', async (_e, id: string) => {
    removeCustomProvider(id)
    await agents.customProvidersChanged()
  })
  ipcMain.handle('providers:check', (_e, id: string) => checkCustomProvider(id))

  ipcMain.handle('project:add', async () => {
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
    send('state:changed', store.getState())
    return project
  })

  ipcMain.handle('project:remove', (_e, projectId: string) => {
    store.removeProject(projectId)
    send('state:changed', store.getState())
  })

  ipcMain.handle(
    'project:setStyle',
    (_e, projectId: string, style: Partial<Pick<Project, 'color' | 'icon'>>) => {
      store.updateProject(projectId, style)
      send('state:changed', store.getState())
    }
  )
  ipcMain.handle('project:icon', (_e, projectId: string) =>
    projectIcon(store.getProject(projectId).path)
  )
  ipcMain.handle('project:chooseIcon', async (_e, projectId: string) => {
    const icon = await chooseProjectIcon(mainWindow, store.getProject(projectId).path)
    if (icon === undefined) return undefined
    // The chosen image shows in place of any other icon.
    store.updateProject(projectId, { icon: undefined })
    send('state:changed', store.getState())
    return icon
  })

  ipcMain.handle(
    'chat:create',
    (
      _e,
      projectId: string,
      agent: AgentId,
      settings: Record<string, string>,
      permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'> = {}
    ) => {
      const chat = store.createChat({ projectId, agent, settings, ...permissions })
      send('state:changed', store.getState())
      return chat
    }
  )

  ipcMain.handle('chat:delete', async (_e, chatId: string) => {
    await agents.deleteChat(chatId)
    browser.closeChat(chatId)
  })

  // A chat the user leaves before sending anything is of no use, so it goes.
  ipcMain.handle('chat:leave', async (_e, chatId: string) => {
    const chat = store.getState().chats.find((c) => c.id === chatId)
    if (!chat || chat.running || chat.draft || store.getMessages(chatId).length > 0) return
    await agents.deleteChat(chatId)
    browser.closeChat(chatId)
  })

  // The composer saves its draft before it is left (Composer.tsx), so a chat
  // with only a draft is kept by chat:leave above.
  ipcMain.handle('chat:draft', (_e, chatId: string, text: string) => {
    if (!store.getState().chats.some((c) => c.id === chatId)) return
    store.updateChat(chatId, { draft: text || undefined })
    send('state:changed', store.getState())
  })

  ipcMain.handle('chat:rename', (_e, chatId: string, title: string) => {
    const trimmed = title.trim()
    if (!trimmed) return
    store.updateChat(chatId, { title: trimmed, renamed: true })
    send('state:changed', store.getState())
  })
  ipcMain.handle('chat:messages', (_e, chatId: string) => store.getMessages(chatId))

  ipcMain.handle(
    'chat:setAgent',
    (_e, chatId: string, agent: AgentId, settings: Record<string, string>) =>
      agents.changeAgent(chatId, agent, settings)
  )
  ipcMain.handle('chat:open', (_e, chatId: string) => agents.open(chatId))

  // Fire and forget: progress arrives through chat:item and state:changed events.
  ipcMain.handle('chat:send', (_e, chatId: string, text: string, attachments?: Attachment[]) => {
    void agents.send(chatId, text, attachments)
  })
  ipcMain.handle('files:pick', async (): Promise<Attachment[]> => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      buttonLabel: 'Attach'
    })
    return result.canceled ? [] : result.filePaths.map((path) => ({ name: basename(path), path }))
  })
  ipcMain.handle('files:thumbnail', (_e, path: string) => thumbnail(path))
  ipcMain.handle(
    'chat:setPermissions',
    (_e, chatId: string, permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'>) =>
      agents.setPermissions(chatId, permissions)
  )
  ipcMain.handle('chat:cancel', (_e, chatId: string) => {
    speech.stop(chatId)
    return agents.cancel(chatId)
  })
  ipcMain.handle('chat:takeWaiting', (_e, chatId: string, id: string) =>
    agents.takeWaiting(chatId, id)
  )
  ipcMain.handle('chat:stopCommand', (_e, chatId: string, pid: number) =>
    agents.stopCommand(chatId, pid)
  )
  ipcMain.handle('chat:clearTimer', (_e, chatId: string) => {
    agents.clearTimer(chatId)
  })
  ipcMain.handle('chat:setOption', (_e, chatId: string, optionId: string, value: string) =>
    agents.setOption(chatId, optionId, value)
  )
  ipcMain.handle('chat:permission', (_e, chatId: string, permissionId: string, optionId: string) =>
    agents.resolvePermission(chatId, permissionId, optionId)
  )
  ipcMain.handle(
    'chat:answerForm',
    (_e, chatId: string, formId: string, answers: FormAnswers | null) =>
      agents.answerForm(chatId, formId, answers)
  )

  ipcMain.handle('agents:status', (_e, agent: AgentId) => agents.status(agent))
  ipcMain.handle('agents:models', (_e, agent: AgentId, projectId: string) =>
    agents.models(agent, projectId)
  )

  ipcMain.on('browser:setChat', (_e, chatId: string | null) =>
    browser.setActiveChat(chatId ?? undefined)
  )
  ipcMain.on('browser:setBounds', (_e, rect: Rect | null) => browser.setBounds(rect))
  ipcMain.on('browser:setHidden', (_e, hidden: boolean) => browser.setPanelHidden(hidden))
  ipcMain.handle('browser:capture', () => browser.capturePanel())
  ipcMain.handle('browser:navigate', (_e, url: string) =>
    browser.navigate(url).catch(() => undefined)
  )
  ipcMain.handle('browser:back', () => browser.back())
  ipcMain.handle('browser:forward', () => browser.forward())
  ipcMain.handle('browser:reload', () => browser.reload())
  ipcMain.handle('browser:selectTab', (_e, tabId: string) => browser.selectActiveChatTab(tabId))
  ipcMain.handle('browser:closeTab', (_e, tabId: string) => browser.closeActiveChatTab(tabId))
  ipcMain.handle('browser:newTab', () => browser.newActiveChatTab())
  ipcMain.on('browser:menu', (_e, x: number, y: number) => browser.showMenu(x, y))
  ipcMain.handle('browser:state', () => browser.state())

  ipcMain.handle('files:list', (_e, projectPath: string) => listProjectFiles(projectPath))
  ipcMain.handle('skills:list', (_e, projectPath?: string) => skills.listSkills(projectPath))
  ipcMain.handle('skills:read', (_e, path: string, projectPath?: string) =>
    skills.readSkill(path, projectPath)
  )
  ipcMain.handle('skills:create', (_e, name: string, scope: SkillScope, projectPath?: string) =>
    skills.createSkill(name, scope, projectPath)
  )
  ipcMain.handle('skills:save', (_e, path: string, content: string, projectPath?: string) =>
    skills.saveSkill(path, content, projectPath)
  )
  ipcMain.handle('skills:delete', (_e, path: string, projectPath?: string) =>
    skills.deleteSkill(path, projectPath)
  )
  ipcMain.handle('skills:reveal', (_e, path: string) => shell.showItemInFolder(path))
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
registerImageScheme()

app.whenReady().then(async () => {
  // A packaged build takes its icon from the bundle; in development the Electron
  // binary's own icon would show, so set it here.
  if (!app.isPackaged) app.dock?.setIcon(appIcon)
  electronApp.setAppUserModelId('dev.barebone.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // Only commands need PATH, and they wait for it; the window does not.
  void loadShellPath()
  handleImageRequests()
  // Set before the window exists so it opens in the right appearance.
  nativeTheme.themeSource = store.getState().theme ?? 'system'
  installMenu((command) => send('menu', command), nativeTheme.themeSource, setTheme)
  speech = new Speech({
    status: (status) => send('speech:status', status),
    audio: (audio) => send('speech:audio', audio),
    stop: (which) => send('speech:stop', which)
  })
  browser = createWindow()
  recorder = new PageRecorder(mainWindow.webContents)
  registerIpc(browser)
  // On by default: the voice downloads in the background the first time.
  if (store.speechOn()) void speech.fetchModel()
  watchForUpdates((version) => send('update:available', version))
  const endpoint = await startBrowserMcp(
    browser,
    {
      chatForBrowserId: (id) => store.getState().chats.find((c) => c.id.startsWith(id))?.id,
      fallbackChat: () => agents.latestActiveChat()
    },
    agents,
    {
      // Offered once the voice is on this Mac, so an agent never speaks into a missing one.
      on: () => store.speechOn() && speech.status().state === 'ready',
      speak: (chatId, text, language, pace) => speech.speak(chatId, text, language, pace),
      said: (chatId) => speech.said(chatId)
    },
    recorder
  )
  // Only when cline is installed; failures are logged and the app works without it.
  // One at a time: each rewrites cline's settings file.
  agents.status('cline').then(async ({ available }) => {
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
})

app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
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
  speech.dispose()
  // Waited for up to a limit: one that never settles (an MCP server that never
  // answers) would otherwise keep the app open, and the updater replaces it.
  const waits = { agents: stopped, browser: browser?.flush(), recordings: recorded }
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
