import type {
  AgentCommand,
  Attachment,
  AgentModels,
  AgentOption,
  OpenChatResult,
  AgentStatus,
  AgentId,
  AppState,
  BotChange,
  BrowserState,
  Chat,
  ChatPermissions,
  ChatItem,
  CodeDoc,
  CustomProvider,
  FilePreview,
  FolderListing,
  CustomProviderCheck,
  CustomProviderInput,
  FolderSuggestions,
  FormAnswers,
  MobileToolCheck,
  GitBranch,
  GitChange,
  GitStatus,
  OrbState,
  Project,
  RecordingRequest,
  RemoteBrowserView,
  RemotePairing,
  RemoteStatus,
  DownloadId,
  Downloads,
  SpeechStop,
  SpokenAudio,
  Rect,
  Skill,
  SkillScope,
  TelegramStatus,
  TerminalInfo,
  Theme,
  VoiceModelId,
  WalkAt,
  WalkControl,
  Walkthrough
} from './types'
import type { FrameHeader } from './wire'
import type { MenuCommand } from '../main/menu'

/**
 * How the window reaches the main process. In the app it is Electron's IPC
 * (preload/index.ts); in a browser through the remote link, a WebSocket
 * (renderer/src/remote/socket.ts). The API is made from it once, here, so both
 * have every method.
 */
export interface Transport {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (...args: never[]) => void): () => void
  /** The path of a dropped or pasted file; empty for data with no file, and in a browser. */
  pathForFile(file: File): string
  /** True in a browser through the remote link: Mac-only parts of the UI are left out. */
  remote: boolean
}

// Its type is what it returns (Api, below): written out, it would repeat every method.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function makeApi(t: Transport) {
  const { invoke, send, on } = t
  return {
    remote: t.remote,
    getState: (): Promise<AppState> => invoke('state:get'),
    appVersion: (): Promise<string> => invoke('app:version'),
    update: {
      /** A newer release's version, once the app has found one; null until then. */
      available: (): Promise<string | null> => invoke('update:available'),
      onAvailable: (listener: (version: string) => void) => on('update:available', listener),
      /** Ask GitHub now: the newer release's version, or null when this app is the latest. */
      check: (): Promise<string | null> => invoke('update:check'),
      /** Quit, install the newer release and open it; rejects with the reason when that fails. */
      install: (): Promise<void> => invoke('update:install')
    },
    onState: (listener: (state: AppState) => void) => on('state:changed', listener),
    onMenu: (listener: (command: MenuCommand) => void) => on('menu', listener),
    /** Tell the Mac which chat the window shows, or none, so bots notify only when it is not this one. */
    showingChat: (chatId: string | null): void => send('window:chat', chatId),
    /** Open a chat: the user clicked a bot's notification. */
    onOpenChat: (listener: (chatId: string) => void) => on('window:openChat', listener),
    setTheme: (theme: Theme): Promise<void> => invoke('theme:set', theme),
    /** Save the instructions the app's own agent gets in new chats; empty removes them. */
    setInstructions: (text: string): Promise<void> => invoke('instructions:set', text),
    /** Give agents the browser tools that draw on pages, and their skill, or take them away. */
    setAnnotations: (on: boolean): Promise<void> => invoke('annotations:set', on),
    /** Give agents the browser tools that record a tab as a video, or take them away. */
    setRecording: (on: boolean): Promise<void> => invoke('recording:set', on),
    /** Give agents the walkthrough tool, which plays in the code panel, or take it away. */
    setCodeTours: (on: boolean): Promise<void> => invoke('codeTours:set', on),
    /** Give agents the device tools, for mobile apps, or take them away. */
    setMobile: (on: boolean): Promise<void> => invoke('mobile:set', on),

    /** Videos of browser tabs agents record, made here (main/recording.ts). */
    recording: {
      /** Main asks for a tab to be recorded. */
      onStart: (listener: (request: RecordingRequest) => void) => on('recording:start', listener),
      /** Main asks for a recording to stop. */
      onStop: (listener: (id: string) => void) => on('recording:stop', listener),
      /** Main asks for a recording to pause, while the agent works out what to do next. */
      onPause: (listener: (id: string) => void) => on('recording:pause', listener),
      /** Main asks for a paused recording to go on. */
      onResume: (listener: (id: string) => void) => on('recording:resume', listener),
      started: (id: string): void => send('recording:started', id),
      failed: (id: string, message: string): void => send('recording:failed', id, message),
      /** The next piece of the MP4 file. */
      data: (id: string, chunk: Uint8Array): void => send('recording:data', id, chunk),
      /** All of it was sent; with why, when it stopped by itself. */
      ended: (id: string, error?: string): void => send('recording:ended', id, error)
    },

    exa: {
      /** The saved Exa API key's last four characters; null when none is saved. */
      keyHint: (): Promise<string | null> => invoke('exa:keyHint'),
      /** Save a key, or remove the saved one (null); returns the new hint. */
      setKey: (key: string | null): Promise<string | null> => invoke('exa:setKey', key)
    },

    /** The agent orb over the browser page, which stands in for the chat while it is folded away. */
    orb: {
      /** What the orb shows for the selected chat; null hides it. */
      update: (state: OrbState | null): void => send('orb:state', state),
      /** The user clicked the orb or a subtitle: the chat unfolds. */
      onUnfold: (listener: () => void) => on('orb:unfold', listener),
      /** How loud the microphone is, 0 to 1, while the user dictates with the chat folded. */
      level: (level: number): void => send('orb:level', level),
      /** Dictated text, into the orb's input, as the composer is out of sight. */
      draft: (text: string): void => send('orb:draft', text)
    },

    /** What the app downloads when asked: the voices, the music model, ffmpeg (main/downloads.ts). */
    downloads: {
      status: (): Promise<Downloads> => invoke('downloads:status'),
      onStatus: (listener: (downloads: Downloads) => void) => on('downloads:status', listener),
      /** Download one; resolves once it has started. */
      fetch: (id: DownloadId): Promise<void> => invoke('downloads:fetch', id),
      cancel: (id: DownloadId): Promise<void> => invoke('downloads:cancel', id),
      /** Delete one from this Mac, to free its space. */
      remove: (id: DownloadId): Promise<void> => invoke('downloads:remove', id)
    },

    /** Let agents make music (make_music, and speak's music), or stop them. */
    setMusic: (on: boolean): Promise<void> => invoke('music:set', on),

    /** The voices agents speak with (the speak tool), run on this Mac (main/speech). */
    speech: {
      /** Turn speech on or off; on downloads Supertonic when no voice is on this Mac yet. */
      set: (on: boolean): Promise<void> => invoke('speech:set', on),
      /** Turn a voice on or off; a downloaded one stays on this Mac. */
      setVoiceOn: (model: VoiceModelId, on: boolean): Promise<void> =>
        invoke('speech:setVoiceOn', model, on),
      /** Pick the voice that speaks Arabic, or the one for every other language. */
      setVoiceFor: (which: 'arabic' | 'other', model: VoiceModelId): Promise<void> =>
        invoke('speech:setVoiceFor', which, model),
      /** Let chats speak with Supertonic, or with the voice picked per language; videos keep that one. */
      setSupertonicInChats: (on: boolean): Promise<void> =>
        invoke('speech:setSupertonicInChats', on),
      /** Make VoxCPM2's voice from a description; resolves once it is made. */
      makeVoice: (description: string): Promise<void> => invoke('speech:makeVoice', description),
      /** Say a sample, to hear a voice: the one Settings picks for the language, or `model`. */
      sample: (text: string, language: string, model?: VoiceModelId): Promise<void> =>
        invoke('speech:sample', text, language, model),
      /** Stop what a chat says; every chat when undefined. */
      stop: (chatId?: string): Promise<void> => invoke('speech:stop', chatId),
      /** A piece of a spoken message, to play. */
      onAudio: (listener: (audio: SpokenAudio) => void) => on('speech:audio', listener),
      /** Stop playing a message, or what a chat said, or everything. */
      onStop: (listener: (which: SpeechStop) => void) => on('speech:stop', listener),
      /** The player is about to play a message: what is shown with it can go ahead. */
      begun: (id: string): void => send('speech:begun', id),
      /** The player played a message to its end. */
      ended: (id: string): void => send('speech:ended', id)
    },

    /** Voice input in the composer, written out by Whisper on Groq. */
    voice: {
      /** The saved Groq API key's last four characters; null when none is saved. */
      keyHint: (): Promise<string | null> => invoke('voice:keyHint'),
      /** Save a key, or remove the saved one (null); returns the new hint. */
      setKey: (key: string | null): Promise<string | null> => invoke('voice:setKey', key),
      /** Whether the app may use the microphone; on macOS, asks the user the first time. */
      microphone: (): Promise<boolean> => invoke('voice:microphone'),
      /** The text spoken in a recording; rejects with why it could not be written out. */
      transcribe: (audio: Uint8Array, mimeType: string): Promise<string> =>
        invoke('voice:transcribe', audio, mimeType),
      /**
       * Right ⌘, from anywhere in the app (a browser page too): down, up, or
       * `combo` when another key went down while it was held.
       */
      onKey: (listener: (key: 'keyDown' | 'keyUp' | 'combo', repeat: boolean) => void) =>
        on('voice:key', listener),
      /** The app lost focus: a held key's release goes elsewhere. */
      onBlur: (listener: () => void) => on('voice:blur', listener)
    },

    /** Control from Telegram (main/telegram): a bot that carries one chat to the user's phone. */
    telegram: {
      /** The saved bot token's last four characters; null when none is saved. */
      keyHint: (): Promise<string | null> => invoke('telegram:keyHint'),
      /** Save a token, checked with Telegram first, or remove it (null); returns the new hint. */
      setKey: (key: string | null): Promise<string | null> => invoke('telegram:setKey', key),
      status: (): Promise<TelegramStatus> => invoke('telegram:status'),
      onStatus: (listener: (status: TelegramStatus) => void) => on('telegram:status', listener),
      /** Make a chat the one the bot controls, or none (null). */
      link: (chatId: string | null): Promise<void> => invoke('telegram:link', chatId)
    },

    /**
     * The remote link (main/remote): this app in a browser anywhere, through
     * zrok. Set up on the Mac only; a device joins by scanning a pairing QR code.
     */
    remoteLink: {
      status: (): Promise<RemoteStatus> => invoke('remote:status'),
      onStatus: (listener: (status: RemoteStatus) => void) => on('remote:status', listener),
      /** Connect zrok to the user's account, with the account token from myzrok.io. */
      enableZrok: (token: string): Promise<void> => invoke('remote:enableZrok', token),
      /** Open or close the link. */
      setOn: (on: boolean): Promise<void> => invoke('remote:setOn', on),
      /** A new one-time link that pairs a device; the one before stops working. */
      pair: (): Promise<RemotePairing> => invoke('remote:pair'),
      signOut: (sessionId: string): Promise<void> => invoke('remote:signOut', sessionId),
      /** Let paired devices see and use the browser's tabs, or stop them. */
      setBrowser: (on: boolean): Promise<void> => invoke('remote:setBrowser', on)
    },

    /**
     * A chat's browser tab, live, in a browser through the remote link
     * (main/remote/browser.ts), while Settings on the Mac allow it. Points are
     * in the page's CSS pixels.
     */
    remoteBrowser: {
      allowed: (): Promise<boolean> => invoke('remoteBrowser:allowed'),
      onAllowed: (listener: (on: boolean) => void) => on('remoteBrowser:allowed', listener),
      /** Show a chat's tab here, the page laid out at this size; another device showing it stops. */
      open: (
        chatId: string,
        size: { width: number; height: number; ratio: number }
      ): Promise<RemoteBrowserView> => invoke('remoteBrowser:open', chatId, size),
      resize: (size: { width: number; height: number; ratio: number }): Promise<void> =>
        invoke('remoteBrowser:resize', size),
      close: (): Promise<void> => invoke('remoteBrowser:close'),
      onState: (listener: (view: RemoteBrowserView) => void) => on('remoteBrowser:state', listener),
      /** A picture of the page; call ack once it shows, for the next. */
      onFrame: (listener: (header: FrameHeader, jpeg: Uint8Array) => void) =>
        on('remoteBrowser:frame', listener),
      ack: (): void => send('remoteBrowser:ack'),
      /** It stopped showing here: another device opened it, or the Mac turned it off. */
      onClosed: (listener: (chatId: string, reason: 'elsewhere' | 'off') => void) =>
        on('remoteBrowser:closed', listener),
      /** The connection to the Mac came back: what was shown here must be opened again. */
      onReconnected: (listener: () => void) => on('remote:reconnected', listener),
      tap: (x: number, y: number): Promise<void> => invoke('remoteBrowser:tap', x, y),
      scroll: (x: number, y: number, dx: number, dy: number): Promise<void> =>
        invoke('remoteBrowser:scroll', x, y, dx, dy),
      type: (text: string): Promise<void> => invoke('remoteBrowser:type', text),
      /** A key by name: Enter, Backspace, Tab. */
      key: (key: string): Promise<void> => invoke('remoteBrowser:key', key),
      /** The label of the field that has focus; '' for one without, null for none. */
      focused: (): Promise<string | null> => invoke('remoteBrowser:focused'),
      /** Answer the page's alert() or confirm(): OK, or Cancel. */
      answer: (accept: boolean): Promise<void> => invoke('remoteBrowser:answer', accept),
      navigate: (input: string): Promise<void> => invoke('remoteBrowser:navigate', input),
      back: (): Promise<void> => invoke('remoteBrowser:back'),
      forward: (): Promise<void> => invoke('remoteBrowser:forward'),
      reload: (): Promise<void> => invoke('remoteBrowser:reload'),
      selectTab: (tabId: string): Promise<void> => invoke('remoteBrowser:selectTab', tabId),
      closeTab: (tabId: string): Promise<void> => invoke('remoteBrowser:closeTab', tabId),
      newTab: (): Promise<void> => invoke('remoteBrowser:newTab')
    },

    /** The providers added in Settings, which the Custom providers agent runs on. */
    providers: {
      list: (): Promise<CustomProvider[]> => invoke('providers:list'),
      /** Add a provider, or change one (with its id); rejects with what is wrong with it. */
      save: (input: CustomProviderInput): Promise<CustomProvider> =>
        invoke('providers:save', input),
      remove: (id: string): Promise<void> => invoke('providers:remove', id),
      /** List the provider's models now: how many, or why it could not. */
      check: (id: string): Promise<CustomProviderCheck> => invoke('providers:check', id)
    },

    addProject: (): Promise<Project | null> => invoke('project:add'),
    /** The project of a folder by its path ("~/projects/app"); rejects when there is no folder there. */
    addProjectAt: (path: string): Promise<Project> => invoke('project:addPath', path),
    /** The folders a typed path could mean, for the project picker. */
    folders: (typed: string): Promise<FolderSuggestions> => invoke('project:folders', typed),
    removeProject: (projectId: string): Promise<void> => invoke('project:remove', projectId),
    setProjectStyle: (
      projectId: string,
      style: Partial<Pick<Project, 'color' | 'icon'>>
    ): Promise<void> => invoke('project:setStyle', projectId, style),
    /** The project's own icon (its favicon) as a data URL; null when none was found. */
    projectIcon: (projectId: string): Promise<string | null> => invoke('project:icon', projectId),
    /** Choose an image as the project's icon, saved in the project; undefined when cancelled. */
    chooseProjectIcon: (projectId: string): Promise<string | null | undefined> =>
      invoke('project:chooseIcon', projectId),

    createChat: (
      projectId: string,
      agent: AgentId,
      settings: Record<string, string>,
      permissions: ChatPermissions = {}
    ): Promise<Chat> => invoke('chat:create', projectId, agent, settings, permissions),
    deleteChat: (chatId: string): Promise<void> => invoke('chat:delete', chatId),
    /** Keep what is typed in a chat's composer; empty text clears it. */
    setDraft: (chatId: string, text: string): Promise<void> => invoke('chat:draft', chatId, text),
    /** Leaving a chat: deletes it if nothing was sent or typed in it. */
    leaveChat: (chatId: string): Promise<void> => invoke('chat:leave', chatId),
    renameChat: (chatId: string, title: string): Promise<void> =>
      invoke('chat:rename', chatId, title),
    pinChat: (chatId: string, pinned: boolean): Promise<void> => invoke('chat:pin', chatId, pinned),
    getMessages: (chatId: string): Promise<ChatItem[]> => invoke('chat:messages', chatId),
    setAgent: (chatId: string, agent: AgentId, settings: Record<string, string>): Promise<void> =>
      invoke('chat:setAgent', chatId, agent, settings),
    send: (chatId: string, text: string, attachments: Attachment[] = []): Promise<void> =>
      invoke('chat:send', chatId, text, attachments),
    /** Choose files to attach with the system file picker. */
    pickFiles: (): Promise<Attachment[]> => invoke('files:pick'),
    /** A small preview of an image file, as a data URL; null when it cannot be read. */
    thumbnail: (path: string): Promise<string | null> => invoke('files:thumbnail', path),
    /** The path of a dropped or pasted file (empty for data with no file, like a screenshot). */
    pathForFile: (file: File): string => t.pathForFile(file),
    cancel: (chatId: string): Promise<void> => invoke('chat:cancel', chatId),
    /** Take back a message waiting for the turn: undefined when it already joined it. */
    takeWaiting: (
      chatId: string,
      id: string
    ): Promise<{ text: string; attachments: Attachment[] } | undefined> =>
      invoke('chat:takeWaiting', chatId, id),
    /** Stop one of the chat's background commands; it does not wake the chat. */
    stopCommand: (chatId: string, pid: number): Promise<void> =>
      invoke('chat:stopCommand', chatId, pid),
    /** Stop one of the chat's subagents, by its line; the chat's turn goes on. */
    stopSubagent: (chatId: string, id: string): Promise<void> =>
      invoke('chat:stopSubagent', chatId, id),
    /** Clear the chat's timer. */
    clearTimer: (chatId: string): Promise<void> => invoke('chat:clearTimer', chatId),
    /** Set the permission mode: its settings in one call, so they never apply half-changed. */
    setPermissions: (chatId: string, permissions: ChatPermissions): Promise<void> =>
      invoke('chat:setPermissions', chatId, permissions),
    setOption: (chatId: string, optionId: string, value: string): Promise<void> =>
      invoke('chat:setOption', chatId, optionId, value),
    resolvePermission: (chatId: string, permissionId: string, optionId: string): Promise<void> =>
      invoke('chat:permission', chatId, permissionId, optionId),
    /** Answer a form the agent asked for; null declines it. */
    answerForm: (chatId: string, formId: string, answers: FormAnswers | null): Promise<void> =>
      invoke('chat:answerForm', chatId, formId, answers),
    onItem: (listener: (chatId: string, item: ChatItem) => void) => on('chat:item', listener),

    openChat: (chatId: string): Promise<OpenChatResult> => invoke('chat:open', chatId),
    onCommands: (listener: (chatId: string, commands: AgentCommand[]) => void) =>
      on('chat:commands', listener),
    onOptions: (listener: (chatId: string, options: AgentOption[]) => void) =>
      on('chat:options', listener),
    agentStatus: (agent: AgentId): Promise<AgentStatus> => invoke('agents:status', agent),
    agentModels: (agent: AgentId, projectId: string): Promise<AgentModels> =>
      invoke('agents:models', agent, projectId),

    browser: {
      setBounds: (rect: Rect | null): void => send('browser:setBounds', rect),
      /** Hide the page for a moment while the panel stays open, as during a resize drag. */
      setHidden: (hidden: boolean): void => send('browser:setHidden', hidden),
      /** A picture of the page the panel shows, as a data URL; null when it shows none. */
      capture: (): Promise<string | null> => invoke('browser:capture'),
      /** Which chat's page the panel shows. */
      setChat: (chatId: string | null): void => send('browser:setChat', chatId),
      navigate: (url: string): Promise<void> => invoke('browser:navigate', url),
      back: (): Promise<void> => invoke('browser:back'),
      forward: (): Promise<void> => invoke('browser:forward'),
      reload: (): Promise<void> => invoke('browser:reload'),
      selectTab: (tabId: string): Promise<void> => invoke('browser:selectTab', tabId),
      closeTab: (tabId: string): Promise<void> => invoke('browser:closeTab', tabId),
      newTab: (): Promise<void> => invoke('browser:newTab'),
      /** Lay the page out at the panel's size again, after an agent set it to another. */
      fillPanel: (): Promise<void> => invoke('browser:fillPanel'),
      /** Open the panel's ⋮ menu at a point in the window. */
      showMenu: (x: number, y: number): void => send('browser:menu', x, y),
      getState: (): Promise<BrowserState> => invoke('browser:state'),
      onState: (listener: (state: BrowserState) => void) => on('browser:state', listener),
      /** Open or close the browser panel in a chat. */
      setOpen: (chatId: string, open: boolean): Promise<void> =>
        invoke('browser:setOpen', chatId, open)
    },

    /** The device tools, for mobile apps (main/devices.ts). */
    devices: {
      /** The tools the devices need, and which are installed. */
      checks: (): Promise<MobileToolCheck[]> => invoke('devices:checks')
    },

    /** The code panel, in the browser panel's place: source control and walkthroughs. */
    code: {
      /** Open or close the code panel in a chat. */
      setOpen: (chatId: string, open: boolean): Promise<void> =>
        invoke('code:setOpen', chatId, open)
    },

    /** Agents' code walkthroughs (main/walkthrough.ts), played in the code panel. */
    walk: {
      /** The chat's walkthrough and where it is; null when its agent has started none. */
      get: (chatId: string): Promise<{ walk: Walkthrough; at: WalkAt } | null> =>
        invoke('walk:get', chatId),
      onStart: (listener: (chatId: string, walk: Walkthrough) => void) =>
        on('walk:start', listener),
      onAt: (listener: (chatId: string, at: WalkAt) => void) => on('walk:at', listener),
      /** Play, pause, or move to another stop (`goto` with its index). */
      control: (chatId: string, action: WalkControl, index?: number): Promise<void> =>
        invoke('walk:control', chatId, action, index)
    },

    /** Source control in the code panel (main/git.ts), by project. */
    git: {
      status: (projectId: string): Promise<GitStatus> => invoke('git:status', projectId),
      diff: (projectId: string, change: GitChange, staged: boolean): Promise<CodeDoc> =>
        invoke('git:diff', projectId, change, staged),
      stage: (projectId: string, changes: GitChange[]): Promise<void> =>
        invoke('git:stage', projectId, changes),
      unstage: (projectId: string, changes: GitChange[]): Promise<void> =>
        invoke('git:unstage', projectId, changes),
      /** After the user confirms; false when they did not. */
      discard: (projectId: string, changes: GitChange[]): Promise<boolean> =>
        invoke('git:discard', projectId, changes),
      /** Commit what is staged, or offer to stage everything first; false when nothing was committed. */
      commit: (projectId: string, message: string): Promise<boolean> =>
        invoke('git:commit', projectId, message),
      branches: (projectId: string): Promise<GitBranch[]> => invoke('git:branches', projectId),
      checkout: (projectId: string, branch: GitBranch): Promise<void> =>
        invoke('git:checkout', projectId, branch),
      createBranch: (projectId: string, name: string): Promise<void> =>
        invoke('git:createBranch', projectId, name),
      /** Pull and push, or publish a branch with no upstream. */
      sync: (projectId: string): Promise<void> => invoke('git:sync', projectId),
      /** Tell when the project's repository changes on disk, until unwatch. */
      watch: (projectId: string): Promise<void> => invoke('git:watch', projectId),
      unwatch: (projectId: string): Promise<void> => invoke('git:unwatch', projectId),
      onChanged: (listener: (projectId: string) => void) => on('git:changed', listener)
    },

    /** Bots (main/bots.ts): their dashboards and what they know. */
    bots: {
      /** Where to load the bot's dashboard from; null until the bot has made one. */
      dashboard: (projectId: string): Promise<string | null> => invoke('bots:dashboard', projectId),
      /** The bot's memory.md; null when it has none. */
      memory: (projectId: string): Promise<string | null> => invoke('bots:memory', projectId),
      /** Save the bot as a file where the user chooses, for a Barebone on another computer. */
      exportToFile: (projectId: string): Promise<void> => invoke('bots:export', projectId),
      /** Delete the bot once the user confirms: its chats and routines, and its folder to the Trash. */
      remove: (projectId: string): Promise<void> => invoke('bots:delete', projectId),
      /** Make a bot from such a file, which the user chooses; null when they chose none or it failed. */
      importFromFile: (): Promise<Project | null> => invoke('bots:import'),
      /** Tell when anything in the bot's folder changes, and what, until unwatch. */
      watch: (projectId: string): Promise<void> => invoke('bots:watch', projectId),
      unwatch: (projectId: string): Promise<void> => invoke('bots:unwatch', projectId),
      onChanged: (listener: (projectId: string, change: BotChange) => void) =>
        on('bots:changed', listener)
    },

    listFiles: (projectPath: string): Promise<string[]> => invoke('files:list', projectPath),
    /** What the user sent in the project's chats, newest first, for the composer to complete. */
    promptHistory: (projectId: string): Promise<string[]> => invoke('prompts:history', projectId),

    skills: {
      list: (projectPath?: string): Promise<Skill[]> => invoke('skills:list', projectPath),
      read: (path: string, projectPath?: string): Promise<string> =>
        invoke('skills:read', path, projectPath),
      create: (name: string, scope: SkillScope, projectPath?: string): Promise<string> =>
        invoke('skills:create', name, scope, projectPath),
      save: (path: string, content: string, projectPath?: string): Promise<void> =>
        invoke('skills:save', path, content, projectPath),
      remove: (path: string, projectPath?: string): Promise<void> =>
        invoke('skills:delete', path, projectPath),
      reveal: (path: string): Promise<void> => invoke('skills:reveal', path)
    },

    /** The file manager (main/file-manager.ts): this computer's folders and files, by full path. */
    fileManager: {
      home: (): Promise<string> => invoke('fm:home'),
      list: (path: string): Promise<FolderListing> => invoke('fm:list', path),
      preview: (path: string): Promise<FilePreview> => invoke('fm:preview', path),
      /** The new folder's path. */
      makeFolder: (folder: string, name: string): Promise<string> =>
        invoke('fm:mkdir', folder, name),
      /** The renamed one's path. */
      rename: (path: string, name: string): Promise<string> => invoke('fm:rename', path, name),
      move: (paths: string[], folder: string): Promise<string[]> =>
        invoke('fm:move', paths, folder),
      /** Copy files on this computer into a folder (dropped on the window); a name taken gets a number. */
      copyInto: (paths: string[], folder: string): Promise<string[]> =>
        invoke('fm:copyInto', paths, folder),
      /** To the Trash on the Mac; for good where there is none. */
      remove: (paths: string[]): Promise<void> => invoke('fm:delete', paths),
      /** Show it in Finder (the Mac only). */
      reveal: (path: string): Promise<void> => invoke('fm:reveal', path)
    },

    /** Terminals (main/terminals.ts): shells the app runs, shared by every view of them. */
    terminal: {
      list: (): Promise<TerminalInfo[]> => invoke('terminal:list'),
      open: (cols: number, rows: number): Promise<TerminalInfo> =>
        invoke('terminal:open', cols, rows),
      close: (id: string): Promise<void> => invoke('terminal:close', id),
      /** Show the terminals here (or stop): each with what it printed lately. */
      watch: (on: boolean): Promise<(TerminalInfo & { backlog: string })[]> =>
        invoke('terminal:watch', on),
      write: (id: string, data: string): void => send('terminal:write', id, data),
      resize: (id: string, cols: number, rows: number): void =>
        send('terminal:resize', id, cols, rows),
      onData: (listener: (id: string, data: string) => void) => on('terminal:data', listener),
      onExit: (listener: (id: string) => void) => on('terminal:exit', listener),
      onList: (listener: (terminals: TerminalInfo[]) => void) => on('terminal:list', listener)
    }
  }
}

export type Api = ReturnType<typeof makeApi>
