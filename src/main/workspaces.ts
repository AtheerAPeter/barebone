import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { ChatItem, ChatWorkspace, CodeReview } from '../shared/types'
import { remoteUrl, repoRoot, status, worktreeOf } from './git'

/**
 * Where a chat works: the git checkouts its tool calls went to, newest first,
 * and its project's. An agent often works in a worktree it made for a branch,
 * or in another repository, which the chat's own folder does not say. Each
 * comes with its branch, whether it is a worktree, its changes, and the merge
 * or pull request open for its branch.
 */

/** The tool calls read for folders, from the newest back. */
const RECENT_CALLS = 300
/** The most checkouts shown. */
const MAX_WORKSPACES = 5
/** How long a branch's merge or pull request is kept before it is asked for again. */
const REVIEW_TTL_MS = 2 * 60_000
/** How long glab or gh may take to answer. */
const REVIEW_TIMEOUT_MS = 8_000

/** Keys of a call's input that name a file or folder. */
const PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'notebook_path',
  'path',
  'cwd',
  'workdir',
  'directory'
])

/** Folders a shell command moves to or runs git in: `cd <dir>` and `git -C <dir>`. */
const COMMAND_DIRS = [
  /(?:^|[;&|(]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g,
  /\bgit\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g
]

/** The repository each folder is in, null for none: folders do not move between repositories. */
const roots = new Map<string, string | null>()
/** Merge and pull requests by checkout and branch, with when they were asked for. */
const reviews = new Map<string, { at: number; review: Promise<CodeReview | undefined> }>()

export async function chatWorkspaces(
  projectPath: string,
  items: ChatItem[]
): Promise<ChatWorkspace[]> {
  // Checkouts by when the chat last worked in them, the newest first.
  const found: string[] = []
  const calls = items.filter((item) => item.kind === 'tool').slice(-RECENT_CALLS)
  for (const call of calls.reverse()) {
    for (const folder of foldersOf(call, projectPath)) {
      const root = await rootOf(folder)
      if (root && !found.includes(root)) found.push(root)
    }
    if (found.length >= MAX_WORKSPACES) break
  }
  const projectRoot = await rootOf(projectPath)
  if (projectRoot && !found.includes(projectRoot)) found.push(projectRoot)
  const workspaces = await Promise.all(
    found
      .slice(0, MAX_WORKSPACES)
      .map((root, index) => workspace(root, index === 0 && calls.length > 0))
  )
  return workspaces.filter((w): w is ChatWorkspace => w !== undefined)
}

async function workspace(root: string, current: boolean): Promise<ChatWorkspace | undefined> {
  try {
    const read = await status(root)
    if (!read.repo) return undefined
    return {
      root,
      branch: read.branch,
      head: read.head,
      worktreeOf: await worktreeOf(root).catch(() => undefined),
      changes: read.staged.length + read.unstaged.length + read.conflicts.length,
      ahead: read.ahead,
      behind: read.behind,
      upstream: read.upstream,
      review: read.branch ? await reviewOf(root, read.branch) : undefined,
      current
    }
  } catch {
    // A worktree removed since the call, or a repository git cannot read.
    return undefined
  }
}

/** The folders a tool call worked in: the files it named, and where its command went. */
function foldersOf(call: Extract<ChatItem, { kind: 'tool' }>, projectPath: string): string[] {
  const paths: string[] = []
  let input: unknown
  try {
    input = call.input ? JSON.parse(call.input) : undefined
  } catch {
    input = undefined
  }
  if (input && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string' && PATH_KEYS.has(key)) paths.push(value)
      if (typeof value === 'string' && (key === 'command' || key === 'cmd')) {
        paths.push(...commandDirs(value))
      }
    }
  }
  // A command's title is the command itself (Claude Code's, Codex's).
  if (call.toolKind === 'execute') paths.push(...commandDirs(call.title))
  return paths.flatMap((path) => {
    const full = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
    const absolute = isAbsolute(full) ? full : join(projectPath, full)
    const folder = existingFolder(absolute)
    return folder ? [folder] : []
  })
}

function commandDirs(command: string): string[] {
  return COMMAND_DIRS.flatMap((pattern) =>
    [...command.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3])
  ).filter((dir) => !dir.includes('$'))
}

/** The folder of a path: itself, or the nearest folder above it that exists. */
function existingFolder(path: string): string | undefined {
  for (let at = path; at !== dirname(at); at = dirname(at)) {
    if (!existsSync(at)) continue
    return statSync(at).isDirectory() ? at : dirname(at)
  }
  return undefined
}

async function rootOf(folder: string): Promise<string | undefined> {
  if (!roots.has(folder)) roots.set(folder, (await repoRoot(folder)) ?? null)
  return roots.get(folder) ?? undefined
}

/** The merge or pull request of a branch, asked of glab or gh by where the repository is hosted. */
function reviewOf(root: string, branch: string): Promise<CodeReview | undefined> {
  const key = `${root}\0${branch}`
  const kept = reviews.get(key)
  if (kept && Date.now() - kept.at < REVIEW_TTL_MS) return kept.review
  const review = askReview(root, branch).catch(() => undefined)
  reviews.set(key, { at: Date.now(), review })
  return review
}

async function askReview(root: string, branch: string): Promise<CodeReview | undefined> {
  const url = await remoteUrl(root)
  if (!url) return undefined
  if (/github\.com[:/]/i.test(url)) {
    const [pr] = JSON.parse(
      await run(root, 'gh', [
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,url,state,isDraft'
      ])
    ) as { number: number; title: string; url: string; state: string; isDraft: boolean }[]
    if (!pr) return undefined
    const state = pr.state.toLowerCase()
    return {
      kind: 'pr',
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state:
        state === 'open'
          ? pr.isDraft
            ? 'draft'
            : 'open'
          : state === 'merged'
            ? 'merged'
            : 'closed'
    }
  }
  // Anything else is taken for GitLab: gitlab.com or a company's own.
  const [mr] = JSON.parse(
    await run(root, 'glab', [
      'mr',
      'list',
      '--source-branch',
      branch,
      '--all',
      '--per-page',
      '1',
      '--output',
      'json'
    ])
  ) as { iid: number; title: string; web_url: string; state: string; draft?: boolean }[]
  if (!mr) return undefined
  return {
    kind: 'mr',
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    state:
      mr.state === 'opened'
        ? mr.draft
          ? 'draft'
          : 'open'
        : mr.state === 'merged'
          ? 'merged'
          : 'closed'
  }
}

/** Run glab or gh in a checkout; it answers within REVIEW_TIMEOUT_MS or not at all. */
function run(cwd: string, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: REVIEW_TIMEOUT_MS,
        // Nobody can answer a prompt here.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  })
}
