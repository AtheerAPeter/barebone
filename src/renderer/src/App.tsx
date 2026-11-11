import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AGENTS,
  waitingOn,
  type AgentStatus,
  type AgentId,
  type AppState,
  type Project
} from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { SkillsView } from './components/SkillsView'
import { SettingsView } from './components/SettingsView'
import { BrowserPanel } from './components/BrowserPanel'
import { CodePanel } from './components/CodePanel'
import { BrowserSheet } from './remote/BrowserSheet'
import { ProjectPicker } from './components/ProjectPicker'
import { BotAvatar } from './components/BotAvatar'
import { BotDashboard, BotMemory, BotTabs, type BotPaneName } from './components/BotPane'
import { botColor, botStatus, BotsContext, nextRoutine } from './lib/bots'
import {
  BranchIcon,
  ChatIcon,
  ComposeIcon,
  GlobeIcon,
  OrbIcon,
  SidebarIcon
} from './components/icons'
import { readPref, writePref } from './lib/prefs'
import { usePageRecorder } from './lib/recording'
import { useSpeechPlayer } from './lib/speech'
import { LevelMeter } from './components/LevelMeter'
import { PHONE, useMedia, useNarrower } from './lib/touch'

/** How often the orb is told the agent's voice level while it speaks. */
const ORB_LEVEL_MS = 50

/** In a browser through the remote link (main/remote); the browser panel is the Mac's own. */
const REMOTE = window.api.remote

/** The narrowest top bar that fits a bot's switch beside its name; below it the switch gets a row of its own. */
const BOT_TABS_BESIDE = 600

export default function App(): React.JSX.Element {
  const [state, setState] = useState<AppState>({ projects: [], chats: [] })
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const [selectedChatId, setSelectedChatId] = useState<string | undefined>(() =>
    readPref('selectedChat', undefined)
  )
  const [view, setView] = useState<'chat' | 'skills' | 'settings'>('chat')
  const [sidebarOpen, setSidebarOpen] = useState(() => readPref('sidebarOpen', true))
  /** The sidebar is a drawer: picking something in it closes it. */
  const drawer = useMedia(PHONE) && REMOTE
  const [browserWidth, setBrowserWidth] = useState(() => readPref('browserWidth', 520))
  /** The chat is folded into the agent orb over the browser, while the browser is open. */
  const [chatFolded, setChatFolded] = useState(() => readPref('chatFolded', false))
  const mainRef = useRef<HTMLElement>(null)
  /** The top bar has no room for a bot's switch beside its name: a phone, or the chat next to the browser. */
  const narrowBar = useNarrower(mainRef, BOT_TABS_BESIDE)
  /** Whether the user is picking the project of a new chat. */
  const [picking, setPicking] = useState(false)
  const [statuses, setStatuses] = useState<Partial<Record<AgentId, AgentStatus>>>({})
  const readStatus = (id: AgentId): void => {
    window.api.agentStatus(id).then((status) => setStatuses((c) => ({ ...c, [id]: status })))
  }

  useEffect(() => {
    window.api.getState().then(setState)
    const offState = window.api.onState(setState)
    for (const { id } of AGENTS) readStatus(id)
    return offState
  }, [])

  useEffect(() => writePref('selectedChat', selectedChatId), [selectedChatId])
  // Escape leaves Skills or Settings for the chat, unless something there used the key.
  useEffect(() => {
    if (view === 'chat') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) setView('chat')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])
  // A chat left empty is deleted once the user moves on to another.
  const leftChatId = useRef(selectedChatId)
  useEffect(() => {
    if (leftChatId.current && leftChatId.current !== selectedChatId) {
      window.api.leaveChat(leftChatId.current)
    }
    leftChatId.current = selectedChatId
  }, [selectedChatId])
  useEffect(() => writePref('sidebarOpen', sidebarOpen), [sidebarOpen])
  useEffect(() => writePref('browserWidth', browserWidth), [browserWidth])
  useEffect(() => writePref('chatFolded', chatFolded), [chatFolded])
  // What agents say out loud (the speak tool), played here.
  const speech = useSpeechPlayer()
  // Videos agents record of browser tabs, made here, with what the chat says as the sound.
  usePageRecorder(speech.tap)
  // Clicking the orb, or one of its subtitles, brings the chat back.
  useEffect(() => window.api.orb.onUnfold(() => setChatFolded(false)), [])

  const chat = state.chats.find((c) => c.id === selectedChatId)
  // Between turns, what will wake the chat, so it does not look done.
  const waitingFor =
    chat && !chat.running
      ? waitingOn(chat, state.chats.filter((c) => c.startedBy === chat.id && c.running).length)
      : undefined
  // The browser panel belongs to the chat: each chat opens and closes its own.
  // It is a view on the Mac, which a page of the remote link cannot show.
  const browserOpen = !REMOTE && Boolean(chat?.browserOpen)
  const toggleBrowser = useCallback((chatId: string | undefined, open?: boolean) => {
    if (!chatId) return
    const current = stateRef.current.chats.find((c) => c.id === chatId)
    window.api.browser.setOpen(chatId, open ?? !current?.browserOpen)
  }, [])
  // The code panel takes the browser's place in the chat: opening one closes the other.
  // A page of the remote link keeps it to itself, so it leaves the Mac's panels as they are.
  // On a phone it covers everything, so it belongs to the chat it was opened over.
  const [pageCodeOpen, setPageCodeOpen] = useState<string>()
  const codeOpen = REMOTE
    ? Boolean(chat) && pageCodeOpen === chat?.id && view === 'chat'
    : Boolean(chat?.codeOpen)
  // Through the remote link, the Mac's browser tab shows live while the Mac allows it
  // (remote/BrowserSheet.tsx), in the code panel's place, as the browser panel is on the Mac.
  const [remoteBrowserAllowed, setRemoteBrowserAllowed] = useState(false)
  const [pageBrowserOpen, setPageBrowserOpen] = useState<string>()
  useEffect(() => {
    if (!REMOTE) return
    window.api.remoteBrowser.allowed().then(setRemoteBrowserAllowed, () => undefined)
    return window.api.remoteBrowser.onAllowed((on) => {
      setRemoteBrowserAllowed(on)
      // Turned off on the Mac: turned on again, the browser starts closed.
      if (!on) setPageBrowserOpen(undefined)
    })
  }, [])
  const remoteBrowserOpen =
    remoteBrowserAllowed && Boolean(chat) && pageBrowserOpen === chat?.id && view === 'chat'
  const toggleRemoteBrowser = (chatId: string | undefined, open?: boolean): void => {
    if (!chatId) return
    const opening = open ?? pageBrowserOpen !== chatId
    setPageBrowserOpen(opening ? chatId : undefined)
    if (opening) setPageCodeOpen(undefined)
  }
  const toggleCode = (chatId: string | undefined, open?: boolean): void => {
    if (!chatId) return
    if (REMOTE) {
      const opening = open ?? pageCodeOpen !== chatId
      if (opening) setPageBrowserOpen(undefined)
      return setPageCodeOpen(opening ? chatId : undefined)
    }
    const current = stateRef.current.chats.find((c) => c.id === chatId)
    window.api.code.setOpen(chatId, open ?? !current?.codeOpen)
  }

  // Folding needs the browser beside the chat; Skills and Settings always show whole.
  const folded = chatFolded && browserOpen && view === 'chat' && Boolean(chat)
  // The orb's ring follows the agent's voice while it speaks with the chat folded.
  const speakingHere = folded && speech.speaking?.chatId === chat?.id
  const speechLevel = speech.level
  useEffect(() => {
    if (!speakingHere) return
    const timer = setInterval(() => window.api.orb.level(speechLevel.current), ORB_LEVEL_MS)
    return () => clearInterval(timer)
  }, [speakingHere, speechLevel])

  // Each chat has its own browser page; the panel shows the selected chat's.
  const chatId = chat?.id
  useEffect(() => {
    if (!REMOTE) window.api.browser.setChat(chatId ?? null)
  }, [chatId])
  // The Mac knows which chat the window shows, so a bot notifies only when the user looks elsewhere.
  useEffect(() => {
    if (!REMOTE) window.api.showingChat(view === 'chat' ? (chatId ?? null) : null)
  }, [chatId, view])
  const project = state.projects.find((p) => p.id === chat?.projectId) ?? state.projects[0]
  /** The open chat's bot, when it is a bot's one conversation; a chat a bot started is a chat like any other. */
  const bot = chat && project?.bot && !chat.startedBy ? project : undefined
  // A bot's chat shows its dashboard or memory in its place until the user goes back to it.
  const [botPane, setBotPane] = useState<{ chatId: string; pane: BotPaneName }>()
  const pane: BotPaneName = bot && botPane && botPane.chatId === chat?.id ? botPane.pane : 'chat'
  const botTabs = bot && chat && view === 'chat' && (
    <BotTabs pane={pane} onPane={(next) => setBotPane({ chatId: chat.id, pane: next })} />
  )

  const newChat = useCallback(
    async (projectId: string) => {
      const agent = readPref<AgentId>('lastAgent', 'opencode')
      const created = await window.api.createChat(
        projectId,
        agent,
        readPref(`settings:${agent}`, {}),
        // New chats start in the permission mode picked last.
        readPref('permissions', {})
      )
      setSelectedChatId(created.id)
      setView('chat')
      if (drawer) setSidebarOpen(false)
    },
    [drawer]
  )

  /**
   * Open a bot: its one conversation, the first chat of its own (not one it
   * started), which goes on for good; started the first time.
   */
  const openBot = useCallback(
    (projectId: string) => {
      const conversation = stateRef.current.chats
        .filter((c) => c.projectId === projectId && !c.startedBy)
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!conversation) return void newChat(projectId)
      setSelectedChatId(conversation.id)
      setView('chat')
      if (drawer) setSidebarOpen(false)
    },
    [newChat, drawer]
  )
  const bots = useMemo(() => ({ projects: state.projects, openBot }), [state.projects, openBot])

  // Menu bar commands. The handler reads the selected chat through a ref so the
  // subscription is made once.
  const selectedChatRef = useRef(chat?.id)
  useEffect(() => {
    selectedChatRef.current = chat?.id
  }, [chat?.id])
  // A walkthrough an agent starts in a chat the user is not looking at waits, paused, for them.
  useEffect(
    () =>
      window.api.walk.onStart((chatId) => {
        if (chatId !== selectedChatRef.current) void window.api.walk.control(chatId, 'pause')
      }),
    []
  )
  // A bot's notification was clicked: its conversation opens.
  useEffect(
    () =>
      window.api.onOpenChat((id) => {
        setSelectedChatId(id)
        setView('chat')
        setBotPane(undefined)
      }),
    []
  )
  useEffect(
    () =>
      window.api.onMenu((command) => {
        if (command === 'toggle-sidebar') setSidebarOpen((o) => !o)
        else if (command === 'toggle-browser') toggleBrowser(selectedChatRef.current)
        else if (command === 'open-project') window.api.addProject()
        else if (command === 'open-settings') setView('settings')
        else if (command === 'new-chat') setPicking(true)
      }),
    [newChat, toggleBrowser]
  )

  async function changeAgent(agent: AgentId, chosen: Record<string, string>): Promise<void> {
    if (!chat) return
    writePref('lastAgent', agent)
    // What was picked along with the agent (its model) is remembered like any other choice.
    const settings = { ...readPref(`settings:${agent}`, {}), ...chosen }
    writePref(`settings:${agent}`, settings)
    await window.api.setAgent(chat.id, agent, settings)
  }

  async function changeOption(optionId: string, value: string): Promise<void> {
    if (!chat) return
    // Remember the choice so the next chat with this agent starts the same way.
    writePref(`settings:${chat.agent}`, {
      ...readPref(`settings:${chat.agent}`, {}),
      [optionId]: value
    })
    await window.api.setOption(chat.id, optionId, value)
  }

  return (
    <div className={`app${sidebarOpen ? '' : ' sidebar-hidden'}${folded ? ' chat-folded' : ''}`}>
      {/* Stays mounted so hiding it can slide instead of cut. */}
      <Sidebar
        open={sidebarOpen}
        state={state}
        selectedChatId={chat?.id}
        view={view}
        onSelectChat={(id) => {
          setSelectedChatId(id)
          setView('chat')
          if (drawer) setSidebarOpen(false)
        }}
        onNewChat={() => {
          setPicking(true)
          if (drawer) setSidebarOpen(false)
        }}
        onNewChatIn={newChat}
        onOpenBot={openBot}
        onShowSkills={() => {
          setView((v) => (v === 'skills' ? 'chat' : 'skills'))
          if (drawer) setSidebarOpen(false)
        }}
        onShowSettings={() => {
          setView((v) => (v === 'settings' ? 'chat' : 'settings'))
          if (drawer) setSidebarOpen(false)
        }}
        onHide={() => setSidebarOpen(false)}
      />
      {drawer && sidebarOpen && (
        <div className="drawer-scrim" onClick={() => setSidebarOpen(false)} />
      )}
      {/* Hidden, not unmounted, while folded: the chat keeps its place and its live output. */}
      {/* A bot's chat takes its color: the wash at the top, the user's messages and the accent. */}
      <main
        className={`main${bot && view === 'chat' ? ' bot-chat' : ''}`}
        style={
          bot && view === 'chat' ? ({ '--bot': botColor(bot) } as React.CSSProperties) : undefined
        }
        ref={mainRef}
      >
        <header className="topbar">
          {/* With the sidebar hidden, its toggle and New chat move here, as in ChatGPT. */}
          {!sidebarOpen && (
            <>
              <button
                className="icon-btn"
                title="Show sidebar (⌘B)"
                onClick={() => setSidebarOpen(true)}
              >
                <SidebarIcon />
              </button>
              <button className="icon-btn" title="New chat (⌘N)" onClick={() => setPicking(true)}>
                <ComposeIcon />
              </button>
            </>
          )}
          {bot && view === 'chat' && <BotAvatar project={bot} size={26} chat={chat} />}
          <div className="topbar-title">
            {project && (view === 'skills' || (view === 'chat' && chat && !bot)) && (
              <span className="crumb">{project.name} / </span>
            )}
            <TopbarName
              id={view === 'chat' ? chat?.id : view}
              text={
                view === 'skills'
                  ? 'Skills'
                  : view === 'settings'
                    ? 'Settings'
                    : bot
                      ? bot.name
                      : chat
                        ? chat.title
                        : 'Barebone'
              }
            />
          </div>
          {/* While the bot works or waits for the user, it says so in its job's place. */}
          {bot && view === 'chat' && (
            <span className="bot-job">{botStatus(chat) ?? bot.bot?.job}</span>
          )}
          {bot && view === 'chat' && <NextRoutine project={bot} />}
          {/* A narrow top bar shows only their marks; the titles say the rest. */}
          {view === 'chat' && chat?.waiting && (
            <span className="status-chip waiting" title="Needs you">
              <span className="status-chip-label">Needs you</span>
            </span>
          )}
          {view === 'chat' && chat?.running && !chat.waiting && (
            <span className="status-chip running" title="Working">
              <span className="spinner" />
              <span className="status-chip-label">Working</span>
            </span>
          )}
          {view === 'chat' && chat && speech.speaking?.chatId === chat.id && (
            <button
              className="status-chip speaking"
              title="Stop speaking"
              onClick={() => window.api.speech.stop(chat.id)}
            >
              <LevelMeter level={speech.level} />
              <span className="status-chip-label">Speaking</span>
            </button>
          )}
          {view === 'chat' && waitingFor && (
            <span
              className="status-chip running"
              title={`${waitingFor}. It is woken when they end.`}
            >
              <span className="spinner background" />
              <span className="status-chip-label">{waitingFor}</span>
            </span>
          )}
          <span className="spacer" />
          {botTabs && !narrowBar && botTabs}
          {browserOpen && view === 'chat' && chat && (
            <button
              className="icon-btn"
              title="Fold the chat into an orb over the browser"
              onClick={() => setChatFolded(true)}
            >
              <OrbIcon />
            </button>
          )}
          <button
            className={`icon-btn${codeOpen ? ' on' : ''}`}
            title="Source control and walkthroughs"
            disabled={!chat}
            onClick={() => toggleCode(chat?.id)}
          >
            <BranchIcon />
          </button>
          {!REMOTE && (
            <button
              className={`icon-btn${browserOpen ? ' on' : ''}`}
              title="Toggle browser (⇧⌘B)"
              disabled={!chat}
              onClick={() => toggleBrowser(chat?.id)}
            >
              <GlobeIcon />
            </button>
          )}
          {REMOTE && remoteBrowserAllowed && (
            <button
              className={`icon-btn${remoteBrowserOpen ? ' on' : ''}`}
              title={
                chat?.running && chat.browserOpen ? 'Browser: the agent is using it' : 'Browser'
              }
              disabled={!chat}
              onClick={() => toggleRemoteBrowser(chat?.id)}
            >
              <GlobeIcon />
              {/* The agent works in the browser: its panel opens on the Mac as it starts. */}
              {chat?.running && chat.browserOpen && <span className="agent-dot" />}
            </button>
          )}
        </header>
        {botTabs && narrowBar && <div className="bot-tabs-row">{botTabs}</div>}
        {view === 'skills' ? (
          <SkillsView key={project?.id} project={project} />
        ) : view === 'settings' ? (
          <SettingsView
            instructions={state.instructions}
            annotations={state.annotations === true}
            recording={state.recording === true}
            codeTours={state.codeTours === true}
            mobile={state.mobile === true}
            speech={state.speech !== false}
            voices={{
              off: state.voicesOff ?? [],
              voiceFor: state.voiceFor ?? {},
              supertonicInChats: state.supertonicInChats === true,
              description: state.voiceDescription
            }}
            music={state.music === true}
            onProvidersChange={() => readStatus('custom-api')}
          />
        ) : chat && project ? (
          // The card a chat shows when it has made a bot opens it.
          <BotsContext.Provider value={bots}>
            <ChatView
              key={`${chat.id}:${chat.agent}`}
              chat={chat}
              statuses={statuses}
              projectPath={project.path}
              onAgentChange={changeAgent}
              onOptionChange={changeOption}
              folded={folded}
              speaking={speech.speaking?.chatId === chat.id}
              onOpenBrowser={
                remoteBrowserAllowed ? () => toggleRemoteBrowser(chat.id, true) : undefined
              }
              hidden={pane !== 'chat'}
            />
          </BotsContext.Provider>
        ) : null}
        {view === 'chat' && chat && bot && pane === 'dashboard' && (
          <BotDashboard
            key={bot.id}
            project={bot}
            onAsk={() => {
              setBotPane(undefined)
              void window.api.send(chat.id, 'Make your dashboard.')
            }}
          />
        )}
        {view === 'chat' && chat && bot && pane === 'memory' && (
          <BotMemory key={bot.id} project={bot} />
        )}
        {view === 'chat' && !(chat && project) && (
          <div className="welcome">
            <ChatIcon width={28} height={28} />
            {!project ? (
              <>
                <h2>Open a project to start</h2>
                <p>Chats run OpenCode, Cline or Command Code inside a project folder.</p>
                {REMOTE ? (
                  <p>Open one in Barebone on your Mac.</p>
                ) : (
                  <button className="btn primary" onClick={() => window.api.addProject()}>
                    Open folder
                  </button>
                )}
              </>
            ) : (
              <>
                <h2>Start a chat</h2>
                <button className="btn primary" onClick={() => setPicking(true)}>
                  New chat
                </button>
              </>
            )}
          </div>
        )}
      </main>
      {picking && (
        <ProjectPicker
          // A bot has its one conversation, opened from Bots in the sidebar.
          projects={state.projects.filter((p) => !p.bot)}
          onPick={(projectId) => {
            setPicking(false)
            newChat(projectId)
          }}
          onClose={() => setPicking(false)}
        />
      )}
      {codeOpen && chat && project && (
        <CodePanel
          key={chat.id}
          chatId={chat.id}
          project={project}
          width={browserWidth}
          onResize={setBrowserWidth}
          onClose={() => toggleCode(chat.id, false)}
          chatRef={mainRef}
        />
      )}
      {remoteBrowserOpen && chat && (
        <BrowserSheet
          key={chat.id}
          chatId={chat.id}
          width={browserWidth}
          onResize={setBrowserWidth}
          chatRef={mainRef}
          onClose={() => toggleRemoteBrowser(chat.id, false)}
        />
      )}
      {browserOpen && (
        <BrowserPanel
          width={browserWidth}
          onResize={setBrowserWidth}
          onClose={() => toggleBrowser(chat?.id, false)}
          chatRef={mainRef}
          chatFolded={folded}
          onFoldChat={() => setChatFolded(true)}
          leading={
            // The chat's top bar is folded away with it, and its sidebar button too.
            folded &&
            !sidebarOpen && (
              <button
                className="icon-btn"
                title="Show sidebar (⌘B)"
                onClick={() => setSidebarOpen(true)}
              >
                <SidebarIcon />
              </button>
            )
          }
        />
      )}
    </div>
  )
}

/**
 * When a bot's next routine runs, after its job; nothing when it has none.
 * The clock moves on each minute, so "tomorrow" turns into "today" at midnight.
 */
function NextRoutine({ project }: { project: Project }): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const next = nextRoutine(project, now)
  if (!next) return null
  return (
    <span className="bot-next" title="When its next routine runs">
      Next: {next}
    </span>
  )
}

/**
 * The title in the top bar. When the open chat's title changes (the agent
 * names a new chat), the new one fades in; switching chats swaps it at once.
 */
function TopbarName({ id, text }: { id?: string; text: string }): React.JSX.Element {
  const [last, setLast] = useState({ id, text, changed: false })
  if (last.id !== id || last.text !== text) setLast({ id, text, changed: last.id === id })
  return (
    <span key={`${id}:${text}`} className={`topbar-name${last.changed ? ' changed' : ''}`}>
      {text}
    </span>
  )
}
