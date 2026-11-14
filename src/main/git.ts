import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { appendFile, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  DiffHunk,
  DiffLine,
  GitBranch,
  GitChange,
  GitChangeKind,
  GitCommit,
  GitLog,
  GitRef,
  GitStatus
} from '../shared/types'

/**
 * The code panel's source control, as VS Code's: git's own command line, run
 * in the repository's top folder, so every path here is relative to it.
 */

/** Diffs of lockfiles and generated files run long; more than this is an error, not a hang. */
const MAX_OUTPUT = 64 * 1024 * 1024

/** Run git; resolves with what it printed, rejects with what it said went wrong. */
function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_OUTPUT,
        env: {
          ...process.env,
          // Reading the status must not take the index lock from a git command the user runs.
          GIT_OPTIONAL_LOCKS: '0',
          // Nobody can answer a password prompt here: fail instead of waiting forever.
          GIT_TERMINAL_PROMPT: '0'
        }
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** The repository a folder is in: its top folder; undefined when it is in none. */
export async function repoRoot(folder: string): Promise<string | undefined> {
  try {
    return (await git(folder, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return undefined
  }
}

/**
 * The repository a file is in, and the file's path in it; undefined when it
 * is in none. Git names both, so a path through a symlinked folder (macOS's
 * /tmp is /private/tmp) matches the paths in its status.
 */
export async function repoPath(file: string): Promise<{ root: string; path: string } | undefined> {
  try {
    const [root, prefix] = (
      await git(dirname(file), ['rev-parse', '--show-toplevel', '--show-prefix'])
    ).split('\n')
    return { root, path: prefix + basename(file) }
  } catch {
    return undefined
  }
}

const KINDS: Record<string, GitChangeKind> = {
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied'
}

/** The status of the repository a folder is in. */
export async function status(folder: string): Promise<GitStatus> {
  const root = await repoRoot(folder)
  if (!root) return { repo: false }
  // Porcelain v2 is git's stable, machine-readable status; -z keeps odd file names whole.
  const out = await git(root, [
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all',
    '-z'
  ])
  const result: Extract<GitStatus, { repo: true }> = {
    repo: true,
    root,
    ahead: 0,
    behind: 0,
    conflicts: [],
    staged: [],
    unstaged: []
  }
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13)
      if (oid !== '(initial)') result.head = oid.slice(0, 7)
    } else if (record.startsWith('# branch.head ')) {
      const head = record.slice(14)
      if (head !== '(detached)') result.branch = head
    } else if (record.startsWith('# branch.upstream ')) {
      result.upstream = record.slice(18)
    } else if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice(12).split(' ')
      result.ahead = Math.abs(Number(ahead))
      result.behind = Math.abs(Number(behind))
    } else if (record.startsWith('1 ') || record.startsWith('2 ')) {
      // "1 XY sub mH mI mW hH hI path"; a rename ("2") has a score, and its old path next.
      const fields = record.split(' ')
      const renamed = record[0] === '2'
      const path = fields.slice(renamed ? 9 : 8).join(' ')
      const oldPath = renamed ? records[++i] : undefined
      const [x, y] = fields[1]
      if (x !== '.')
        result.staged.push(change(path, KINDS[x], x === 'R' || x === 'C' ? oldPath : undefined))
      if (y !== '.') result.unstaged.push(change(path, KINDS[y]))
    } else if (record.startsWith('u ')) {
      result.conflicts.push({ path: record.split(' ').slice(10).join(' '), kind: 'conflicted' })
    } else if (record.startsWith('? ')) {
      result.unstaged.push({ path: record.slice(2), kind: 'untracked' })
    }
  }
  return result
}

function change(path: string, kind: GitChangeKind, oldPath?: string): GitChange {
  return oldPath ? { path, oldPath, kind } : { path, kind }
}

/** A file as of a commit or the index (`:path`); empty when it is not there. */
async function show(root: string, spec: string): Promise<string> {
  try {
    return await git(root, ['show', spec])
  } catch {
    return ''
  }
}

/** A file in the working tree; empty when it is not there. */
async function worktree(root: string, path: string): Promise<string> {
  const file = await repoFile(root, path)
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * A path in the repository, absolute; throws for one that leads out of it,
 * by "..", from the root, or through a symlink. Paths come from the window and
 * from pages of the remote link.
 */
export async function repoFile(root: string, path: string): Promise<string> {
  const file = resolve(root, path)
  // As written, then as it really is: a file that is not there (deleted) has no real path.
  const real = await realpath(file).catch(() => undefined)
  if (outside(root, file) || (real && outside(await realpath(root), real))) {
    throw new Error(`${path} is not in the repository.`)
  }
  return file
}

function outside(root: string, file: string): boolean {
  const within = relative(root, file)
  return within.startsWith('..') || isAbsolute(within)
}

/** A commit's full or abbreviated hash; anything else, an option among them, is refused. */
function commitId(hash: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) throw new Error(`${hash} is not a commit.`)
  return hash
}

/** A file in the working tree, as the code panel opens it; empty when it is not there. */
export async function openFile(
  root: string,
  path: string
): Promise<{ text: string; binary: boolean }> {
  const text = await worktree(root, path)
  return text.includes('\0') ? { text: '', binary: true } : { text, binary: false }
}

type FileDiff = { old: string; new: string; hunks: DiffHunk[]; binary: boolean }

/**
 * A file's changes: staged (the index against the last commit) or unstaged
 * (the working tree against the index), with the file before and after.
 */
export async function diff(root: string, file: GitChange, staged: boolean): Promise<FileDiff> {
  if (file.kind === 'untracked') {
    const text = await worktree(root, file.path)
    if (text.includes('\0')) return { old: '', new: '', hunks: [], binary: true }
    const count = lineCount(text)
    const lines: DiffLine[] = Array.from({ length: count }, (_, n) => ({ type: 'add', new: n + 1 }))
    return { old: '', new: text, hunks: count ? [{ skipped: 0, lines }] : [], binary: false }
  }
  return fileDiff(
    root,
    file,
    staged ? ['--cached'] : [],
    staged ? show(root, `HEAD:${file.oldPath ?? file.path}`) : show(root, `:${file.path}`),
    staged ? show(root, `:${file.path}`) : worktree(root, file.path)
  )
}

/** A file's changes in a commit: against its first parent, as VS Code shows a commit. */
export async function commitDiff(root: string, hash: string, file: GitChange): Promise<FileDiff> {
  commitId(hash)
  const base = await baseOf(root, hash)
  return fileDiff(
    root,
    file,
    [base, hash],
    show(root, `${base}:${file.oldPath ?? file.path}`),
    show(root, `${hash}:${file.path}`)
  )
}

/** The files a commit changed, against its first parent. */
export async function commitChanges(root: string, hash: string): Promise<GitChange[]> {
  commitId(hash)
  const base = await baseOf(root, hash)
  const out = await git(root, ['diff', '--name-status', '-z', '--find-renames', base, hash])
  // "M\0path\0", and a rename or copy "R100\0old\0new\0".
  const fields = out.split('\0')
  const changes: GitChange[] = []
  for (let i = 0; i + 1 < fields.length;) {
    const letter = fields[i][0]
    if (letter === 'R' || letter === 'C') {
      changes.push(change(fields[i + 2], KINDS[letter], fields[i + 1]))
      i += 3
    } else {
      changes.push(change(fields[i + 1], KINDS[letter] ?? 'modified'))
      i += 2
    }
  }
  return changes
}

/** What a commit is compared with: its first parent, or the empty tree for a first commit. */
async function baseOf(root: string, hash: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `${hash}^1`])).trim()
  } catch {
    // Hashed by git, as the empty tree differs between SHA-1 and SHA-256 repositories.
    return (await git(root, ['hash-object', '-t', 'tree', '--stdin'], '')).trim()
  }
}

async function fileDiff(
  root: string,
  file: GitChange,
  range: string[],
  before: Promise<string>,
  after: Promise<string>
): Promise<FileDiff> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const [patch, old, now] = await Promise.all([
    git(root, [
      'diff',
      ...range,
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      '-U3',
      '--',
      ...paths
    ]),
    before,
    after
  ])
  if (/^Binary files .* differ$/m.test(patch)) return { old: '', new: '', hunks: [], binary: true }
  return { old, new: now, hunks: parseHunks(patch), binary: false }
}

function lineCount(text: string): number {
  if (!text) return 0
  const lines = text.split('\n').length
  return text.endsWith('\n') ? lines - 1 : lines
}

/** The hunks of a unified diff, by line numbers into the file before and after. */
export function parseHunks(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let oldLine = 0
  let newLine = 0
  /** Where the last hunk ended in the old file, to count the lines left out before the next. */
  let oldEnd = 1
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      // A hunk that only adds to an empty file starts at line 0.
      const start = Math.max(oldLine, 1)
      current = { skipped: Math.max(start - oldEnd, 0), lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith(' ')) {
      current.lines.push({ type: 'context', old: oldLine++, new: newLine++ })
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', old: oldLine++, before: newLine })
    } else if (line.startsWith('+')) {
      current.lines.push({ type: 'add', new: newLine++ })
    } else continue
    oldEnd = oldLine
  }
  return hunks
}

/** The paths git takes for a change: a rename's old path too, so both sides move together. */
function pathsOf(changes: GitChange[]): string[] {
  return changes.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]))
}

export async function stage(root: string, changes: GitChange[]): Promise<void> {
  await git(root, ['add', '--all', '--', ...pathsOf(changes)])
}

export async function unstage(root: string, changes: GitChange[]): Promise<void> {
  const paths = pathsOf(changes)
  // Before the first commit there is no HEAD to restore the index from.
  const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false
  )
  if (hasHead) await git(root, ['restore', '--staged', '--', ...paths])
  else await git(root, ['rm', '--cached', '--quiet', '-r', '--', ...paths])
}

/** Throw away unstaged changes: tracked files go back to the index, untracked ones are deleted. */
export async function discard(root: string, changes: GitChange[]): Promise<void> {
  const untracked = changes.filter((c) => c.kind === 'untracked').map((c) => c.path)
  const tracked = changes.filter((c) => c.kind !== 'untracked').map((c) => c.path)
  if (untracked.length) await git(root, ['clean', '--force', '--quiet', '--', ...untracked])
  if (tracked.length) await git(root, ['restore', '--worktree', '--', ...tracked])
}

/**
 * Commit what is staged, or every change first when `all`. Amending with no
 * message keeps the last commit's, as VS Code does.
 */
export async function commit(
  root: string,
  message: string,
  { all, amend }: { all: boolean; amend: boolean }
): Promise<void> {
  if (all) await git(root, ['add', '--all'])
  const args = ['commit', ...(amend ? ['--amend'] : [])]
  if (amend && !message.trim()) await git(root, [...args, '--no-edit'])
  // From stdin, so the message reaches git exactly as written, any length or lines.
  else await git(root, [...args, '--file=-'], message)
}

/**
 * Undo the last commit and keep its changes staged, as VS Code's Undo Last
 * Commit does. Returns its message, for the commit box.
 */
export async function undoCommit(root: string): Promise<string> {
  const message = await git(root, ['log', '-1', '--format=%B', 'HEAD'])
  const hasParent = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^']).then(
    () => true,
    () => false
  )
  // The first commit has no parent to go back to: the branch goes back to having none.
  if (hasParent) await git(root, ['reset', '--soft', 'HEAD^'])
  else await git(root, ['update-ref', '-d', 'HEAD'])
  return message.trim()
}

/** Add paths to the repository's .gitignore, one per line, as VS Code's Add to .gitignore does. */
export async function ignore(root: string, paths: string[]): Promise<void> {
  const file = join(root, '.gitignore')
  const text = await readFile(file, 'utf8').catch(() => '')
  const lead = text && !text.endsWith('\n') ? '\n' : ''
  await appendFile(file, `${lead}${paths.join('\n')}\n`)
}

/** Stash the changes, untracked files too when asked. */
export async function stash(root: string, untracked: boolean): Promise<void> {
  await git(root, ['stash', 'push', ...(untracked ? ['--include-untracked'] : [])])
}

/** Bring back the latest stash; `pop` drops it after. */
export async function unstash(root: string, pop: boolean): Promise<void> {
  await git(root, ['stash', pop ? 'pop' : 'apply'])
}

/** The commits of HEAD and its upstream, newest first, for the graph. */
export async function log(root: string, limit: number): Promise<GitLog> {
  const current = await status(root)
  if (!current.repo || !current.head) return { commits: [], more: false }
  // The upstream as fetched; a branch can track one that is gone or not fetched yet.
  const tracked = current.upstream && `refs/remotes/${current.upstream}`
  const upstream =
    tracked &&
    (await git(root, ['rev-parse', '--verify', '--quiet', tracked]).then(
      () => tracked,
      () => undefined
    ))
  // One more than asked, to know whether there are more; -z ends each commit with a NUL.
  const out = await git(root, [
    'log',
    '--topo-order',
    '-z',
    `--max-count=${limit + 1}`,
    '--decorate=full',
    '--format=%H%x1f%P%x1f%an%x1f%ct%x1f%D%x1f%B',
    'HEAD',
    ...(upstream ? [upstream] : [])
  ])
  const commits = out
    .split('\0')
    .filter(Boolean)
    .map((record): GitCommit => {
      const [hash, parents, author, time, decorations, message] = record.split('\x1f')
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        date: Number(time) * 1000,
        message: message.trim(),
        refs: parseRefs(decorations)
      }
    })
  return {
    commits: commits.slice(0, limit),
    head: (await git(root, ['rev-parse', 'HEAD'])).trim(),
    branch: current.branch ? `refs/heads/${current.branch}` : undefined,
    upstream,
    more: commits.length > limit
  }
}

/** The branches and tags of `git log --decorate=full`'s %D: "HEAD -> refs/heads/main, tag: refs/tags/v1". */
function parseRefs(decorations: string): GitRef[] {
  const refs: GitRef[] = []
  for (let item of decorations.split(', ')) {
    if (item.startsWith('HEAD -> ')) item = item.slice(8)
    if (item.startsWith('tag: ')) item = item.slice(5)
    // A remote's HEAD only points at another of its branches.
    if (item.endsWith('/HEAD')) continue
    if (item.startsWith('refs/heads/'))
      refs.push({ id: item, name: item.slice(11), kind: 'branch' })
    else if (item.startsWith('refs/remotes/')) {
      refs.push({ id: item, name: item.slice(13), kind: 'remote' })
    } else if (item.startsWith('refs/tags/')) {
      refs.push({ id: item, name: item.slice(10), kind: 'tag' })
    }
  }
  return refs
}

/** Check out a commit itself, leaving HEAD detached. */
export async function checkoutCommit(root: string, hash: string): Promise<void> {
  await git(root, ['switch', '--detach', commitId(hash)])
}

export async function cherryPick(root: string, hash: string): Promise<void> {
  await git(root, ['cherry-pick', commitId(hash)])
}

/** Local branches, then remote ones, most recently committed to first. */
export async function branches(root: string): Promise<GitBranch[]> {
  const out = await git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%00%(refname:short)%00%(HEAD)',
    'refs/heads',
    'refs/remotes'
  ])
  const list: GitBranch[] = []
  for (const line of out.split('\n')) {
    const [ref, name, head] = line.split('\0')
    // origin/HEAD only points at another remote branch.
    if (!ref || ref.endsWith('/HEAD')) continue
    list.push({ name, remote: ref.startsWith('refs/remotes/'), current: head === '*' })
  }
  return list.sort((a, b) => Number(a.remote) - Number(b.remote))
}

/** Switch to a branch; a remote one gets a local branch that tracks it, as VS Code does. */
export async function checkout(root: string, branch: GitBranch): Promise<void> {
  if (!branch.remote) {
    await git(root, ['switch', branch.name])
    return
  }
  const local = branch.name.slice(branch.name.indexOf('/') + 1)
  const exists = (await branches(root)).some((b) => !b.remote && b.name === local)
  await git(root, exists ? ['switch', local] : ['switch', '--track', branch.name])
}

export async function createBranch(root: string, name: string): Promise<void> {
  await git(root, ['switch', '--create', name])
}

/** The checked-out branch, and whether it tracks one; throws when there is none. */
async function currentBranch(
  root: string,
  to: string
): Promise<{ branch: string; upstream: boolean }> {
  const current = await status(root)
  if (!current.repo) throw new Error('This folder is not in a git repository.')
  if (!current.branch) throw new Error(`Check out a branch to ${to}: HEAD is detached.`)
  return { branch: current.branch, upstream: Boolean(current.upstream) }
}

/** Push a branch that tracks none to the remote, and track it there: VS Code's Publish Branch. */
async function publish(root: string, branch: string): Promise<void> {
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) throw new Error('This repository has no remote to publish the branch to.')
  await git(root, ['push', '--set-upstream', remote, branch])
}

/** Pull, then push: what VS Code's Sync Changes does. A branch with no upstream is published. */
export async function sync(root: string): Promise<void> {
  const { branch, upstream } = await currentBranch(root, 'sync')
  if (!upstream) return publish(root, branch)
  // Always both: the behind count is only as fresh as the last fetch.
  await git(root, ['pull', '--no-edit'])
  await git(root, ['push'])
}

export async function pull(root: string): Promise<void> {
  const { upstream } = await currentBranch(root, 'pull')
  if (!upstream) throw new Error('The branch has no upstream to pull from. Publish it first.')
  await git(root, ['pull', '--no-edit'])
}

/** Push; a branch with no upstream is published. */
export async function push(root: string): Promise<void> {
  const { branch, upstream } = await currentBranch(root, 'push')
  await (upstream ? git(root, ['push']) : publish(root, branch))
}

export async function fetch(root: string): Promise<void> {
  await git(root, ['fetch'])
}

/**
 * Watch a repository for changes, git's own (a commit from the terminal) and
 * the files', and call `onChange` once they settle. Returns how to stop.
 */
export function watchRepo(root: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watch(root, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(onChange, 300)
    })
    // A folder that goes away ends the watch; the panel still refreshes on focus.
    watcher.on('error', () => watcher?.close())
  } catch (error) {
    console.error(`Could not watch ${root} for changes:`, error)
  }
  return () => {
    clearTimeout(timer)
    watcher?.close()
  }
}
