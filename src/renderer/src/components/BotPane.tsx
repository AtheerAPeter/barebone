import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { BotChange, Project } from '../../../shared/types'
import { renderMarkdown } from '../lib/markdown'
import { BotAvatar } from './BotAvatar'
import { botColor, BotsContext } from '../lib/bots'

/**
 * A bot's chat (main/bots.ts) has two more panes beside the chat: the
 * dashboard the bot built, and what it knows. The top bar switches between them.
 */
export type BotPaneName = 'chat' | 'dashboard' | 'memory'

const PANES: { name: BotPaneName; label: string }[] = [
  { name: 'chat', label: 'Chat' },
  { name: 'dashboard', label: 'Dashboard' },
  { name: 'memory', label: 'Memory' }
]

/** The switch in the top bar of a bot's chat. */
export function BotTabs({
  pane,
  onPane
}: {
  pane: BotPaneName
  onPane: (pane: BotPaneName) => void
}): React.JSX.Element {
  return (
    <div className="segmented bot-tabs" role="tablist">
      {PANES.map(({ name, label }) => (
        <button
          key={name}
          role="tab"
          aria-selected={pane === name}
          className={pane === name ? 'on' : ''}
          onClick={() => onPane(name)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/**
 * Calls `changed` whenever something in the bot's folder changes, while
 * mounted, with what changed; and once at the start, as if its page had.
 */
function useBotChanges(projectId: string, changed: (change: BotChange) => void): void {
  useEffect(() => {
    changed('page')
    void window.api.bots.watch(projectId)
    const off = window.api.bots.onChanged((id, change) => {
      if (id === projectId) changed(change)
    })
    return () => {
      off()
      void window.api.bots.unwatch(projectId)
    }
    // `changed` reads only state setters, so following the project is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])
}

/**
 * The page the bot made of its records, loaded from its folder, and loaded
 * again whenever something in the folder changes. A page that follows its
 * records itself (barebone.onChange, main/bots.ts) is told of their changes
 * instead, so a form the user is filling in keeps what they typed. Until the
 * bot has made a page, a button asks it to.
 */
export function BotDashboard({
  project,
  onAsk
}: {
  project: Project
  onAsk: () => void
}): React.JSX.Element {
  /** Where the page loads from, with a count that loads it again; null while there is none. */
  const [page, setPage] = useState<{ url: string; version: number } | null>()
  const frame = useRef<HTMLIFrameElement>(null)
  /** Whether the page loaded now said it follows its records itself. */
  const follows = useRef(false)
  useEffect(() => {
    const heard = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return
      if ((event.data as { barebone?: unknown } | null)?.barebone === 'live') follows.current = true
    }
    window.addEventListener('message', heard)
    return () => window.removeEventListener('message', heard)
  }, [])
  useBotChanges(project.id, (change) => {
    if (follows.current && change !== 'page') {
      // The page is an origin of its own (none, through the remote link), and the message names no data.
      if (change === 'records')
        frame.current?.contentWindow?.postMessage({ barebone: 'changed' }, '*')
      return
    }
    follows.current = false
    window.api.bots.dashboard(project.id).then(
      (url) => setPage((last) => (url ? { url, version: (last?.version ?? 0) + 1 } : null)),
      () => setPage(null)
    )
  })
  if (page === undefined) return <div className="bot-pane" />
  if (page === null) {
    return (
      <div className="bot-pane bot-empty">
        <BotAvatar project={project} size={64} />
        <p>{project.name} has not made a dashboard yet.</p>
        <button className="btn primary" onClick={onAsk}>
          Ask {project.name} to make one
        </button>
      </div>
    )
  }
  const separator = page.url.includes('?') ? '&' : '?'
  return (
    <div className="bot-pane">
      <iframe
        ref={frame}
        className="bot-dashboard"
        title={`${project.name}'s dashboard`}
        src={`${page.url}${separator}v=${page.version}`}
        // On the Mac the bot's own origin keeps it apart from the app; through the
        // remote link it gets none (see main/remote/server.ts).
        sandbox={window.api.remote ? 'allow-scripts' : 'allow-scripts allow-same-origin'}
      />
    </div>
  )
}

/** What the bot knows: its memory.md, as it changes. */
export function BotMemory({ project }: { project: Project }): React.JSX.Element {
  const [text, setText] = useState<string | null>()
  useBotChanges(project.id, () => {
    window.api.bots.memory(project.id).then(setText, () => setText(null))
  })
  const html = useMemo(() => (text ? renderMarkdown(text) : ''), [text])
  // Only the heading the bot was made with: nothing learned yet.
  const empty = text === null || text?.trim().split('\n').length === 1
  if (text === undefined) return <div className="bot-pane" />
  return (
    <div className="bot-pane bot-memory">
      {empty ? (
        <div className="bot-empty">
          <BotAvatar project={project} size={64} />
          <p>{project.name} has not learned anything yet. It writes here as it works.</p>
        </div>
      ) : (
        <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}

/** Under the answer of the turn that made a bot: the bot, and a button that opens it. */
export function BotCard({ projectId }: { projectId: string }): React.JSX.Element | null {
  const { projects, openBot } = useContext(BotsContext)
  const project = projects.find((p) => p.id === projectId && p.bot)
  if (!project?.bot) return null
  return (
    <div className="bot-card" style={{ '--bot': botColor(project) } as React.CSSProperties}>
      <BotAvatar project={project} size={64} />
      <div className="bot-card-text">
        <h3>{project.name} is ready</h3>
        <p>{project.bot.job}</p>
        <button className="btn primary" onClick={() => openBot(project.id)}>
          Open {project.name}
        </button>
      </div>
    </div>
  )
}
