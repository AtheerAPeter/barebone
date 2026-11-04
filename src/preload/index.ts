import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AgentCommand,
  Attachment,
  AgentModels,
  AgentOption,
  OpenChatResult,
  AgentStatus,
  AgentId,
  AppState,
  BrowserState,
  Chat,
  ChatItem,
  CodeDoc,
  CustomProvider,
  CustomProviderCheck,
  CustomProviderInput,
  FormAnswers,
  MobileToolCheck,
  GitBranch,
  GitChange,
  GitStatus,
  MeetingLanguage,
  MeetingState,
  OrbState,
  Project,
  RecordingRequest,
  SpeechStatus,
  SpeechStop,
  SpokenAudio,
  Rect,
  Skill,
  SkillScope,
  Theme,
  WalkAt,
  WalkControl,
  Walkthrough
} from '../shared/types'
import type { MenuCommand } from '../main/menu'

function on<Args extends unknown[]>(
  channel: string,
  listener: (...args: Args) => void
): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    listener(...(args as Args))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  update: {
    /** A newer release's version, once the app has found one; null until then. */
    available: (): Promise<string | null> => ipcRenderer.invoke('update:available'),
    onAvailable: (listener: (version: string) => void) => on('update:available', listener),
    /** Ask GitHub now: the newer release's version, or null when this app is the latest. */
    check: (): Promise<string | null> => ipcRenderer.invoke('update:check'),
    /** Quit, install the newer release and open it; rejects with the reason when that fails. */
    install: (): Promise<void> => ipcRenderer.invoke('update:install')
  },
  onState: (listener: (state: AppState) => void) => on('state:changed', listener),
  onMenu: (listener: (command: MenuCommand) => void) => on('menu', listener),
  setTheme: (theme: Theme): Promise<void> => ipcRenderer.invoke('theme:set', theme),
  /** Save the instructions the app's own agent gets in new chats; empty removes them. */
  setInstructions: (text: string): Promise<void> => ipcRenderer.invoke('instructions:set', text),
  /** Give agents the browser tools that draw on pages, and their skill, or take them away. */
  setAnnotations: (on: boolean): Promise<void> => ipcRenderer.invoke('annotations:set', on),
  /** Give agents the browser tools that record a tab as a video, or take them away. */
  setRecording: (on: boolean): Promise<void> => ipcRenderer.invoke('recording:set', on),
  /** Give agents the walkthrough tool, which plays in the code panel, or take it away. */
  setCodeTours: (on: boolean): Promise<void> => ipcRenderer.invoke('codeTours:set', on),
  /** Give agents the device tools, for mobile apps, or take them away. */
  setMobile: (on: boolean): Promise<void> => ipcRenderer.invoke('mobile:set', on),

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
    started: (id: string): void => ipcRenderer.send('recording:started', id),
    failed: (id: string, message: string): void =>
      ipcRenderer.send('recording:failed', id, message),
    /** The next piece of the MP4 file. */
    data: (id: string, chunk: Uint8Array): void => ipcRenderer.send('recording:data', id, chunk),
    /** All of it was sent; with why, when it stopped by itself. */
    ended: (id: string, error?: string): void => ipcRenderer.send('recording:ended', id, error)
  },

  exa: {
    /** The saved Exa API key's last four characters; null when none is saved. */
    keyHint: (): Promise<string | null> => ipcRenderer.invoke('exa:keyHint'),
    /** Save a key, or remove the saved one (null); returns the new hint. */
    setKey: (key: string | null): Promise<string | null> => ipcRenderer.invoke('exa:setKey', key)
  },

  /** The agent orb over the browser page, which stands in for the chat while it is folded away. */
  orb: {
    /** What the orb shows for the selected chat; null hides it. */
    update: (state: OrbState | null): void => ipcRenderer.send('orb:state', state),
    /** The user clicked the orb or a subtitle: the chat unfolds. */
    onUnfold: (listener: () => void) => on('orb:unfold', listener),
    /** How loud the microphone is, 0 to 1, while the user dictates with the chat folded. */
    level: (level: number): void => ipcRenderer.send('orb:level', level),
    /** Dictated text, into the orb's input, as the composer is out of sight. */
    draft: (text: string): void => ipcRenderer.send('orb:draft', text)
  },

  /** The voice agents speak with (the speak tool), run on this Mac (main/speech). */
  speech: {
    /** Turn speech on or off; on downloads the voice when it is not on this Mac yet. */
    set: (on: boolean): Promise<void> => ipcRenderer.invoke('speech:set', on),
    status: (): Promise<SpeechStatus> => ipcRenderer.invoke('speech:status'),
    onStatus: (listener: (status: SpeechStatus) => void) => on('speech:status', listener),
    /** Download the voice again, after a failed or cancelled download. */
    download: (): Promise<void> => ipcRenderer.invoke('speech:download'),
    cancelDownload: (): Promise<void> => ipcRenderer.invoke('speech:cancelDownload'),
    /** Delete the voice from this Mac; speech turns off. */
    remove: (): Promise<void> => ipcRenderer.invoke('speech:remove'),
    /** Say a sample, to hear the voice. */
    sample: (text: string, language: string): Promise<void> =>
      ipcRenderer.invoke('speech:sample', text, language),
    /** Stop what a chat says; every chat when undefined. */
    stop: (chatId?: string): Promise<void> => ipcRenderer.invoke('speech:stop', chatId),
    /** A piece of a spoken message, to play. */
    onAudio: (listener: (audio: SpokenAudio) => void) => on('speech:audio', listener),
    /** Stop playing a message, or what a chat said, or everything. */
    onStop: (listener: (which: SpeechStop) => void) => on('speech:stop', listener),
    /** The player is about to play a message: what is shown with it can go ahead. */
    begun: (id: string): void => ipcRenderer.send('speech:begun', id),
    /** The player played a message to its end. */
    ended: (id: string): void => ipcRenderer.send('speech:ended', id)
  },

  /** Voice input in the composer, written out by Whisper on Groq. */
  voice: {
    /** The saved Groq API key's last four characters; null when none is saved. */
    keyHint: (): Promise<string | null> => ipcRenderer.invoke('voice:keyHint'),
    /** Save a key, or remove the saved one (null); returns the new hint. */
    setKey: (key: string | null): Promise<string | null> => ipcRenderer.invoke('voice:setKey', key),
    /** Whether the app may use the microphone; on macOS, asks the user the first time. */
    microphone: (): Promise<boolean> => ipcRenderer.invoke('voice:microphone'),
    /** The text spoken in a recording; rejects with why it could not be written out. */
    transcribe: (audio: Uint8Array, mimeType: string): Promise<string> =>
      ipcRenderer.invoke('voice:transcribe', audio, mimeType),
    /**
     * Right ⌘, from anywhere in the app (a browser page too): down, up, or
     * `combo` when another key went down while it was held.
     */
    onKey: (listener: (key: 'keyDown' | 'keyUp' | 'combo', repeat: boolean) => void) =>
      on('voice:key', listener),
    /** The app lost focus: a held key's release goes elsewhere. */
    onBlur: (listener: () => void) => on('voice:blur', listener)
  },

  /** The providers added in Settings, which the Custom providers agent runs on. */
  providers: {
    list: (): Promise<CustomProvider[]> => ipcRenderer.invoke('providers:list'),
    /** Add a provider, or change one (with its id); rejects with what is wrong with it. */
    save: (input: CustomProviderInput): Promise<CustomProvider> =>
      ipcRenderer.invoke('providers:save', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('providers:remove', id),
    /** List the provider's models now: how many, or why it could not. */
    check: (id: string): Promise<CustomProviderCheck> => ipcRenderer.invoke('providers:check', id)
  },

  addProject: (): Promise<Project | null> => ipcRenderer.invoke('project:add'),
  removeProject: (projectId: string): Promise<void> =>
    ipcRenderer.invoke('project:remove', projectId),
  setProjectStyle: (
    projectId: string,
    style: Partial<Pick<Project, 'color' | 'icon'>>
  ): Promise<void> => ipcRenderer.invoke('project:setStyle', projectId, style),
  /** The project's own icon (its favicon) as a data URL; null when none was found. */
  projectIcon: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke('project:icon', projectId),
  /** Choose an image as the project's icon, saved in the project; undefined when cancelled. */
  chooseProjectIcon: (projectId: string): Promise<string | null | undefined> =>
    ipcRenderer.invoke('project:chooseIcon', projectId),

  createChat: (
    projectId: string,
    agent: AgentId,
    settings: Record<string, string>,
    permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'> = {}
  ): Promise<Chat> => ipcRenderer.invoke('chat:create', projectId, agent, settings, permissions),
  deleteChat: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:delete', chatId),
  /** Keep what is typed in a chat's composer; empty text clears it. */
  setDraft: (chatId: string, text: string): Promise<void> =>
    ipcRenderer.invoke('chat:draft', chatId, text),
  /** Leaving a chat: deletes it if nothing was sent or typed in it. */
  leaveChat: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:leave', chatId),
  renameChat: (chatId: string, title: string): Promise<void> =>
    ipcRenderer.invoke('chat:rename', chatId, title),
  pinChat: (chatId: string, pinned: boolean): Promise<void> =>
    ipcRenderer.invoke('chat:pin', chatId, pinned),
  getMessages: (chatId: string): Promise<ChatItem[]> => ipcRenderer.invoke('chat:messages', chatId),
  setAgent: (chatId: string, agent: AgentId, settings: Record<string, string>): Promise<void> =>
    ipcRenderer.invoke('chat:setAgent', chatId, agent, settings),
  send: (chatId: string, text: string, attachments: Attachment[] = []): Promise<void> =>
    ipcRenderer.invoke('chat:send', chatId, text, attachments),
  /** Choose files to attach with the system file picker. */
  pickFiles: (): Promise<Attachment[]> => ipcRenderer.invoke('files:pick'),
  /** A small preview of an image file, as a data URL; null when it cannot be read. */
  thumbnail: (path: string): Promise<string | null> => ipcRenderer.invoke('files:thumbnail', path),
  /** The path of a dropped or pasted file (empty for data with no file, like a screenshot). */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  cancel: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:cancel', chatId),
  /** Take back a message waiting for the turn: undefined when it already joined it. */
  takeWaiting: (
    chatId: string,
    id: string
  ): Promise<{ text: string; attachments: Attachment[] } | undefined> =>
    ipcRenderer.invoke('chat:takeWaiting', chatId, id),
  /** Stop one of the chat's background commands; it does not wake the chat. */
  stopCommand: (chatId: string, pid: number): Promise<void> =>
    ipcRenderer.invoke('chat:stopCommand', chatId, pid),
  /** Clear the chat's timer. */
  clearTimer: (chatId: string): Promise<void> => ipcRenderer.invoke('chat:clearTimer', chatId),
  /** Set the permission mode: both settings in one call, so they never apply half-changed. */
  setPermissions: (
    chatId: string,
    permissions: Pick<Chat, 'bypassPermissions' | 'projectOnly'>
  ): Promise<void> => ipcRenderer.invoke('chat:setPermissions', chatId, permissions),
  setOption: (chatId: string, optionId: string, value: string): Promise<void> =>
    ipcRenderer.invoke('chat:setOption', chatId, optionId, value),
  resolvePermission: (chatId: string, permissionId: string, optionId: string): Promise<void> =>
    ipcRenderer.invoke('chat:permission', chatId, permissionId, optionId),
  /** Answer a form the agent asked for; null declines it. */
  answerForm: (chatId: string, formId: string, answers: FormAnswers | null): Promise<void> =>
    ipcRenderer.invoke('chat:answerForm', chatId, formId, answers),
  onItem: (listener: (chatId: string, item: ChatItem) => void) => on('chat:item', listener),

  openChat: (chatId: string): Promise<OpenChatResult> => ipcRenderer.invoke('chat:open', chatId),
  onCommands: (listener: (chatId: string, commands: AgentCommand[]) => void) =>
    on('chat:commands', listener),
  onOptions: (listener: (chatId: string, options: AgentOption[]) => void) =>
    on('chat:options', listener),
  agentStatus: (agent: AgentId): Promise<AgentStatus> => ipcRenderer.invoke('agents:status', agent),
  agentModels: (agent: AgentId, projectId: string): Promise<AgentModels> =>
    ipcRenderer.invoke('agents:models', agent, projectId),

  browser: {
    setBounds: (rect: Rect | null): void => ipcRenderer.send('browser:setBounds', rect),
    /** Hide the page for a moment while the panel stays open, as during a resize drag. */
    setHidden: (hidden: boolean): void => ipcRenderer.send('browser:setHidden', hidden),
    /** A picture of the page the panel shows, as a data URL; null when it shows none. */
    capture: (): Promise<string | null> => ipcRenderer.invoke('browser:capture'),
    /** Which chat's page the panel shows. */
    setChat: (chatId: string | null): void => ipcRenderer.send('browser:setChat', chatId),
    navigate: (url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', url),
    back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
    forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
    reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
    selectTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:selectTab', tabId),
    closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:closeTab', tabId),
    newTab: (): Promise<void> => ipcRenderer.invoke('browser:newTab'),
    /** Lay the page out at the panel's size again, after an agent set it to another. */
    fillPanel: (): Promise<void> => ipcRenderer.invoke('browser:fillPanel'),
    /** Open the panel's ⋮ menu at a point in the window. */
    showMenu: (x: number, y: number): void => ipcRenderer.send('browser:menu', x, y),
    getState: (): Promise<BrowserState> => ipcRenderer.invoke('browser:state'),
    onState: (listener: (state: BrowserState) => void) => on('browser:state', listener),
    /** Open or close the browser panel in a chat. */
    setOpen: (chatId: string, open: boolean): Promise<void> =>
      ipcRenderer.invoke('browser:setOpen', chatId, open)
  },

  /** The device tools, for mobile apps (main/devices.ts). */
  devices: {
    /** The tools the devices need, and which are installed. */
    checks: (): Promise<MobileToolCheck[]> => ipcRenderer.invoke('devices:checks')
  },

  /** The chat's agent in a Google Meet call open in one of its tabs (main/meeting.ts). */
  meeting: {
    /** Let the agent join; rejects with why it cannot. */
    join: (chatId: string, tabId: string, language: MeetingLanguage, name: string): Promise<void> =>
      ipcRenderer.invoke('meeting:join', chatId, tabId, language, name),
    leave: (chatId: string): Promise<void> => ipcRenderer.invoke('meeting:leave', chatId),
    getState: (): Promise<MeetingState | null> => ipcRenderer.invoke('meeting:state'),
    onState: (listener: (state: MeetingState | null) => void) => on('meeting:state', listener)
  },

  /** The code panel, in the browser panel's place: source control and walkthroughs. */
  code: {
    /** Open or close the code panel in a chat. */
    setOpen: (chatId: string, open: boolean): Promise<void> =>
      ipcRenderer.invoke('code:setOpen', chatId, open)
  },

  /** Agents' code walkthroughs (main/walkthrough.ts), played in the code panel. */
  walk: {
    /** The chat's walkthrough and where it is; null when its agent has started none. */
    get: (chatId: string): Promise<{ walk: Walkthrough; at: WalkAt } | null> =>
      ipcRenderer.invoke('walk:get', chatId),
    onStart: (listener: (chatId: string, walk: Walkthrough) => void) => on('walk:start', listener),
    onAt: (listener: (chatId: string, at: WalkAt) => void) => on('walk:at', listener),
    /** Play, pause, or move to another stop (`goto` with its index). */
    control: (chatId: string, action: WalkControl, index?: number): Promise<void> =>
      ipcRenderer.invoke('walk:control', chatId, action, index)
  },

  /** Source control in the code panel (main/git.ts), by project. */
  git: {
    status: (projectId: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', projectId),
    diff: (projectId: string, change: GitChange, staged: boolean): Promise<CodeDoc> =>
      ipcRenderer.invoke('git:diff', projectId, change, staged),
    stage: (projectId: string, changes: GitChange[]): Promise<void> =>
      ipcRenderer.invoke('git:stage', projectId, changes),
    unstage: (projectId: string, changes: GitChange[]): Promise<void> =>
      ipcRenderer.invoke('git:unstage', projectId, changes),
    /** After the user confirms; false when they did not. */
    discard: (projectId: string, changes: GitChange[]): Promise<boolean> =>
      ipcRenderer.invoke('git:discard', projectId, changes),
    /** Commit what is staged, or offer to stage everything first; false when nothing was committed. */
    commit: (projectId: string, message: string): Promise<boolean> =>
      ipcRenderer.invoke('git:commit', projectId, message),
    branches: (projectId: string): Promise<GitBranch[]> =>
      ipcRenderer.invoke('git:branches', projectId),
    checkout: (projectId: string, branch: GitBranch): Promise<void> =>
      ipcRenderer.invoke('git:checkout', projectId, branch),
    createBranch: (projectId: string, name: string): Promise<void> =>
      ipcRenderer.invoke('git:createBranch', projectId, name),
    /** Pull and push, or publish a branch with no upstream. */
    sync: (projectId: string): Promise<void> => ipcRenderer.invoke('git:sync', projectId),
    /** Tell when the project's repository changes on disk, until unwatch. */
    watch: (projectId: string): Promise<void> => ipcRenderer.invoke('git:watch', projectId),
    unwatch: (projectId: string): Promise<void> => ipcRenderer.invoke('git:unwatch', projectId),
    onChanged: (listener: (projectId: string) => void) => on('git:changed', listener)
  },

  listFiles: (projectPath: string): Promise<string[]> =>
    ipcRenderer.invoke('files:list', projectPath),
  /** What the user sent in the project's chats, newest first, for the composer to complete. */
  promptHistory: (projectId: string): Promise<string[]> =>
    ipcRenderer.invoke('prompts:history', projectId),

  skills: {
    list: (projectPath?: string): Promise<Skill[]> =>
      ipcRenderer.invoke('skills:list', projectPath),
    read: (path: string, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke('skills:read', path, projectPath),
    create: (name: string, scope: SkillScope, projectPath?: string): Promise<string> =>
      ipcRenderer.invoke('skills:create', name, scope, projectPath),
    save: (path: string, content: string, projectPath?: string): Promise<void> =>
      ipcRenderer.invoke('skills:save', path, content, projectPath),
    remove: (path: string, projectPath?: string): Promise<void> =>
      ipcRenderer.invoke('skills:delete', path, projectPath),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('skills:reveal', path)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
