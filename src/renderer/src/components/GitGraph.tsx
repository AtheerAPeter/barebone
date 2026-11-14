import { useEffect, useId, useMemo, useState } from 'react'
import type { GitCommit, GitLog, GitStatus } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import {
  DOT_RADIUS,
  LANE_WIDTH,
  ROW_HEIGHT,
  dotOf,
  graphRows,
  refColors,
  rowPaths,
  rowWidth,
  type GraphRow
} from '../lib/git-graph'
import type { MenuAt, MenuEntries } from '../lib/menus'
import { PopupMenu } from './PopupMenu'
import {
  BranchIcon,
  ChevronIcon,
  CloudDownIcon,
  PullIcon,
  PushIcon,
  ReloadIcon,
  TagIcon
} from './icons'

type Repo = Extract<GitStatus, { repo: true }>
type Run = (what: string, action: () => Promise<unknown>) => Promise<void>

/** Commits the graph reads at a time; Load More reads as many again, as VS Code's does. */
const PAGE = 50

/**
 * VS Code's Source Control Graph: the commits of the checked-out branch and
 * its upstream, their lanes, and their branches and tags. A commit opens its
 * changes; its menu checks it out, picks it onto the branch, or copies it.
 */
export function GitGraph({
  projectId,
  repo,
  open,
  onToggle,
  busy,
  run,
  opened,
  onOpenCommit
}: {
  projectId: string
  repo: Repo
  open: boolean
  onToggle: () => void
  busy?: string
  run: Run
  /** The commit whose changes are open in a tab. */
  opened?: string
  onOpenCommit: (commit: GitCommit) => void
}): React.JSX.Element {
  const [log, setLog] = useState<GitLog>()
  const [limit, setLimit] = useState(PAGE)
  /** Bumped by the Refresh button, to read the graph again. */
  const [reloads, setReloads] = useState(0)
  const [failed, setFailed] = useState<string>()
  const [menu, setMenu] = useState<{ at: MenuAt; commit: GitCommit }>()

  // Read again whenever the status is: a commit, a pull or a fetch moves the graph.
  useEffect(() => {
    if (!open) return
    let current = true
    window.api.git.log(projectId, limit).then(
      (read) => {
        if (!current) return
        setLog(read)
        setFailed(undefined)
      },
      (e: unknown) => current && setFailed(errorMessage(e))
    )
    return () => {
      current = false
    }
  }, [projectId, repo, limit, open, reloads])

  const rows = useMemo(() => (log ? graphRows(log) : []), [log])
  const colors = useMemo(() => (log ? refColors(log) : new Map<string, string>()), [log])

  const copy = (text: string): void => void navigator.clipboard.writeText(text)
  const menuEntries = (commit: GitCommit): MenuEntries => [
    {
      name: 'Checkout (Detached)',
      onSelect: () => run('checkout', () => window.api.git.checkoutCommit(projectId, commit.hash))
    },
    {
      name: 'Cherry Pick',
      disabled: commit.hash === log?.head,
      onSelect: () => run('cherry-pick', () => window.api.git.cherryPick(projectId, commit.hash))
    },
    null,
    { name: 'Copy Commit ID', onSelect: () => copy(commit.hash) },
    { name: 'Copy Commit Message', onSelect: () => copy(commit.message) }
  ]

  const actions = (
    <span className="code-actions">
      <button
        className="icon-btn small"
        title="Fetch"
        disabled={Boolean(busy)}
        onClick={(e) => {
          e.stopPropagation()
          void run('fetch', () => window.api.git.fetch(projectId))
        }}
      >
        <CloudDownIcon width={14} height={14} />
      </button>
      {repo.upstream && (
        <button
          className="icon-btn small"
          title="Pull"
          disabled={Boolean(busy)}
          onClick={(e) => {
            e.stopPropagation()
            void run('pull', () => window.api.git.pull(projectId))
          }}
        >
          <PullIcon width={14} height={14} />
        </button>
      )}
      {repo.branch && (
        <button
          className="icon-btn small"
          title={repo.upstream ? 'Push' : 'Publish Branch'}
          disabled={Boolean(busy)}
          onClick={(e) => {
            e.stopPropagation()
            void run('push', () => window.api.git.push(projectId))
          }}
        >
          <PushIcon width={14} height={14} />
        </button>
      )}
      <button
        className="icon-btn small"
        title="Refresh"
        disabled={Boolean(busy)}
        onClick={(e) => {
          e.stopPropagation()
          setReloads((n) => n + 1)
        }}
      >
        <ReloadIcon width={14} height={14} />
      </button>
    </span>
  )

  return (
    <section className={`code-graph${open ? ' open' : ''}`}>
      <div className="code-view-head" onClick={onToggle}>
        <ChevronIcon width={12} height={12} className={`code-chevron${open ? ' open' : ''}`} />
        <span className="code-group-title">Graph</span>
        {actions}
      </div>
      {open && (
        <div className="code-graph-list">
          {failed && <div className="code-branch-note">{failed}</div>}
          {log && !log.commits.length && <div className="code-branch-note">No commits yet.</div>}
          {rows.map((row) => (
            <div
              key={row.commit.hash}
              className={`code-commit-row${opened === row.commit.hash ? ' open' : ''}`}
              title={tooltip(row.commit)}
              onClick={() => onOpenCommit(row.commit)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ at: { x: e.clientX, y: e.clientY }, commit: row.commit })
              }}
            >
              <Lanes row={row} />
              <span className="code-commit-subject">{subject(row.commit)}</span>
              <span className="code-commit-author">{row.commit.author}</span>
              <span className="code-commit-refs">
                {row.commit.refs.map((ref) => (
                  <span
                    key={ref.id}
                    className={`code-ref${colors.has(ref.id) ? ' colored' : ''}`}
                    style={
                      colors.has(ref.id)
                        ? ({ '--ref': colors.get(ref.id) } as React.CSSProperties)
                        : undefined
                    }
                    title={ref.id}
                  >
                    {ref.kind === 'tag' ? (
                      <TagIcon width={11} height={11} />
                    ) : (
                      <BranchIcon width={11} height={11} />
                    )}
                    {ref.name}
                  </span>
                ))}
              </span>
            </div>
          ))}
          {log?.more && (
            <button className="code-graph-more" onClick={() => setLimit((l) => l + PAGE)}>
              Load More…
            </button>
          )}
        </div>
      )}
      {menu && (
        <PopupMenu
          at={menu.at}
          entries={menuEntries(menu.commit)}
          onClose={() => setMenu(undefined)}
        />
      )}
    </section>
  )
}

/**
 * A row's lanes and its commit's dot: a ring for HEAD, a ring around a dot for
 * a merge, else a dot. The lanes stop short of a ring, which is see-through.
 */
function Lanes({ row }: { row: GraphRow }): React.JSX.Element {
  const mask = useId()
  const { index, color } = dotOf(row)
  const width = rowWidth(row)
  const cx = LANE_WIDTH * (index + 1)
  const cy = ROW_HEIGHT / 2
  const ring = row.head || row.commit.parents.length > 1
  const r = DOT_RADIUS + 1
  return (
    <svg className="code-lanes" width={width} height={ROW_HEIGHT} aria-hidden>
      {ring && (
        <mask id={mask}>
          <rect width={width} height={ROW_HEIGHT} fill="white" />
          <circle cx={cx} cy={cy} r={r} fill="black" />
        </mask>
      )}
      <g mask={ring ? `url(#${mask})` : undefined}>
        {rowPaths(row).map((path, i) => (
          <path key={i} d={path.d} stroke={path.color} />
        ))}
      </g>
      {ring ? (
        <>
          <circle cx={cx} cy={cy} r={r - 1} fill="none" stroke={color} strokeWidth={2} />
          {!row.head && <circle cx={cx} cy={cy} r={1.75} fill={color} />}
        </>
      ) : (
        <circle cx={cx} cy={cy} r={DOT_RADIUS} fill={color} />
      )}
    </svg>
  )
}

function subject(commit: GitCommit): string {
  const end = commit.message.indexOf('\n')
  return end === -1 ? commit.message : commit.message.slice(0, end)
}

function tooltip(commit: GitCommit): string {
  const when = new Date(commit.date).toLocaleString()
  return `${commit.author}, ${when}\n${commit.hash.slice(0, 8)}\n\n${commit.message}`
}
