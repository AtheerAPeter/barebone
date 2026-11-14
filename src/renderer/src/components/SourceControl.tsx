import { useEffect, useMemo, useRef, useState } from 'react'
import type { GitChange, GitStatus } from '../../../shared/types'
import { touchScreen } from '../lib/touch'
import { FileIcon } from './FileIcon'
import { tidy, type MenuAt, type MenuEntries } from '../lib/menus'
import { PopupMenu } from './PopupMenu'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronIcon,
  DiffIcon,
  DiscardIcon,
  MinusIcon,
  OpenFileIcon,
  PlusIcon,
  SyncIcon
} from './icons'

export type Repo = Extract<GitStatus, { repo: true }>
export type Run = (what: string, action: () => Promise<unknown>) => Promise<void>

/** VS Code's resource groups: merge conflicts, the index (staged), the working tree. */
type GroupId = 'merge' | 'index' | 'workingTree'

interface Group {
  id: GroupId
  title: string
  changes: GitChange[]
}

/** A line of the list: a group's header, a folder (in the tree), or a changed file. */
type Row =
  | { type: 'group'; key: string; group: Group; depth: 0 }
  | {
      type: 'folder'
      key: string
      group: Group
      /** Where it is in the repository; a compacted chain's last folder. */
      path: string
      /** As shown: a chain of folders with nothing else in them reads as one, a/b/c. */
      name: string
      depth: number
      changes: GitChange[]
    }
  | { type: 'file'; key: string; group: Group; change: GitChange; depth: number }

interface RowAction {
  title: string
  icon: React.ReactNode
  onClick: () => void
}

/** VS Code's Source Control: the commit box, then the changes in their groups. */
export function SourceControl({
  projectId,
  repo,
  busy,
  run,
  tree,
  message,
  onMessage,
  onOpen,
  onOpenFile,
  onViewGroup
}: {
  projectId: string
  repo: Repo
  busy?: string
  run: Run
  /** Show the changes in their folders rather than as one list. */
  tree: boolean
  message: string
  onMessage: (message: string) => void
  onOpen: (change: GitChange, staged: boolean) => void
  onOpenFile: (path: string) => void
  /** Open all of a group's changes at once, as VS Code's View Changes. */
  onViewGroup: (staged: boolean) => void
}): React.JSX.Element {
  const groups = useMemo(() => {
    const all: Group[] = [
      { id: 'merge', title: 'Merge Changes', changes: repo.conflicts },
      { id: 'index', title: 'Staged Changes', changes: repo.staged },
      { id: 'workingTree', title: 'Changes', changes: repo.unstaged }
    ]
    return all.filter((g) => g.changes.length > 0)
  }, [repo])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const rows = useMemo(() => listRows(groups, tree, collapsed), [groups, tree, collapsed])

  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [focused, setFocused] = useState<string>()
  /** Where a shift-click or shift-arrow selection runs from. */
  const anchor = useRef<string>(undefined)
  const [menu, setMenu] = useState<{ at: MenuAt; entries: MenuEntries }>()
  const listRef = useRef<HTMLDivElement>(null)

  const toggle = (key: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // The focused row stays in sight as the arrow keys move it.
  useEffect(() => {
    if (!focused) return
    listRef.current
      ?.querySelector(`[data-key="${CSS.escape(focused)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const stage = (changes: GitChange[]): Promise<void> =>
    run('stage', () => window.api.git.stage(projectId, changes))
  const unstage = (changes: GitChange[]): Promise<void> =>
    run('unstage', () => window.api.git.unstage(projectId, changes))
  const discard = (changes: GitChange[]): Promise<void> =>
    run('discard', () => window.api.git.discard(projectId, changes))
  // Discarding asks first, in a dialog on the Mac; Finder is there too.
  const onMac = !window.api.remote

  /** The rows an action on a row is for: the selection, when the row is in it, within its group. */
  function targets(row: Row): Row[] {
    if (!selected.has(row.key)) return [row]
    return rows.filter((r) => selected.has(r.key) && r.group.id === row.group.id)
  }

  /** The changes of rows, each once: a folder's or a group's are all those under it. */
  function changesOf(of: Row[]): GitChange[] {
    const seen = new Map<string, GitChange>()
    for (const row of of) {
      const list =
        row.type === 'file' ? [row.change] : row.type === 'folder' ? row.changes : row.group.changes
      for (const change of list) seen.set(change.path, change)
    }
    return [...seen.values()]
  }

  /** The paths of rows, as git and Finder name them: a folder's own, a file's. */
  function pathsOf(of: Row[]): string[] {
    return of.flatMap((r) =>
      r.type === 'file' ? [r.change.path] : r.type === 'folder' ? [r.path] : []
    )
  }

  /** A row's buttons, shown on hover as in VS Code, for the selection when the row is in it. */
  function inline(row: Row): RowAction[] {
    // Read on press: every row has buttons, and the selection is looked through for each.
    const changes = (): GitChange[] => changesOf(targets(row))
    const all = row.type === 'group'
    const actions: RowAction[] = []
    if (row.type === 'file' && row.change.kind !== 'deleted') {
      actions.push({
        title: 'Open File',
        icon: <OpenFileIcon width={14} height={14} />,
        onClick: () => onOpenFile(row.change.path)
      })
    }
    if (all && row.group.id !== 'merge') {
      const staged = row.group.id === 'index'
      actions.push({
        title: staged ? 'View Staged Changes' : 'View Changes',
        icon: <DiffIcon width={14} height={14} />,
        onClick: () => onViewGroup(staged)
      })
    }
    if (row.group.id === 'index') {
      actions.push({
        title: all ? 'Unstage All Changes' : 'Unstage Changes',
        icon: <MinusIcon width={14} height={14} />,
        onClick: () => void unstage(changes())
      })
      return actions
    }
    if (row.group.id === 'workingTree' && onMac) {
      actions.push({
        title: all ? 'Discard All Changes' : 'Discard Changes',
        icon: <DiscardIcon width={14} height={14} />,
        onClick: () => void discard(changes())
      })
    }
    actions.push({
      title: all ? 'Stage All Changes' : 'Stage Changes',
      icon: <PlusIcon width={14} height={14} />,
      onClick: () => void stage(changes())
    })
    return actions
  }

  /** A row's right-click menu, as VS Code's for a file, a folder, or a group. */
  function contextMenu(row: Row): MenuEntries {
    const of = targets(row)
    const changes = changesOf(of)
    const paths = pathsOf(of)
    const group = row.group.id
    const all = row.type === 'group'
    const file = row.type === 'file' ? row.change : undefined
    const copy = (text: string): void => void navigator.clipboard.writeText(text)
    return tidy([
      file &&
        group !== 'merge' && {
          name: 'Open Changes',
          onSelect: () => onOpen(file, group === 'index')
        },
      file &&
        file.kind !== 'deleted' && { name: 'Open File', onSelect: () => onOpenFile(file.path) },
      null,
      group === 'index'
        ? {
            name: all ? 'Unstage All Changes' : 'Unstage Changes',
            onSelect: () => void unstage(changes)
          }
        : {
            name: all ? 'Stage All Changes' : 'Stage Changes',
            onSelect: () => void stage(changes)
          },
      group === 'workingTree' &&
        onMac && {
          name: all ? 'Discard All Changes' : 'Discard Changes',
          danger: true,
          onSelect: () => void discard(changes)
        },
      group === 'workingTree' &&
        !all && {
          name: 'Add to .gitignore',
          onSelect: () => void run('ignore', () => window.api.git.ignore(projectId, paths))
        },
      null,
      file &&
        onMac &&
        file.kind !== 'deleted' && {
          name: 'Reveal in Finder',
          onSelect: () => void window.api.git.reveal(projectId, file.path)
        },
      null,
      file && {
        name: 'Copy Path',
        onSelect: () => copy(paths.map((p) => `${repo.root}/${p}`).join('\n'))
      },
      file && { name: 'Copy Relative Path', onSelect: () => copy(paths.join('\n')) }
    ])
  }

  /** What a row does when chosen: a file opens its changes, a group or folder folds. */
  function activate(row: Row): void {
    if (row.type === 'file') onOpen(row.change, row.group.id === 'index')
    else toggle(row.key)
  }

  function selectRange(to: string): void {
    const from = rows.findIndex((r) => r.key === (anchor.current ?? to))
    const end = rows.findIndex((r) => r.key === to)
    const [a, b] = from < end ? [from, end] : [end, from]
    setSelected(new Set(rows.slice(Math.max(a, 0), b + 1).map((r) => r.key)))
  }

  function onRowClick(event: React.MouseEvent, row: Row): void {
    setFocused(row.key)
    if (event.shiftKey) return selectRange(row.key)
    anchor.current = row.key
    if (event.metaKey) {
      setSelected((s) => {
        const next = new Set(s)
        if (!next.delete(row.key)) next.add(row.key)
        return next
      })
      return
    }
    setSelected(new Set([row.key]))
    activate(row)
  }

  function onRowMenu(event: React.MouseEvent, row: Row): void {
    event.preventDefault()
    setFocused(row.key)
    // A right click outside the selection picks that row, as in VS Code.
    if (!selected.has(row.key)) {
      anchor.current = row.key
      setSelected(new Set([row.key]))
    }
    // Read before the selection above takes effect: a row outside it acts on itself alone.
    const entries = contextMenu(row)
    if (entries.length) setMenu({ at: { x: event.clientX, y: event.clientY }, entries })
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    const index = rows.findIndex((r) => r.key === focused)
    const row = rows[index]
    const moveTo = (to: number): void => {
      const target = rows[Math.min(Math.max(to, 0), rows.length - 1)]
      if (!target) return
      setFocused(target.key)
      if (event.shiftKey) selectRange(target.key)
      else {
        anchor.current = target.key
        setSelected(new Set([target.key]))
      }
    }
    switch (event.key) {
      case 'ArrowDown':
        moveTo(index + 1)
        break
      case 'ArrowUp':
        moveTo(index === -1 ? rows.length - 1 : index - 1)
        break
      case 'Home':
        moveTo(0)
        break
      case 'End':
        moveTo(rows.length - 1)
        break
      case 'ArrowRight':
        if (!row || row.type === 'file') return
        if (collapsed.has(row.key)) toggle(row.key)
        else moveTo(index + 1)
        break
      case 'ArrowLeft': {
        if (!row) return
        if (row.type !== 'file' && !collapsed.has(row.key)) {
          toggle(row.key)
          break
        }
        // To the folder or group the row is in: the nearest row above it, one level out.
        const parent = rows.slice(0, index).findLastIndex((r) => r.depth < row.depth)
        if (parent !== -1) moveTo(parent)
        break
      }
      case 'Enter':
      case ' ':
        if (row) activate(row)
        break
      case 'a':
        if (!event.metaKey) return
        setSelected(new Set(rows.filter((r) => r.type === 'file').map((r) => r.key)))
        break
      case 'Escape':
        if (selected.size <= 1) return
        setSelected(new Set(focused ? [focused] : []))
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div className="code-scm">
      <CommitBox
        projectId={projectId}
        repo={repo}
        busy={busy}
        run={run}
        message={message}
        onMessage={onMessage}
      />
      {groups.length > 0 ? (
        <div
          className="scm-list"
          role="tree"
          aria-multiselectable
          tabIndex={0}
          ref={listRef}
          onKeyDown={onKeyDown}
          // Tabbing in starts on the first row; a click focuses the list too, and picks its own row.
          onFocus={(e) => {
            if (!focused && rows[0] && e.target.matches(':focus-visible')) setFocused(rows[0].key)
          }}
        >
          {rows.map((row) => (
            <ListRow
              key={row.key}
              row={row}
              tree={tree}
              folded={collapsed.has(row.key)}
              selected={selected.has(row.key)}
              focused={focused === row.key}
              actions={inline(row)}
              busy={busy}
              onClick={(e) => onRowClick(e, row)}
              onContextMenu={(e) => onRowMenu(e, row)}
            />
          ))}
        </div>
      ) : (
        <p className="code-clean">No changes to commit.</p>
      )}
      {menu && <PopupMenu at={menu.at} entries={menu.entries} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

function ListRow({
  row,
  tree,
  folded,
  selected,
  focused,
  actions,
  busy,
  onClick,
  onContextMenu
}: {
  row: Row
  tree: boolean
  folded: boolean
  selected: boolean
  focused: boolean
  actions: RowAction[]
  busy?: string
  onClick: (event: React.MouseEvent) => void
  onContextMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const className = `scm-row ${row.type}${selected ? ' selected' : ''}${focused ? ' focused' : ''}`
  const style = { '--depth': row.depth } as React.CSSProperties
  const twistie =
    row.type === 'file' ? (
      <span className="scm-twistie" />
    ) : (
      <ChevronIcon
        width={12}
        height={12}
        className={`scm-twistie code-chevron${folded ? '' : ' open'}`}
      />
    )
  const common = {
    className,
    style,
    'data-key': row.key,
    role: 'treeitem',
    'aria-selected': selected,
    onClick,
    onContextMenu
  }

  if (row.type === 'group') {
    return (
      <div {...common} aria-expanded={!folded}>
        {twistie}
        <span className="scm-group-title">{row.group.title}</span>
        <Actions actions={actions} busy={busy} />
        <span className="code-count">{row.group.changes.length}</span>
      </div>
    )
  }
  if (row.type === 'folder') {
    return (
      <div {...common} aria-expanded={!folded} title={row.path}>
        {twistie}
        <span className="scm-name">{row.name}</span>
        <span className="scm-dir" />
        <Actions actions={actions} busy={busy} />
      </div>
    )
  }
  const { change } = row
  const name = change.path.slice(change.path.lastIndexOf('/') + 1)
  return (
    <div {...common} title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}>
      {twistie}
      <FileIcon path={change.path} />
      <span className={`scm-name ${change.kind}`}>{name}</span>
      <span className="scm-dir">{tree ? '' : dirName(change.path)}</span>
      <Actions actions={actions} busy={busy} />
      <span className={`scm-kind ${change.kind}`} title={change.kind}>
        {KIND_LETTERS[change.kind]}
      </span>
    </div>
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
          // The row's own click would select it and open its changes too.
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

/** The commit box and its button, whose ▾ holds VS Code's other ways to commit. */
function CommitBox({
  projectId,
  repo,
  busy,
  run,
  message,
  onMessage
}: {
  projectId: string
  repo: Repo
  busy?: string
  run: Run
  message: string
  onMessage: (message: string) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<MenuAt>()
  const changed = repo.conflicts.length + repo.staged.length + repo.unstaged.length > 0
  const sync = (): void => void run('sync', () => window.api.git.sync(projectId))

  /**
   * Commit, then push or sync when asked. The box empties once the commit is
   * made, even when what follows fails, as in VS Code.
   */
  const commit = ({
    amend = false,
    then
  }: { amend?: boolean; then?: 'push' | 'sync' } = {}): void => {
    if (busy || (!message.trim() && !amend)) return
    void run('commit', async () => {
      if (!(await window.api.git.commit(projectId, message, amend))) return
      onMessage('')
      if (then === 'push') await window.api.git.push(projectId)
      else if (then === 'sync') await window.api.git.sync(projectId)
    })
  }

  // With nothing to commit, the button syncs or publishes, as VS Code's does.
  const primary = changed
    ? {
        label: busy === 'commit' ? 'Committing…' : 'Commit',
        icon: <CheckIcon width={14} height={14} />,
        disabled: !message.trim() || Boolean(busy),
        onClick: () => commit()
      }
    : repo.branch && !repo.upstream
      ? {
          label: busy === 'sync' ? 'Publishing…' : 'Publish Branch',
          icon: <SyncIcon width={14} height={14} />,
          disabled: Boolean(busy),
          onClick: sync
        }
      : repo.upstream && (repo.ahead > 0 || repo.behind > 0)
        ? {
            label: busy === 'sync' ? 'Syncing…' : `Sync Changes ${repo.behind}↓ ${repo.ahead}↑`,
            icon: <SyncIcon width={14} height={14} />,
            disabled: Boolean(busy),
            onClick: sync
          }
        : undefined

  const noMessage = !message.trim()
  const entries: MenuEntries = [
    { name: 'Commit', disabled: noMessage, onSelect: () => commit() },
    { name: 'Commit (Amend)', disabled: !repo.head, onSelect: () => commit({ amend: true }) },
    { name: 'Commit & Push', disabled: noMessage, onSelect: () => commit({ then: 'push' }) },
    { name: 'Commit & Sync', disabled: noMessage, onSelect: () => commit({ then: 'sync' }) }
  ]

  return (
    <div className="code-commit">
      <textarea
        rows={Math.min(Math.max(message.split('\n').length, 1), 8)}
        placeholder={
          touchScreen
            ? `Message${repo.branch ? ` (commits on "${repo.branch}")` : ''}`
            : `Message (⌘Enter to commit${repo.branch ? ` on "${repo.branch}"` : ''})`
        }
        value={message}
        onChange={(e) => onMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.metaKey) {
            e.preventDefault()
            commit()
          }
        }}
      />
      {primary && (
        <div className="code-commit-split">
          <button
            className="btn primary code-commit-button"
            disabled={primary.disabled}
            onClick={primary.onClick}
          >
            {primary.icon}
            {primary.label}
          </button>
          {changed && (
            <button
              className="btn primary code-commit-more"
              title="More Actions…"
              aria-haspopup="menu"
              aria-expanded={Boolean(menu)}
              disabled={Boolean(busy)}
              onClick={(e) =>
                setMenu(menu ? undefined : { below: e.currentTarget, align: 'right' })
              }
            >
              <ChevronDownIcon width={14} height={14} />
            </button>
          )}
        </div>
      )}
      {menu && <PopupMenu at={menu} entries={entries} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

/** The rows of the groups: their files, as one list or in their folders. */
function listRows(groups: Group[], tree: boolean, collapsed: Set<string>): Row[] {
  const rows: Row[] = []
  for (const group of groups) {
    rows.push({ type: 'group', key: group.id, group, depth: 0 })
    if (collapsed.has(group.id)) continue
    if (!tree) {
      for (const change of group.changes) {
        rows.push({ type: 'file', key: `${group.id}/f:${change.path}`, group, change, depth: 1 })
      }
      continue
    }
    const add = (folder: Folder, depth: number): void => {
      for (const sub of [...folder.folders.values()].sort(byName)) {
        // VS Code's compact folders: a chain of folders with only one folder in each reads as one row.
        let end = sub
        let name = sub.name
        while (end.files.length === 0 && end.folders.size === 1) {
          end = [...end.folders.values()][0]
          name += `/${end.name}`
        }
        const key = `${group.id}/d:${end.path}`
        rows.push({ type: 'folder', key, group, path: end.path, name, depth, changes: end.all })
        if (!collapsed.has(key)) add(end, depth + 1)
      }
      for (const change of [...folder.files].sort((a, b) => byName(nameOf(a), nameOf(b)))) {
        rows.push({ type: 'file', key: `${group.id}/f:${change.path}`, group, change, depth })
      }
    }
    add(folderTree(group.changes), 1)
  }
  return rows
}

interface Folder {
  name: string
  path: string
  folders: Map<string, Folder>
  files: GitChange[]
  /** Every change under it, in its folders too. */
  all: GitChange[]
}

function folderTree(changes: GitChange[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], all: changes }
  for (const change of changes) {
    const parts = change.path.split('/')
    let folder = root
    for (const name of parts.slice(0, -1)) {
      let sub = folder.folders.get(name)
      if (!sub) {
        const path = folder.path ? `${folder.path}/${name}` : name
        sub = { name, path, folders: new Map(), files: [], all: [] }
        folder.folders.set(name, sub)
      }
      sub.all.push(change)
      folder = sub
    }
    folder.files.push(change)
  }
  return root
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

function nameOf(change: GitChange): { name: string } {
  return { name: change.path.slice(change.path.lastIndexOf('/') + 1) }
}

function dirName(path: string): string {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
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
