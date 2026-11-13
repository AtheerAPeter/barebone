import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { ThemeToggle } from './ThemeToggle'
import { Collapse } from './Collapse'
import { ProjectIcon } from './ProjectIcon'
import { BotAvatar } from './BotAvatar'
import { botStatus } from '../lib/bots'
import { RowMenu } from './RowMenu'
import { useTelegramStatus } from '../lib/telegram'
import { AgentLogo } from './model-picker/AgentLogo'
import {
  startedChats,
  waitingOn,
  type AppState,
  type Chat,
  type Project
} from '../../../shared/types'
import { readPref, writePref } from '../lib/prefs'
import { shortcut } from '../lib/platform'
import { useUpdateInstall } from '../lib/update'
import {
  BookIcon,
  ChevronIcon,
  ComposeIcon,
  FolderIcon,
  FolderPlusIcon,
  SearchIcon,
  PhoneIcon,
  SidebarIcon
} from './icons'

/** Settled chats listed before "Show more", and how many each click adds. */
const SETTLED_PAGE = 20
/** The same for a project's settled chats, when chats are grouped by project. */
const FOLDER_PAGE = 5
/** The sidebar's width until the user drags its edge, and how narrow or wide it may get. */
const SIDEBAR_WIDTH = 260
const SIDEBAR_MIN = 200
const SIDEBAR_MAX = 440

interface SidebarProps {
  /** Hidden, it slides out but stays mounted, keeping its scroll and search. */
  open: boolean
  state: AppState
  selectedChatId?: string
  view: 'chat' | 'skills' | 'settings'
  onSelectChat: (chatId: string) => void
  /** Start a chat: the user picks its project first. */
  onNewChat: () => void
  /** Start a chat in this project, from its folder. */
  onNewChatIn: (projectId: string) => void
  /** Open a bot's one conversation, starting it the first time. */
  onOpenBot: (projectId: string) => void
  onShowSkills: () => void
  onShowSettings: () => void
  onHide: () => void
}

/**
 * Laid out like ChatGPT's: actions on top, then one scrolling list of chats,
 * grouped one of two ways the user switches between. By status, chats that
 * need the user or are working come first; every other chat is settled, in
 * its own section below them, and each chat shows its project's icon, which is
 * how chats of different projects are told apart. By project, each project is
 * a folder that opens to its chats, in the same order.
 */
export function Sidebar({
  open,
  state,
  selectedChatId,
  view,
  onSelectChat,
  onNewChat,
  onNewChatIn,
  onOpenBot,
  onShowSkills,
  onShowSettings,
  onHide
}: SidebarProps): React.JSX.Element {
  const [grouping, setGrouping] = useState(() =>
    readPref<'status' | 'project'>('sidebarGrouping', 'status')
  )
  const byProject = grouping === 'project'
  /** Projects whose folders the user opened. */
  const [openProjects, setOpenProjects] = useState(
    () => new Set(readPref<string[]>('openProjects', []))
  )
  /** How many settled chats each open folder lists, for those past the first page. */
  const [folderShown, setFolderShown] = useState<Map<string, number>>(new Map())
  useEffect(() => writePref('sidebarGrouping', grouping), [grouping])
  useEffect(() => writePref('openProjects', [...openProjects]), [openProjects])
  /** Lead chats whose chats the user opened; every lead starts closed. */
  const [openLeads, setOpenLeads] = useState<Set<string>>(new Set())
  /** The selected chat that was last brought into view. */
  const [revealedChatId, setRevealedChatId] = useState<string>()
  const [settledOpen, setSettledOpen] = useState(() => readPref('settledOpen', true))
  const [settledShown, setSettledShown] = useState(SETTLED_PAGE)
  const navRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(() => readPref('sidebarWidth', SIDEBAR_WIDTH))
  const [resizing, setResizing] = useState(false)
  useLayoutEffect(() => {
    // The window's layout and the sidebar's slide both use this width.
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
  }, [width])
  useEffect(() => writePref('sidebarWidth', width), [width])
  useRowMotion(navRef, resizing)
  /** The chat whose title is being edited in place. */
  const [renaming, setRenaming] = useState<string>()
  /** Once paired, a chat the user started can be linked to the Telegram bot. */
  const telegram = useTelegramStatus()
  /** The search text; undefined while the search field is closed. */
  const [query, setQuery] = useState<string>()
  const [version, setVersion] = useState<string>()
  /** A newer release's version, once the app has found one. */
  const [update, setUpdate] = useState<string | null>(null)
  useEffect(() => {
    window.api.appVersion().then(setVersion)
    // Updating quits and reopens the app: something to do on the Mac.
    if (window.api.remote) return
    window.api.update.available().then(setUpdate)
    return window.api.update.onAvailable(setUpdate)
  }, [])
  useEffect(() => writePref('settledOpen', settledOpen), [settledOpen])
  // The time the rows' ages are counted from, moved on each minute so "5m" does not go stale.
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const projects = new Map(state.projects.map((p) => [p.id, p]))
  // Open the Settled section, the project's folder and the chat that leads a newly selected
  // chat, so a new or picked chat stays in view in either grouping. Done while rendering, once
  // per selection; the user can close them after.
  const selectedChat = state.chats.find((c) => c.id === selectedChatId)
  if (selectedChat && selectedChatId !== revealedChatId) {
    setRevealedChatId(selectedChatId)
    if (!settledOpen && !selectedChat.running) setSettledOpen(true)
    if (!openProjects.has(selectedChat.projectId)) {
      setOpenProjects(new Set(openProjects).add(selectedChat.projectId))
    }
    if (selectedChat.startedBy && !openLeads.has(selectedChat.startedBy)) {
      setOpenLeads(new Set(openLeads).add(selectedChat.startedBy))
    }
  }
  // Then scroll it into view, once the sections opened for it have finished opening: until
  // then they clip the list, so a row near its end could not be reached.
  useEffect(() => {
    const nav = navRef.current
    if (!nav || !revealedChatId) return
    let live = true
    const opening = nav.getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition)
    Promise.all(opening.map((a) => a.finished.catch(() => undefined))).then(() => {
      if (!live) return
      // A waiting chat can also be listed in a closed section; scroll to the row that shows.
      const rows = nav.querySelectorAll<HTMLElement>(`[data-chat="${CSS.escape(revealedChatId)}"]`)
      const shown = [...rows].find((row) => row.offsetHeight > 0)
      shown?.scrollIntoView({ block: 'nearest' })
    })
    return () => {
      live = false
    }
  }, [revealedChatId])
  const q = query?.trim().toLowerCase() ?? ''
  const matches = (chat: Chat): boolean =>
    !q ||
    chat.title.toLowerCase().includes(q) ||
    Boolean(projects.get(chat.projectId)?.name.toLowerCase().includes(q))
  const chats = state.chats.filter(matches).sort((a, b) => b.updatedAt - a.updatedAt)
  // A chat that started chats leads them: they are listed under it, wherever it is listed.
  // While searching, every match is listed on its own.
  const started = startedChats(state.chats)
  const nested = (chat: Chat): boolean =>
    !q && chat.startedBy != null && !!started.get(chat.startedBy)
  // A lead is working while any chat it started is, even between its own turns, so it does not
  // jump between the lists each time a report starts and ends one of its turns. So is a chat with
  // commands or a timer in the background: each wakes it, so it is not done.
  const startedWorking = (chat: Chat): number =>
    started.get(chat.id)?.filter((c) => c.running).length ?? 0
  const working = (chat: Chat): boolean =>
    chat.running || Boolean(chat.background) || startedWorking(chat) > 0
  // Chats that need the user come first, then those still working. A waiting chat is also
  // running. Both lists show a chat even when it is also under the chat that leads it; but a
  // working chat whose lead is working too is shown under the lead only.
  const byId = new Map(state.chats.map((c) => [c.id, c]))
  const leadWorking = (chat: Chat): boolean => {
    const lead = nested(chat) ? byId.get(chat.startedBy!) : undefined
    return Boolean(lead && working(lead) && !lead.waiting)
  }
  // A bot is one row in Bots, for its one conversation; when it needs the user, it is also listed first.
  const bots = state.projects.filter((p) => p.bot)
  const ofBot = (chat: Chat): boolean => Boolean(projects.get(chat.projectId)?.bot)
  // Pinned chats are listed together under the chats that need the user, working or not.
  const waiting = chats.filter((c) => c.waiting)
  const pinned = chats.filter((c) => c.pinned && !c.waiting && !ofBot(c))
  const running = chats.filter(
    (c) => !c.pinned && working(c) && !c.waiting && !leadWorking(c) && !ofBot(c)
  )
  const settled = chats.filter(
    (c) => !c.pinned && !working(c) && !c.waiting && !nested(c) && !ofBot(c)
  )
  // While searching, settled matches are always listed.
  const settledShut = !settledOpen && !q
  /** Whether the open chat is this one or one it leads, to keep it in view past "Show more". */
  const holdsSelected = (chat: Chat): boolean =>
    chat.id === selectedChatId ||
    Boolean(started.get(chat.id)?.some((c) => c.id === selectedChatId))

  function toggleLead(chatId: string): void {
    setOpenLeads((current) => toggled(current, chatId))
  }

  function toggleProject(projectId: string): void {
    setOpenProjects((current) => toggled(current, projectId))
  }

  /** One chat: by status, a card that names its project; in a project's folder, one line. */
  function chatRow(chat: Chat): React.JSX.Element {
    const project = projects.get(chat.projectId)
    const led = q ? undefined : started.get(chat.id)
    const workingLed = led?.filter((c) => c.running).length ?? 0
    const isOpen = openLeads.has(chat.id)
    const waits = !chat.running ? waitingOn(chat, startedWorking(chat)) : undefined
    const latest = chat.waiting ? 'Waiting for approval' : waits || chat.preview
    // By status, each chat is a card: its project and status, its title, then its latest and agent.
    // Pinned chats are one line, led by their project's icon, so the Pinned list stays short.
    const compact = !byProject && chat.pinned && !chat.waiting
    const card = !byProject && !compact
    const row = (
      <div
        key={chat.id}
        data-chat={chat.id}
        className={`chat-row${card ? ' card' : ''}${led ? ' lead' : ''}${view === 'chat' && chat.id === selectedChatId ? ' selected' : ''}`}
        title={[project?.name, latest].filter(Boolean).join(' · ')}
        onClick={() => onSelectChat(chat.id)}
      >
        {card ? (
          <div className="card-head">
            {project && <ProjectIcon project={project} size={22} />}
            <span className="card-project">{project?.name}</span>
            <CardStatus chat={chat} working={working(chat)} now={now} />
          </div>
        ) : compact && project ? (
          <ProjectIcon project={project} size={20} />
        ) : (
          <span />
        )}
        <div className="chat-line">
          {renaming === chat.id ? (
            <RenameField
              title={chat.title}
              onDone={(title) => {
                setRenaming(undefined)
                if (title !== undefined && title.trim() && title !== chat.title) {
                  window.api.renameChat(chat.id, title)
                }
              }}
            />
          ) : (
            <span className="chat-title" onDoubleClick={() => setRenaming(chat.id)}>
              {chat.title}
            </span>
          )}
          {telegram?.state === 'ready' && telegram.linkedChatId === chat.id && (
            <span className="chat-remote" title="Controlled from Telegram">
              <PhoneIcon width={14} height={14} aria-label="Controlled from Telegram" />
            </span>
          )}
          {led && (
            <button
              className={`lead-toggle${isOpen ? ' open' : ''}`}
              title={`Started ${led.length} ${led.length === 1 ? 'chat' : 'chats'}, ${workingLed} working. ${isOpen ? 'Hide' : 'Show'} them.`}
              aria-expanded={isOpen}
              onClick={(e) => {
                e.stopPropagation()
                toggleLead(chat.id)
              }}
            >
              <span className={`lead-count${workingLed > 0 ? ' active' : ''}`}>
                {workingLed}/{led.length}
              </span>
              <ChevronIcon width={10} height={10} className="chevron" />
            </button>
          )}
          {!card && <ChatStatus chat={chat} working={working(chat)} />}
          <RowMenu
            label="Chat options"
            items={[
              // Pinned chats have their own list by status; grouped by project there is none.
              ...(!byProject
                ? [
                    {
                      name: chat.pinned ? 'Unpin' : 'Pin',
                      onSelect: () => window.api.pinChat(chat.id, !chat.pinned)
                    }
                  ]
                : []),
              { name: 'Rename', onSelect: () => setRenaming(chat.id) },
              ...(telegram?.state === 'ready' && !chat.startedBy
                ? [
                    telegram.linkedChatId === chat.id
                      ? {
                          name: 'Stop Telegram control',
                          onSelect: () => void window.api.telegram.link(null)
                        }
                      : {
                          name: 'Control from Telegram',
                          onSelect: () => void window.api.telegram.link(chat.id)
                        }
                  ]
                : []),
              {
                name: 'Delete',
                danger: true,
                onSelect: () => window.api.deleteChat(chat.id)
              }
            ]}
          />
        </div>
        {card && (
          <div className="card-foot">
            <span className="card-latest">{waits ?? chat.preview}</span>
            <AgentLogo agent={chat.agent} size={18} />
          </div>
        )}
      </div>
    )
    if (!led) return row
    return (
      <Fragment key={chat.id}>
        {row}
        <Collapse open={isOpen} className="chat-children">
          {led.map(chatRow)}
        </Collapse>
      </Fragment>
    )
  }

  /** Dragging the sidebar's right edge resizes it. */
  function dragWidth(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    const edge = event.currentTarget
    const startX = event.clientX
    const startWidth = width
    const onMove = (e: PointerEvent): void => {
      const next = startWidth + e.clientX - startX
      setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(next))))
    }
    const onUp = (): void => {
      edge.removeEventListener('pointermove', onMove)
      edge.removeEventListener('pointerup', onUp)
      edge.removeEventListener('pointercancel', onUp)
      setResizing(false)
    }
    setResizing(true)
    edge.setPointerCapture(event.pointerId)
    edge.addEventListener('pointermove', onMove)
    edge.addEventListener('pointerup', onUp)
    edge.addEventListener('pointercancel', onUp)
  }

  /** Settled chats up to `shown`, then "Show more", which asks for the next page past `limit`. */
  function pagedRows(
    list: Chat[],
    shown: number,
    onMore: (limit: number) => void
  ): React.JSX.Element {
    const limit = q ? list.length : shown
    const visible = list.slice(0, limit)
    const selected = list.find(holdsSelected)
    if (selected && !visible.includes(selected)) visible.push(selected)
    return (
      <>
        {visible.map(chatRow)}
        {list.length > limit && (
          <div className="chat-more">
            <button onClick={() => onMore(limit)}>Show more ({list.length - limit})</button>
          </div>
        )}
      </>
    )
  }

  /** The chats grouped by status: Needs you, Pinned, Working, then Settled. */
  function statusLists(): React.JSX.Element {
    return (
      <>
        {waiting.length > 0 && (
          <>
            <div className="side-label waiting">
              Needs you <b>{waiting.length}</b>
            </div>
            {waiting.map(chatRow)}
          </>
        )}
        {pinned.length > 0 && (
          <>
            <div className="side-label">
              Pinned <b>{pinned.length}</b>
            </div>
            {pinned.map(chatRow)}
          </>
        )}
        {running.length > 0 && (
          <>
            <div className="side-label">
              Working <b>{running.length}</b>
            </div>
            {running.map(chatRow)}
          </>
        )}
        {settled.length > 0 && (
          <>
            <button
              className={`side-label side-toggle${settledShut ? '' : ' open'}`}
              aria-expanded={!settledShut}
              onClick={() => setSettledOpen((o) => !o)}
            >
              Settled <b>{settled.length}</b>
              <ChevronIcon width={10} height={10} className="chevron" />
            </button>
            <Collapse open={!settledShut}>
              {pagedRows(settled, settledShown, (limit) => setSettledShown(limit + SETTLED_PAGE))}
            </Collapse>
          </>
        )}
      </>
    )
  }

  /**
   * A project's folder: its chats in the order of the status lists, waiting, then working, then
   * settled. A chat another chat started is under it, as in those lists, and one that waits is
   * also listed first. While searching, only folders with matches are listed, all of them open.
   */
  function projectFolder(project: Project): React.JSX.Element | null {
    const own = chats.filter((c) => c.projectId === project.id)
    if (q && own.length === 0) return null
    const listed = own.filter((c) => c.waiting || !nested(c))
    const active = [
      ...listed.filter((c) => c.waiting),
      ...listed.filter((c) => working(c) && !c.waiting)
    ]
    const rest = listed.filter((c) => !working(c) && !c.waiting)
    const isOpen = Boolean(q) || openProjects.has(project.id)
    return (
      <Fragment key={project.id}>
        <div
          className={`chat-row project-row${isOpen ? ' open' : ''}`}
          title={project.path}
          aria-expanded={isOpen}
          onClick={() => toggleProject(project.id)}
        >
          <ProjectIcon project={project} size={24} />
          <div className="chat-line">
            <span className="chat-title">{project.name}</span>
            {/* Open, its chats show their own. */}
            {!isOpen && <FolderStatus chats={own} working={working} />}
            <button
              className="icon-btn small project-new"
              title={`New chat in ${project.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onNewChatIn(project.id)
              }}
            >
              <ComposeIcon width={14} height={14} />
            </button>
            <ChevronIcon width={10} height={10} className="chevron" />
          </div>
        </div>
        <Collapse open={isOpen}>
          {active.map(chatRow)}
          {pagedRows(rest, folderShown.get(project.id) ?? FOLDER_PAGE, (limit) =>
            setFolderShown((current) => new Map(current).set(project.id, limit + FOLDER_PAGE))
          )}
          {own.length === 0 && <div className="project-empty">No chats</div>}
        </Collapse>
      </Fragment>
    )
  }

  /**
   * A bot: one row, as a contact in a messenger, for its one conversation:
   * its character, its name and the last thing said, and what its chats are doing.
   * The chats it started, in any project, are under it, as under a lead chat.
   */
  function botRow(project: Project): React.JSX.Element | null {
    const own = state.chats.filter((c) => c.projectId === project.id)
    if (q && !project.name.toLowerCase().includes(q)) return null
    const conversation = own.find((c) => !c.startedBy)
    // The bot speaks for whichever of its chats needs the user or works, else its conversation.
    const live = own.find((c) => c.waiting) ?? own.find((c) => c.running) ?? conversation
    const selected = view === 'chat' && conversation?.id === selectedChatId
    const led = conversation && !q ? started.get(conversation.id) : undefined
    const workingLed = led?.filter((c) => c.running).length ?? 0
    const isOpen = Boolean(conversation && openLeads.has(conversation.id))
    const row = (
      <div
        key={project.id}
        className={`chat-row bot-row${led ? ' lead' : ''}${selected ? ' selected' : ''}`}
        title={`${project.name}: ${project.bot?.job}`}
        onClick={() => onOpenBot(project.id)}
      >
        <BotAvatar project={project} size={30} chat={live} />
        <div className="bot-row-text">
          <div className="chat-line">
            <span className="chat-title">{project.name}</span>
            {led && conversation && (
              <button
                className={`lead-toggle${isOpen ? ' open' : ''}`}
                title={`Started ${led.length} ${led.length === 1 ? 'chat' : 'chats'}, ${workingLed} working. ${isOpen ? 'Hide' : 'Show'} them.`}
                aria-expanded={isOpen}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleLead(conversation.id)
                }}
              >
                <span className={`lead-count${workingLed > 0 ? ' active' : ''}`}>
                  {workingLed}/{led.length}
                </span>
                <ChevronIcon width={10} height={10} className="chevron" />
              </button>
            )}
            <FolderStatus chats={own} working={working} />
            {/* The file is saved on the Mac, so not through the remote link. */}
            {!window.api.remote && (
              <RowMenu
                label="Bot options"
                items={[
                  {
                    name: 'Export…',
                    onSelect: () => void window.api.bots.exportToFile(project.id)
                  },
                  {
                    name: 'Delete…',
                    danger: true,
                    onSelect: () => void window.api.bots.remove(project.id)
                  }
                ]}
              />
            )}
          </div>
          <span className="bot-row-latest">
            {botStatus(live) ?? conversation?.preview ?? project.bot?.job}
          </span>
        </div>
      </div>
    )
    if (!led) return row
    return (
      <Fragment key={project.id}>
        {row}
        <Collapse open={isOpen} className="chat-children">
          {led.map(chatRow)}
        </Collapse>
      </Fragment>
    )
  }

  return (
    <nav
      className={`sidebar${open ? '' : ' closed'}${resizing ? ' resizing' : ''}`}
      inert={!open}
      ref={navRef}
    >
      <div
        className="sidebar-edge"
        title="Drag to resize, double-click to reset"
        onPointerDown={dragWidth}
        onDoubleClick={() => setWidth(SIDEBAR_WIDTH)}
      />
      {/* The window buttons sit at its left; it drags the window. */}
      <div className="sidebar-top">
        <button
          className={`icon-btn${byProject ? ' on' : ''}`}
          title={byProject ? 'Group chats by status' : 'Group chats by project'}
          aria-pressed={byProject}
          onClick={() => setGrouping(byProject ? 'status' : 'project')}
        >
          <FolderIcon />
        </button>
        <button className="icon-btn" title={`Hide sidebar (${shortcut('B')})`} onClick={onHide}>
          <SidebarIcon />
        </button>
      </div>
      <div className="side-nav">
        <button className="nav-row" title={`New chat (${shortcut('N')})`} onClick={onNewChat}>
          <ComposeIcon />
          New chat
        </button>
        <button
          className={`nav-row${query !== undefined ? ' on' : ''}`}
          onClick={() => setQuery((current) => (current === undefined ? '' : undefined))}
        >
          <SearchIcon />
          Search chats
        </button>
        <button className={`nav-row${view === 'skills' ? ' on' : ''}`} onClick={onShowSkills}>
          <BookIcon />
          Skills
        </button>
        {/* A project is a folder chosen with the Mac's folder picker. */}
        {!window.api.remote && (
          <button
            className="nav-row"
            title={`Open project folder (${shortcut('O')})`}
            onClick={() => window.api.addProject()}
          >
            <FolderPlusIcon />
            Open project
          </button>
        )}
      </div>
      {query !== undefined && (
        <label className="sidebar-search">
          <SearchIcon width={14} height={14} />
          <input
            autoFocus
            placeholder="Search chats"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              // Handled: closing the search must not also stop the agent.
              e.preventDefault()
              setQuery(undefined)
            }}
          />
        </label>
      )}
      <div className="sidebar-scroll">
        {bots.length > 0 && (
          <>
            <div className="side-label">Bots</div>
            {bots.map(botRow)}
          </>
        )}
        {byProject ? (
          <>
            <div className="side-label">Projects</div>
            {state.projects.filter((p) => !p.bot).map(projectFolder)}
          </>
        ) : (
          statusLists()
        )}
        {q && chats.length === 0 && <div className="side-empty">No matching chats</div>}
      </div>
      <div className="sidebar-footer">
        {update && <UpdateButton version={update} />}
        <div className="profile-row">
          <button
            className={`profile${view === 'settings' ? ' on' : ''}`}
            title={`Settings (${shortcut(',')})`}
            onClick={onShowSettings}
          >
            <span className="avatar">B</span>
            <span className="profile-text">
              <span className="profile-name">Barebone</span>
              {version && <span className="profile-sub">v{version}</span>}
            </span>
          </button>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  )
}

/** Above the footer once a newer release is out. Installing it quits and reopens the app. */
function UpdateButton({ version }: { version: string }): React.JSX.Element {
  const { installing, error, install } = useUpdateInstall()

  return (
    <button
      className="app-update"
      disabled={installing}
      title={error ?? `Quit, install v${version} and open it again`}
      onClick={install}
    >
      <span className={`dot${error ? ' failed' : ''}`} />
      {installing ? 'Updating…' : error ? 'Update failed · Retry' : `Update to v${version}`}
    </button>
  )
}

/**
 * Chats that change place slide there from where they were, and chats that
 * appear fade in. Places are kept after every render and on every scroll or
 * resize, so only a change in the lists reads as a move; nothing moves while
 * the user drags (paused).
 */
function useRowMotion(root: RefObject<HTMLElement | null>, paused: boolean): void {
  const places = useRef<Map<string, number>>(undefined)

  /** Each row's place without the slide it may be in the middle of, and that slide's offset. */
  function measure(): Map<string, { el: HTMLElement; top: number; offset: number }> {
    const rows = new Map<string, { el: HTMLElement; top: number; offset: number }>()
    for (const el of root.current?.querySelectorAll<HTMLElement>('[data-chat]') ?? []) {
      const rect = el.getBoundingClientRect()
      // Rows in a closed section have no place.
      if (rect.height === 0 || rows.has(el.dataset.chat!)) continue
      const offset = new DOMMatrixReadOnly(getComputedStyle(el).transform).m42
      rows.set(el.dataset.chat!, { el, top: rect.top - offset, offset })
    }
    return rows
  }

  useLayoutEffect(() => {
    const before = places.current
    const rows = measure()
    places.current = new Map([...rows].map(([id, row]) => [id, row.top]))
    if (!before || paused || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const [id, { el, top, offset }] of rows) {
      const from = before.get(id)
      if (from === undefined) {
        el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1 }], ROW_IN)
      } else if (Math.abs(from + offset - top) > 1) {
        el.getAnimations().forEach((a) => a.cancel())
        el.animate(
          [{ transform: `translateY(${from + offset - top}px)` }, { transform: 'none' }],
          ROW_MOVE
        )
      }
    }
  })

  useEffect(() => {
    const keep = (): void => {
      places.current = new Map([...measure()].map(([id, row]) => [id, row.top]))
    }
    const el = root.current
    el?.addEventListener('scroll', keep, true)
    window.addEventListener('resize', keep)
    return () => {
      el?.removeEventListener('scroll', keep, true)
      window.removeEventListener('resize', keep)
    }
  })
}

/** The motion curve and durations of styles.css (--ease, --move). */
const ROW_IN: KeyframeAnimationOptions = { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
const ROW_MOVE: KeyframeAnimationOptions = {
  duration: 320,
  easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
}

/** Inline title editor. Enter or leaving the field saves; Escape cancels (undefined). */
function RenameField({
  title,
  onDone
}: {
  title: string
  onDone: (title: string | undefined) => void
}): React.JSX.Element {
  const [value, setValue] = useState(title)
  const done = useRef(false)
  const finish = (result: string | undefined): void => {
    if (done.current) return
    done.current = true
    onDone(result)
  }
  return (
    <input
      className="rename-field"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(value)
        else if (e.key === 'Escape') {
          // Handled: cancelling the rename must not also stop the agent.
          e.preventDefault()
          finish(undefined)
        }
      }}
    />
  )
}

/**
 * Waiting for the user, working on a turn, or waiting between turns on what
 * will wake it (commands, a timer, the chats it started). A settled chat shows
 * only its title, as in ChatGPT.
 */
function ChatStatus({ chat, working }: { chat: Chat; working: boolean }): React.JSX.Element | null {
  if (chat.waiting) return <span className="chat-status chat-dot waiting" />
  if (chat.running) return <span className="chat-status chat-dot running" />
  if (working) return <span className="chat-status chat-dot background" />
  return null
}

/** A card's status, top right: what the chat is doing, or how long ago it last moved. */
function CardStatus({
  chat,
  working,
  now
}: {
  chat: Chat
  working: boolean
  now: number
}): React.JSX.Element {
  if (chat.waiting) {
    return (
      <span className="card-status waiting">
        <span className="chat-dot waiting" />
        Needs approval
      </span>
    )
  }
  if (chat.running || working) {
    return (
      <span className={`card-status${chat.running ? ' running' : ''}`}>
        <span className={`chat-dot ${chat.running ? 'running' : 'background'}`} />
        {chat.running ? 'Working' : 'Waiting'}
      </span>
    )
  }
  return <span className="card-status">{age(chat.updatedAt, now)}</span>
}

/** A closed folder's status: the most urgent of its chats', so a closed folder hides none. */
function FolderStatus({
  chats,
  working
}: {
  chats: Chat[]
  working: (chat: Chat) => boolean
}): React.JSX.Element | null {
  const busiest =
    chats.find((c) => c.waiting) ?? chats.find((c) => c.running) ?? chats.find(working)
  return busiest ? <ChatStatus chat={busiest} working /> : null
}

/** How long ago `time` was, short: "now", "5m", "3h", "2d", then the date. */
function age(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The set with `id` added, or taken out when it is in it. */
function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
