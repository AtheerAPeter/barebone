import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  DiffHunk,
  DiffLine,
  GitBranch,
  GitChange,
  GitChangeKind,
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
  try {
    return await readFile(join(root, path), 'utf8')
  } catch {
    return ''
  }
}

/**
 * A file's changes: staged (the index against the last commit) or unstaged
 * (the working tree against the index), with the file before and after.
 */
export async function diff(
  root: string,
  file: GitChange,
  staged: boolean
): Promise<{ old: string; new: string; hunks: DiffHunk[]; binary: boolean }> {
  if (file.kind === 'untracked') {
    const text = await worktree(root, file.path)
    if (text.includes('\0')) return { old: '', new: '', hunks: [], binary: true }
    const count = lineCount(text)
    const lines: DiffLine[] = Array.from({ length: count }, (_, n) => ({ type: 'add', new: n + 1 }))
    return { old: '', new: text, hunks: count ? [{ skipped: 0, lines }] : [], binary: false }
  }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const [patch, before, after] = await Promise.all([
    git(root, [
      'diff',
      ...(staged ? ['--cached'] : []),
      '--no-color',
      '--no-ext-diff',
      '--find-renames',
      '-U3',
      '--',
      ...paths
    ]),
    staged ? show(root, `HEAD:${file.oldPath ?? file.path}`) : show(root, `:${file.path}`),
    staged ? show(root, `:${file.path}`) : worktree(root, file.path)
  ])
  if (/^Binary files .* differ$/m.test(patch)) return { old: '', new: '', hunks: [], binary: true }
  return { old: before, new: after, hunks: parseHunks(patch), binary: false }
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

/** Commit what is staged, or every change first when `all`. */
export async function commit(root: string, message: string, all: boolean): Promise<void> {
  if (all) await git(root, ['add', '--all'])
  // From stdin, so the message reaches git exactly as written, any length or lines.
  await git(root, ['commit', '--file=-'], message)
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

/** Pull, then push: what VS Code's Sync Changes does. A branch with no upstream is published. */
export async function sync(root: string): Promise<void> {
  const current = await status(root)
  if (!current.repo) throw new Error('This folder is not in a git repository.')
  if (!current.branch) throw new Error('Check out a branch to sync: HEAD is detached.')
  if (!current.upstream) {
    const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean)
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    if (!remote) throw new Error('This repository has no remote to publish the branch to.')
    await git(root, ['push', '--set-upstream', remote, current.branch])
    return
  }
  // Always both: the behind count is only as fresh as the last fetch.
  await git(root, ['pull', '--no-edit'])
  await git(root, ['push'])
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
