import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  CodeDoc,
  GitBranch,
  GitChange,
  GitCommit,
  GitStatus,
  Project,
  WalkAt,
  Walkthrough
} from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { readPref, writePref } from '../lib/prefs'
import { menusAsSheets } from '../lib/touch'
import { useOverlay } from '../lib/overlays'
import { CHAT_MIN_WIDTH, dragDivider } from '../lib/side-panel'
import { CodeView } from './CodeView'
import { GitGraph } from './GitGraph'
import { MultiDiff } from './MultiDiff'
import type { MenuAt, MenuEntries } from '../lib/menus'
import { PopupMenu } from './PopupMenu'
import { SourceControl, type Repo, type Run } from './SourceControl'
import { WalkthroughView } from './Walkthrough'
import {
  BranchIcon,
  CheckIcon,
  CloseIcon,
  ListIcon,
  MoreIcon,
  PlusIcon,
  ReloadIcon,
  SyncIcon,
  TreeIcon
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

/** A file the user opened from the list: its staged or unstaged changes, or the file itself. */
type Opened =
  | { view: 'staged' | 'unstaged'; change: GitChange; doc: CodeDoc }
  | { view: 'file'; path: string; doc: CodeDoc }

/** Several files' changes in one tab: a commit's, or a whole group's. */
type Multi = { kind: 'commit'; commit: GitCommit } | { kind: 'group'; staged: boolean }

type Tab = 'changes' | 'diff' | 'multi' | 'walk'

/** The viewer's choices for the panel, kept between chats as VS Code keeps them. */
const TREE_PREF = 'code.tree'
const GRAPH_PREF = 'code.graph'

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
  const [multi, setMulti] = useState<Multi>()
  const [walking, setWalking] = useState<{ walk: Walkthrough; at: WalkAt; from?: number }>()
  const [tab, setTab] = useState<Tab>('changes')
  /** What git is doing for a button, which waits meanwhile. */
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  /** The commit message, kept while other tabs show. */
  const [message, setMessage] = useState('')
  const [tree, setTree] = useState(() => readPref(TREE_PREF, false))
  const [graphOpen, setGraphOpen] = useState(() => readPref(GRAPH_PREF, true))
  const [more, setMore] = useState<MenuAt>()
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

  /** Read the status again, and the opened file with it; a diff gone from the list closes. */
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
  const run: Run = useCallback(
    async (what, action) => {
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

  async function show(read: () => Promise<Opened>): Promise<void> {
    try {
      setOpened(await read())
      setTab('diff')
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  const openChange = (change: GitChange, staged: boolean): Promise<void> =>
    show(async () => ({
      view: staged ? 'staged' : 'unstaged',
      change,
      doc: await window.api.git.diff(projectId, change, staged)
    }))
  const openFile = (path: string): Promise<void> =>
    show(async () => ({ view: 'file', path, doc: await window.api.git.file(projectId, path) }))

  const openMulti = (next: Multi): void => {
    setMulti(next)
    setTab('multi')
  }

  const repo = status?.repo ? status : undefined

  const moreEntries = (r: Repo): MenuEntries => {
    const all = [...r.conflicts, ...r.unstaged]
    return [
      {
        name: 'Pull',
        disabled: !r.upstream,
        onSelect: () => run('pull', () => window.api.git.pull(projectId))
      },
      {
        name: r.upstream ? 'Push' : 'Publish Branch',
        disabled: !r.branch,
        onSelect: () => run('push', () => window.api.git.push(projectId))
      },
      { name: 'Fetch', onSelect: () => run('fetch', () => window.api.git.fetch(projectId)) },
      null,
      {
        name: 'Undo Last Commit',
        disabled: !r.head,
        onSelect: () =>
          run('undo', async () => {
            const undone = await window.api.git.undoCommit(projectId)
            // As VS Code does: the message comes back to the box, unless one is being written.
            setMessage((m) => m || undone)
          })
      },
      null,
      {
        name: 'Stage All Changes',
        disabled: !all.length,
        onSelect: () => run('stage', () => window.api.git.stage(projectId, all))
      },
      {
        name: 'Unstage All Changes',
        disabled: !r.staged.length,
        onSelect: () => run('unstage', () => window.api.git.unstage(projectId, r.staged))
      },
      // Discarding asks first, in a dialog on the Mac.
      ...(window.api.remote
        ? []
        : [
            {
              name: 'Discard All Changes',
              danger: true,
              disabled: !r.unstaged.length,
              onSelect: () =>
                void run('discard', () => window.api.git.discard(projectId, r.unstaged))
            }
          ]),
      null,
      { name: 'Stash', onSelect: () => run('stash', () => window.api.git.stash(projectId, false)) },
      {
        name: 'Stash (Include Untracked)',
        onSelect: () => run('stash', () => window.api.git.stash(projectId, true))
      },
      {
        name: 'Apply Latest Stash',
        onSelect: () => run('stash', () => window.api.git.unstash(projectId, false))
      },
      {
        name: 'Pop Latest Stash',
        onSelect: () => run('stash', () => window.api.git.unstash(projectId, true))
      }
    ]
  }

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
            title={openedTitle(opened)}
            onClose={() => {
              setOpened(undefined)
              setTab('changes')
            }}
          >
            {baseName(opened.view === 'file' ? opened.path : opened.change.path)}
            <span className="code-tab-note">
              {opened.view === 'file' ? 'file' : opened.view === 'staged' ? 'staged' : 'changes'}
            </span>
          </PanelTab>
        )}
        {multi && (
          <PanelTab
            active={tab === 'multi'}
            onSelect={() => setTab('multi')}
            title={
              multi.kind === 'commit'
                ? `${subjectOf(multi.commit)} (${multi.commit.hash.slice(0, 7)})`
                : multi.staged
                  ? 'Staged Changes'
                  : 'Changes'
            }
            onClose={() => {
              setMulti(undefined)
              setTab('changes')
            }}
          >
            {multi.kind === 'commit'
              ? subjectOf(multi.commit)
              : multi.staged
                ? 'Staged Changes'
                : 'Changes'}
            <span className="code-tab-note">
              {multi.kind === 'commit' ? multi.commit.hash.slice(0, 7) : 'all files'}
            </span>
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
            {repo && (
              <button
                className="icon-btn"
                title={tree ? 'View as List' : 'View as Tree'}
                onClick={() => {
                  writePref(TREE_PREF, !tree)
                  setTree(!tree)
                }}
              >
                {tree ? <ListIcon /> : <TreeIcon />}
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
            {repo && (
              <button
                className={`icon-btn${more ? ' on' : ''}`}
                title="More Actions…"
                aria-haspopup="menu"
                aria-expanded={Boolean(more)}
                disabled={Boolean(busy)}
                onClick={(e) =>
                  setMore(more ? undefined : { below: e.currentTarget, align: 'right' })
                }
              >
                <MoreIcon />
              </button>
            )}
            {more && repo && (
              <PopupMenu at={more} entries={moreEntries(repo)} onClose={() => setMore(undefined)} />
            )}
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
            <div className="code-views">
              <SourceControl
                projectId={projectId}
                repo={repo}
                busy={busy}
                run={run}
                tree={tree}
                message={message}
                onMessage={setMessage}
                onOpen={(change, staged) => void openChange(change, staged)}
                onOpenFile={(path) => void openFile(path)}
                onViewGroup={(staged) => openMulti({ kind: 'group', staged })}
              />
              <GitGraph
                projectId={projectId}
                repo={repo}
                open={graphOpen}
                onToggle={() => {
                  writePref(GRAPH_PREF, !graphOpen)
                  setGraphOpen(!graphOpen)
                }}
                busy={busy}
                run={run}
                opened={multi?.kind === 'commit' ? multi.commit.hash : undefined}
                onOpenCommit={(commit) => openMulti({ kind: 'commit', commit })}
              />
            </div>
          )}
        </>
      )}

      {tab === 'diff' && opened && <CodeView key={openedTitle(opened)} doc={opened.doc} />}

      {tab === 'multi' && multi && (
        <MultiTab key={multiKey(multi)} projectId={projectId} multi={multi} repo={repo} />
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

/** A commit's files, or a group's, each with its diff. A group's follow the status. */
function MultiTab({
  projectId,
  multi,
  repo
}: {
  projectId: string
  multi: Multi
  repo?: Repo
}): React.JSX.Element {
  const [commitChanges, setCommitChanges] = useState<GitChange[]>()
  const [failed, setFailed] = useState<string>()
  const hash = multi.kind === 'commit' ? multi.commit.hash : undefined
  const staged = multi.kind === 'group' && multi.staged

  useEffect(() => {
    if (!hash) return
    let current = true
    window.api.git.commitChanges(projectId, hash).then(
      (read) => current && setCommitChanges(read),
      (e: unknown) => current && setFailed(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [projectId, hash])

  const load = useCallback(
    (change: GitChange) =>
      hash
        ? window.api.git.commitDiff(projectId, hash, change)
        : window.api.git.diff(projectId, change, staged),
    [projectId, hash, staged]
  )

  if (failed) return <div className="code-empty">{failed}</div>
  const changes = hash ? commitChanges : staged ? repo?.staged : repo?.unstaged
  return <MultiDiff changes={changes} load={load} version={hash ? undefined : repo} />
}

function multiKey(multi: Multi): string {
  return multi.kind === 'commit' ? multi.commit.hash : `group:${multi.staged}`
}

/** A project's status, and the opened file read again; a diff closes when its file left that list. */
async function readStatus(
  projectId: string,
  open: Opened | undefined
): Promise<{ status: GitStatus; opened?: Opened }> {
  const status = await window.api.git.status(projectId)
  if (!open || !status.repo) return { status }
  if (open.view === 'file') {
    const doc = await window.api.git.file(projectId, open.path)
    return { status, opened: { ...open, doc } }
  }
  const staged = open.view === 'staged'
  const list = staged ? status.staged : [...status.conflicts, ...status.unstaged]
  const change = list.find((c) => c.path === open.change.path)
  if (!change) return { status }
  const doc = await window.api.git.diff(projectId, change, staged)
  return { status, opened: { view: open.view, change, doc } }
}

function count(repo: Repo): number {
  return repo.conflicts.length + repo.staged.length + repo.unstaged.length
}

function openedTitle(opened: Opened): string {
  if (opened.view === 'file') return opened.path
  return `${opened.change.path} (${opened.view === 'staged' ? 'staged' : 'working tree'})`
}

function subjectOf(commit: GitCommit): string {
  const end = commit.message.indexOf('\n')
  return end === -1 ? commit.message : commit.message.slice(0, end)
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
    // On a phone it is a sheet along the bottom (remote/remote.css), not by the button.
    setAt(
      menusAsSheets()
        ? {}
        : {
            top: rect.bottom + 4,
            left: rect.left,
            maxHeight: window.innerHeight - rect.bottom - 16
          }
    )
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
          <div
            className={`menu code-branch-menu${menusAsSheets() ? ' sheet' : ''}`}
            role="menu"
            style={at}
            ref={menuRef}
          >
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
