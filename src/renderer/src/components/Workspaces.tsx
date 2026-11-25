import type { ChatWorkspace, CodeReview } from '../../../shared/types'
import { useHome } from '../lib/workspaces'
import { BranchIcon } from './icons'

/** A folder as the user knows it: ~ for the home folder. */
function shortPath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** What the checkout has checked out: its branch, or the commit HEAD is detached at. */
function checkedOut(workspace: ChatWorkspace): string {
  return workspace.branch ?? (workspace.head ? `${workspace.head} (detached)` : 'No commits yet')
}

/** !12 on GitLab, #12 on GitHub. */
function reviewName(review: CodeReview): string {
  return `${review.kind === 'mr' ? '!' : '#'}${review.number}`
}

const REVIEW_STATES: Record<CodeReview['state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

/**
 * In the chat's top bar: the branch the chat works on now, whether that is a
 * worktree, and its merge or pull request. A click opens the code panel,
 * which lists every checkout the chat worked in.
 */
export function WorkspaceChip({
  workspaces,
  onOpen
}: {
  workspaces: ChatWorkspace[]
  onOpen: () => void
}): React.JSX.Element | null {
  const home = useHome()
  const now = workspaces.find((w) => w.current) ?? workspaces[0]
  if (!now) return null
  const lines = [
    `Working in ${shortPath(now.root, home)}`,
    `On ${checkedOut(now)}`,
    ...(now.worktreeOf ? [`A worktree of ${shortPath(now.worktreeOf, home)}`] : []),
    ...(now.review
      ? [`${reviewName(now.review)} ${now.review.title} (${REVIEW_STATES[now.review.state]})`]
      : []),
    ...(workspaces.length > 1 ? [`${workspaces.length} checkouts in this chat`] : [])
  ]
  return (
    <button className="workspace-chip" title={lines.join('\n')} onClick={onOpen}>
      <BranchIcon width={13} height={13} />
      <span className="workspace-chip-branch">{checkedOut(now)}</span>
      {now.worktreeOf && <span className="workspace-tag">worktree</span>}
      {now.review && (
        <span className={`workspace-review ${now.review.state}`}>{reviewName(now.review)}</span>
      )}
    </button>
  )
}

/**
 * At the top of the code panel: every checkout the chat worked in, the one
 * it works in now first, each with its branch, where it is, and its merge or
 * pull request, which opens in the browser.
 */
export function WorkspaceList({
  workspaces
}: {
  workspaces: ChatWorkspace[]
}): React.JSX.Element | null {
  const home = useHome()
  if (!workspaces.length) return null
  return (
    <section className="workspaces" aria-label="Where this chat works">
      {workspaces.map((w) => (
        <div key={w.root} className={`workspace${w.current ? ' current' : ''}`}>
          <BranchIcon width={14} height={14} className="workspace-icon" />
          <div className="workspace-text">
            <div className="workspace-branch" title={checkedOut(w)}>
              {checkedOut(w)}
            </div>
            <div className="workspace-where" title={w.root}>
              {w.worktreeOf
                ? `Worktree ${folderName(w.root)} of ${folderName(w.worktreeOf)}`
                : shortPath(w.root, home)}
            </div>
          </div>
          <div className="workspace-facts">
            {w.current && <span className="workspace-tag now">Now</span>}
            {w.changes > 0 && (
              <span className="workspace-fact" title={`${w.changes} files changed`}>
                {w.changes} changed
              </span>
            )}
            {(w.ahead > 0 || w.behind > 0) && (
              <span
                className="workspace-fact"
                title={`${w.behind} to pull, ${w.ahead} to push${w.upstream ? ` (${w.upstream})` : ''}`}
              >
                {w.behind}↓ {w.ahead}↑
              </span>
            )}
            {w.review && (
              <a
                className={`workspace-review ${w.review.state}`}
                href={w.review.url}
                target="_blank"
                rel="noreferrer"
                title={`${w.review.title} (${REVIEW_STATES[w.review.state]})`}
              >
                {reviewName(w.review)} {REVIEW_STATES[w.review.state]}
              </a>
            )}
          </div>
        </div>
      ))}
    </section>
  )
}
