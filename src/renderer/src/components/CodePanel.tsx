import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  CodeDoc,
  GitBranch,
  GitChange,
  GitStatus,
  Project,
  WalkAt,
  Walkthrough
} from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { useOverlay } from '../lib/overlays'
import { CHAT_MIN_WIDTH, dragDivider } from '../lib/side-panel'
import { CodeView } from './CodeView'
import { WalkthroughView } from './Walkthrough'
import {
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  DiscardIcon,
  MinusIcon,
  PlusIcon,
  ReloadIcon,
  SyncIcon
} from './icons'

interface CodePanelProps {
  chatId: string
  project: Project
  width: number
  onResize: (width: number) => void
  onClose: () => void
  /** The chat pane left of the panel, whose width the divider sets. */
  chatRef: React.RefObject<HTMLElement | null>
}

/** A file's changes the user opened from the list. */
interface Opened {
  change: GitChange
  staged: boolean
  doc: CodeDoc
}

type Tab = 'changes' | 'diff' | 'walk'

/** How wide the panel opens for a walkthrough, room allowing: its cards and the links beside them. */
const WALK_WIDTH = 760

/**
 * The code panel, in the browser panel's place: source control as in VS Code
 * (the changes, their diffs, staging, committing, branches and sync), and the
 * walkthroughs the chat's agent plays here (main/walkthrough.ts).
 */
export function CodePanel({
  chatId,
  project,
  width,
  onResize,
  onClose,
  chatRef
}: CodePanelProps): React.JSX.Element {
  const [status, setStatus] = useState<GitStatus>()
  const [opened, setOpened] = useState<Opened>()
  const [walking, setWalking] = useState<{ walk: Walkthrough; at: WalkAt; from?: number }>()
  const [tab, setTab] = useState<Tab>('changes')
  /** What git is doing for a button, which waits meanwhile. */
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const projectId = project.id

  // A walkthrough needs room for its cards and the links beside them: the panel widens for one.
  const widthRef = useRef(width)
  useEffect(() => {
    widthRef.current = width
  }, [width])
  const widen = useCallback(() => {
    const chatLeft = chatRef.current?.getBoundingClientRect().left ?? 0
    const room = window.innerWidth - chatLeft - CHAT_MIN_WIDTH
    onResize(Math.max(widthRef.current, Math.min(WALK_WIDTH, room)))
  }, [chatRef, onResize])

  // This chat's walkthrough: the one it has, a new one its agent starts, and where it is as it plays.
  useEffect(() => {
    let current = true
    window.api.walk.get(chatId).then((got) => {
      if (!current || !got) return
      setWalking(got)
      if (got.at.playing) {
        setTab('walk')
        widen()
      }
    })
    const offStart = window.api.walk.onStart((id, walk) => {
      if (id !== chatId) return
      setWalking({ walk, at: { index: 0, playing: true } })
      setTab('walk')
      widen()
    })
    const offAt = window.api.walk.onAt((id, at) => {
      if (id === chatId) setWalking((w) => w && { ...w, at, from: w.at.index })
    })
    return () => {
      current = false
      offStart()
      offAt()
    }
  }, [chatId, widen])

  // It plays only while it shows: leaving its tab, the chat or the panel pauses it.
  const playing = walking?.at.playing === true
  useEffect(() => {
    if (tab !== 'walk' && playing) void window.api.walk.control(chatId, 'pause')
  }, [tab, playing, chatId])
  const playingRef = useRef(playing)
  useEffect(() => {
    playingRef.current = playing
  }, [playing])
  useEffect(
    () => () => {
      if (playingRef.current) void window.api.walk.control(chatId, 'pause')
    },
    [chatId]
  )

  const openedRef = useRef(opened)
  useEffect(() => {
    openedRef.current = opened
  }, [opened])

  /** Read the status again, and the opened diff with it; one gone from the list closes. */
  const refresh = useCallback(
    (): Promise<void> =>
      readStatus(projectId, openedRef.current).then(
        (read) => {
          setStatus(read.status)
          setOpened(read.opened)
          if (!read.opened) setTab((t) => (t === 'diff' ? 'changes' : t))
        },
        (e: unknown) => setError(errorMessage(e))
      ),
    [projectId]
  )

  // The list follows the disk: changes from the agent, an editor or the terminal.
  // The panel is made anew for each chat (App.tsx), so a project's diff never shows in another's.
  useEffect(() => {
    void refresh()
    void window.api.git.watch(projectId)
    const off = window.api.git.onChanged((id) => {
      if (id === projectId) void refresh()
    })
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
      void window.api.git.unwatch(projectId)
    }
  }, [projectId, refresh])

  /** Run a git action for a button: one at a time, its failure shown, the list read again after. */
  const run = useCallback(
    async (what: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy(what)
      setError(undefined)
      try {
        await action()
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setBusy(undefined)
        await refresh()
      }
    },
    [refresh]
  )

  async function open(change: GitChange, staged: boolean): Promise<void> {
    try {
      const doc = await window.api.git.diff(projectId, change, staged)
      setOpened({ change, staged, doc })
      setTab('diff')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const repo = status?.repo ? status : undefined

  return (
    <aside className="side-panel code-panel" style={{ width }}>
      <div
        className="panel-resize"
        onPointerDown={(event) => dragDivider(event, chatRef.current, onResize)}
      />
      <div className="panel-tabs" role="tablist">
        <PanelTab
          active={tab === 'changes'}
          onSelect={() => setTab('changes')}
          icon={<BranchIcon width={13} height={13} />}
          title="Source control"
        >
          Changes
          {repo && count(repo) > 0 && <span className="code-count">{count(repo)}</span>}
        </PanelTab>
        {opened && (
          <PanelTab
            active={tab === 'diff'}
            onSelect={() => setTab('diff')}
            title={`${opened.change.path} (${opened.staged ? 'staged' : 'working tree'})`}
            onClose={() => {
              setOpened(undefined)
              setTab('changes')
            }}
          >
            {baseName(opened.change.path)}
            <span className="code-tab-note">{opened.staged ? 'staged' : 'changes'}</span>
          </PanelTab>
        )}
        {walking && (
          <PanelTab
            active={tab === 'walk'}
            onSelect={() => setTab('walk')}
            title={`Walkthrough: ${walking.walk.title}`}
          >
            {walking.walk.title}
          </PanelTab>
        )}
        <span className="spacer" />
        <button className="icon-btn small" title="Close" onClick={onClose}>
          <CloseIcon width={14} height={14} />
        </button>
      </div>

      {tab === 'changes' && (
        <>
          <div className="panel-toolbar code-toolbar">
            {repo && (
              <BranchMenu
                projectId={projectId}
                label={repo.branch ?? (repo.head ? `${repo.head} (detached)` : 'No commits yet')}
                disabled={Boolean(busy)}
                run={run}
              />
            )}
            <span className="spacer" />
            {repo?.upstream && (repo.ahead > 0 || repo.behind > 0) && (
              <span
                className="code-sync-count"
                title={`${repo.behind} to pull, ${repo.ahead} to push`}
              >
                {repo.behind}↓ {repo.ahead}↑
              </span>
            )}
            {repo?.branch && (
              <button
                className="icon-btn"
                title={
                  repo.upstream
                    ? `Sync with ${repo.upstream}: pull, then push`
                    : 'Publish the branch'
                }
                disabled={Boolean(busy)}
                onClick={() => run('sync', () => window.api.git.sync(projectId))}
              >
                <SyncIcon className={busy === 'sync' ? 'spin' : undefined} />
              </button>
            )}
            <button
              className="icon-btn"
              title="Refresh"
              disabled={Boolean(busy)}
              onClick={() => void refresh()}
            >
              <ReloadIcon />
            </button>
          </div>
          {error && (
            <div className="code-error" role="alert">
              {error}
              <button
                className="icon-btn small"
                title="Dismiss"
                onClick={() => setError(undefined)}
              >
                <CloseIcon width={12} height={12} />
              </button>
            </div>
          )}
          {!status ? null : !repo ? (
            <div className="code-empty">{project.name} is not in a git repository.</div>
          ) : (
            <SourceControl
              projectId={projectId}
              repo={repo}
              busy={busy}
              run={run}
              opened={opened}
              onOpen={open}
            />
          )}
        </>
      )}

      {tab === 'diff' && opened && (
        <CodeView key={`${opened.change.path}:${opened.staged}`} doc={opened.doc} />
      )}

      {tab === 'walk' && walking && (
        <WalkthroughView
          key={walking.walk.id}
          walk={walking.walk}
          at={walking.at}
          from={walking.from}
          onControl={(action, index) => void window.api.walk.control(chatId, action, index)}
        />
      )}
    </aside>
  )
}

function PanelTab({
  active,
  onSelect,
  onClose,
  icon,
  title,
  children
}: {
  active: boolean
  onSelect: () => void
  onClose?: () => void
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`panel-tab${active ? ' active' : ''}`}
      title={title}
      onClick={onSelect}
    >
      {icon && <span className="panel-tab-icon">{icon}</span>}
      <span className="panel-tab-title">{children}</span>
      {onClose && (
        <button
          className="panel-tab-close"
          title="Close"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <CloseIcon width={10} height={10} />
        </button>
      )}
    </div>
  )
}

/** A project's status, and the opened diff read again; no diff when its file left that list. */
async function readStatus(
  projectId: string,
  open: Opened | undefined
): Promise<{ status: GitStatus; opened?: Opened }> {
  const status = await window.api.git.status(projectId)
  if (!open || !status.repo) return { status }
  const list = open.staged ? status.staged : [...status.conflicts, ...status.unstaged]
  const change = list.find((c) => c.path === open.change.path)
  if (!change) return { status }
  const doc = await window.api.git.diff(projectId, change, open.staged)
  return { status, opened: { change, staged: open.staged, doc } }
}

type Repo = Extract<GitStatus, { repo: true }>
type Run = (what: string, action: () => Promise<unknown>) => Promise<void>

function count(repo: Repo): number {
  return repo.conflicts.length + repo.staged.length + repo.unstaged.length
}

/** VS Code's Source Control: the commit box, then the changes in their groups. */
function SourceControl({
  projectId,
  repo,
  busy,
  run,
  opened,
  onOpen
}: {
  projectId: string
  repo: Repo
  busy?: string
  run: Run
  opened?: Opened
  onOpen: (change: GitChange, staged: boolean) => void
}): React.JSX.Element {
  const [message, setMessage] = useState('')
  const changed = count(repo) > 0

  const commit = (): void => {
    if (!message.trim() || busy) return
    void run('commit', async () => {
      if (await window.api.git.commit(projectId, message)) setMessage('')
    })
  }

  // With nothing to commit, the button syncs or publishes, as VS Code's does.
  const action = changed
    ? {
        label: busy === 'commit' ? 'Committing…' : 'Commit',
        icon: <CheckIcon width={14} height={14} />,
        disabled: !message.trim() || Boolean(busy),
        onClick: commit
      }
    : repo.branch && !repo.upstream
      ? {
          label: busy === 'sync' ? 'Publishing…' : 'Publish Branch',
          icon: <SyncIcon width={14} height={14} />,
          disabled: Boolean(busy),
          onClick: () => void run('sync', () => window.api.git.sync(projectId))
        }
      : repo.upstream && (repo.ahead > 0 || repo.behind > 0)
        ? {
            label: busy === 'sync' ? 'Syncing…' : `Sync Changes ${repo.behind}↓ ${repo.ahead}↑`,
            icon: <SyncIcon width={14} height={14} />,
            disabled: Boolean(busy),
            onClick: () => void run('sync', () => window.api.git.sync(projectId))
          }
        : undefined

  const isOpen = (change: GitChange, staged: boolean): boolean =>
    opened?.staged === staged && opened.change.path === change.path

  return (
    <div className="code-scm">
      <div className="code-commit">
        <textarea
          rows={Math.min(Math.max(message.split('\n').length, 1), 8)}
          placeholder={`Message (⌘Enter to commit${repo.branch ? ` on "${repo.branch}"` : ''})`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              commit()
            }
          }}
        />
        {action && (
          <button
            className="btn primary code-commit-button"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.icon}
            {action.label}
          </button>
        )}
      </div>
      {repo.conflicts.length > 0 && (
        <ChangeGroup
          title="Merge Changes"
          changes={repo.conflicts}
          busy={busy}
          isOpen={(c) => isOpen(c, false)}
          onOpen={(c) => onOpen(c, false)}
          actions={(changes) => [
            {
              title:
                changes.length > 1
                  ? 'Stage all (marks them resolved)'
                  : 'Stage (marks it resolved)',
              icon: <PlusIcon width={14} height={14} />,
              onClick: () => run('stage', () => window.api.git.stage(projectId, changes))
            }
          ]}
        />
      )}
      {repo.staged.length > 0 && (
        <ChangeGroup
          title="Staged Changes"
          changes={repo.staged}
          busy={busy}
          isOpen={(c) => isOpen(c, true)}
          onOpen={(c) => onOpen(c, true)}
          actions={(changes) => [
            {
              title: changes.length > 1 ? 'Unstage all' : 'Unstage',
              icon: <MinusIcon width={14} height={14} />,
              onClick: () => run('unstage', () => window.api.git.unstage(projectId, changes))
            }
          ]}
        />
      )}
      {repo.unstaged.length > 0 && (
        <ChangeGroup
          title="Changes"
          changes={repo.unstaged}
          busy={busy}
          isOpen={(c) => isOpen(c, false)}
          onOpen={(c) => onOpen(c, false)}
          actions={(changes) => [
            // Discarding asks first, in a dialog on the Mac.
            ...(window.api.remote
              ? []
              : [
                  {
                    title: changes.length > 1 ? 'Discard all changes' : 'Discard changes',
                    icon: <DiscardIcon width={14} height={14} />,
                    onClick: () => run('discard', () => window.api.git.discard(projectId, changes))
                  }
                ]),
            {
              title: changes.length > 1 ? 'Stage all' : 'Stage',
              icon: <PlusIcon width={14} height={14} />,
              onClick: () => run('stage', () => window.api.git.stage(projectId, changes))
            }
          ]}
        />
      )}
      {!changed && <p className="code-clean">No changes to commit.</p>}
    </div>
  )
}

interface RowAction {
  title: string
  icon: React.ReactNode
  onClick: () => void
}

/** A group of changes, folding open and shut, with its actions for all of them and for each. */
function ChangeGroup({
  title,
  changes,
  busy,
  isOpen,
  onOpen,
  actions
}: {
  title: string
  changes: GitChange[]
  busy?: string
  isOpen: (change: GitChange) => boolean
  onOpen: (change: GitChange) => void
  actions: (changes: GitChange[]) => RowAction[]
}): React.JSX.Element {
  const [folded, setFolded] = useState(false)
  return (
    <section className="code-group">
      <div className="code-group-head" onClick={() => setFolded((f) => !f)}>
        <ChevronIcon width={12} height={12} className={`code-chevron${folded ? '' : ' open'}`} />
        <span className="code-group-title">{title}</span>
        <Actions actions={actions(changes)} busy={busy} />
        <span className="code-count">{changes.length}</span>
      </div>
      {!folded &&
        changes.map((change) => (
          <div
            key={`${change.oldPath ?? ''}:${change.path}`}
            className={`code-file${isOpen(change) ? ' open' : ''}`}
            title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
            onClick={() => onOpen(change)}
          >
            <span className={`code-file-name${change.kind === 'deleted' ? ' deleted' : ''}`}>
              {baseName(change.path)}
            </span>
            <span className="code-file-dir">{dirName(change.path)}</span>
            <Actions actions={actions([change])} busy={busy} />
            <span className={`code-kind ${change.kind}`} title={change.kind}>
              {KIND_LETTERS[change.kind]}
            </span>
          </div>
        ))}
    </section>
  )
}

function Actions({ actions, busy }: { actions: RowAction[]; busy?: string }): React.JSX.Element {
  return (
    <span className="code-actions">
      {actions.map((action) => (
        <button
          key={action.title}
          className="icon-btn small"
          title={action.title}
          disabled={Boolean(busy)}
          onClick={(e) => {
            e.stopPropagation()
            action.onClick()
          }}
        >
          {action.icon}
        </button>
      ))}
    </span>
  )
}

/** The letters VS Code marks changes with. */
const KIND_LETTERS: Record<GitChange['kind'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: '!'
}

/** The branch button and its menu: switch to a branch, or create one. */
function BranchMenu({
  projectId,
  label,
  disabled,
  run
}: {
  projectId: string
  label: string
  disabled: boolean
  run: Run
}): React.JSX.Element {
  const [at, setAt] = useState<React.CSSProperties>()
  const [branches, setBranches] = useState<GitBranch[]>()
  const [creating, setCreating] = useState<string>()
  const [failed, setFailed] = useState<string>()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useOverlay(menuRef, Boolean(at))

  useEffect(() => {
    if (!at) return
    const close = (): void => {
      setAt(undefined)
      setCreating(undefined)
    }
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    document.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [at])

  function toggle(): void {
    if (at) {
      setAt(undefined)
      return
    }
    const rect = buttonRef.current!.getBoundingClientRect()
    setAt({
      top: rect.bottom + 4,
      left: rect.left,
      maxHeight: window.innerHeight - rect.bottom - 16
    })
    setBranches(undefined)
    setFailed(undefined)
    window.api.git
      .branches(projectId)
      .then(setBranches)
      .catch((e: unknown) => setFailed(errorMessage(e)))
  }

  const pick = (action: () => Promise<void>): void => {
    setAt(undefined)
    setCreating(undefined)
    void run('branch', action)
  }

  return (
    <>
      <button
        ref={buttonRef}
        className="code-branch"
        title="Switch branch"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={toggle}
      >
        <BranchIcon width={14} height={14} />
        <span>{label}</span>
      </button>
      {at &&
        createPortal(
          <div className="menu code-branch-menu" role="menu" style={at} ref={menuRef}>
            {creating === undefined ? (
              <button role="menuitem" onClick={() => setCreating('')}>
                <PlusIcon width={14} height={14} />
                Create new branch…
              </button>
            ) : (
              <form
                className="code-branch-new"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = creating.trim()
                  if (name) pick(() => window.api.git.createBranch(projectId, name))
                }}
              >
                <input
                  autoFocus
                  placeholder="Branch name, then Enter"
                  value={creating}
                  onChange={(e) => setCreating(e.target.value)}
                />
              </form>
            )}
            {failed && <div className="code-branch-note">{failed}</div>}
            {!branches && !failed && <div className="code-branch-note">Loading branches…</div>}
            {branches?.map((branch) => (
              <button
                key={`${branch.remote}:${branch.name}`}
                role="menuitem"
                className={branch.current ? 'current' : undefined}
                disabled={branch.current}
                onClick={() => pick(() => window.api.git.checkout(projectId, branch))}
              >
                {branch.current ? (
                  <CheckIcon width={14} height={14} />
                ) : (
                  <BranchIcon width={14} height={14} />
                )}
                <span>{branch.name}</span>
                {branch.remote && <small>remote</small>}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function dirName(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}
