import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { LimitWindow, UsageLimits } from '../shared/types'

/**
 * What the account a chat runs on has used and has left (UsageLimits), shown
 * under the composer. Each agent is asked in the way its maker provides:
 *
 * - Claude Code: the Agent SDK's usage read, the data behind its /usage
 *   command, from the user's own `claude` (claudeLimits).
 * - Codex: the app server's account/rateLimits/read, from the user's own
 *   `codex` (codexLimits).
 * - The harness's providers: their own limits(), where the provider has a
 *   documented call (harness/provider.ts).
 *
 * OpenCode, Cline's CLI and Command Code have no such call, so their chats show none.
 */

/** Where an account's limits come from: one key per account, so chats on it share one read. */
export interface LimitsAccount {
  key: string
  read(): Promise<UsageLimits | undefined>
}

/** How long a read is shown before it is read again. */
const MAX_AGE_MS = 2 * 60_000
/** How long a CLI may take to answer. */
const TIMEOUT_MS = 20_000

export class Limits {
  private readonly reads = new Map<
    string,
    { at: number; value: Promise<UsageLimits | undefined> }
  >()

  constructor(
    private readonly accountOf: (chatId: string) => Promise<LimitsAccount | undefined>,
    /** Tell the window that limits may have changed, so it asks again. */
    private readonly changed: () => void
  ) {}

  /** The limits of the account the chat runs on; null when it reports none. */
  async forChat(chatId: string): Promise<UsageLimits | null> {
    const account = await this.accountOf(chatId).catch(() => undefined)
    if (!account) return null
    let read = this.reads.get(account.key)
    if (!read || Date.now() - read.at > MAX_AGE_MS) {
      read = {
        at: Date.now(),
        value: account.read().catch((error: Error) => {
          console.error(`[limits] ${account.key}:`, error.message)
          return undefined
        })
      }
      this.reads.set(account.key, read)
    }
    return (await read.value) ?? null
  }

  /** A turn used some of the chat's account: read it again when next asked. */
  async turnEnded(chatId: string): Promise<void> {
    const account = await this.accountOf(chatId).catch(() => undefined)
    if (!account) return
    this.reads.delete(account.key)
    this.changed()
  }
}

/** "$4.20", "¥110.00". */
export function money(amount: number, currency = 'USD'): string {
  return amount.toLocaleString('en-US', { style: 'currency', currency })
}

const capitalized = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

// --- Claude Code --------------------------------------------------------------

interface ClaudeWindow {
  utilization: number | null
  resets_at: string | null
}

/**
 * The plan's windows as Claude Code's /usage reports them, through the Agent
 * SDK (usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET, the call the
 * Claude Code adapter's /usage uses too): a session that is sent no prompt,
 * so it costs nothing, asked for the plan's limits only, then closed. Nothing
 * for an API key or a cloud provider, where plan limits do not apply. The
 * answer is checked here, since the SDK says it may change.
 */
export async function claudeLimits(executable: string): Promise<UsageLimits | undefined> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const session = query({
    // Input that never comes: the session only answers the usage request.
    prompt: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) },
    options: {
      pathToClaudeCodeExecutable: executable,
      cwd: homedir(),
      // No settings, hooks or MCP servers: only the sign-in is needed.
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {}
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Claude Code did not report its usage.')),
        TIMEOUT_MS
      )
    })
    const usage = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      timeout
    ])
    const limits = usage?.rate_limits
    if (!usage?.rate_limits_available || !limits) return undefined
    const windows: LimitWindow[] = []
    const add = (name: string, window: ClaudeWindow | null | undefined): void => {
      if (typeof window?.utilization !== 'number') return
      windows.push({
        name,
        usedPercent: window.utilization,
        resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined
      })
    }
    add('5-hour', limits.five_hour)
    add('Weekly', limits.seven_day)
    add('Weekly Opus', limits.seven_day_opus)
    add('Weekly Sonnet', limits.seven_day_sonnet)
    for (const scoped of limits.model_scoped ?? []) add(`Weekly ${scoped.display_name}`, scoped)
    const extra = limits.extra_usage
    if (extra?.is_enabled && typeof extra.utilization === 'number') {
      windows.push({ name: 'Extra usage this month', usedPercent: extra.utilization })
    }
    const plan = usage.subscription_type ? ` ${capitalized(usage.subscription_type)}` : ''
    return { account: `Claude${plan}`, windows }
  } finally {
    clearTimeout(timer)
    session.close()
  }
}

// --- Codex ----------------------------------------------------------------------

interface CodexWindow {
  usedPercent: number
  windowDurationMins: number | null
  /** Seconds since the epoch. */
  resetsAt: number | null
}

interface CodexSnapshot {
  limitId: string | null
  limitName: string | null
  primary: CodexWindow | null
  secondary: CodexWindow | null
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  planType: string | null
}

/**
 * The ChatGPT plan's Codex limits from the app server of the user's own
 * `codex` (https://learn.chatgpt.com/docs/app-server): account/read, then
 * account/rateLimits/read. Nothing when Codex is signed in with an API key,
 * which has no plan limits.
 */
export async function codexLimits(executable: string): Promise<UsageLimits | undefined> {
  const server = appServer(executable)
  try {
    await server.request('initialize', {
      clientInfo: { name: 'barebone', title: null, version: '1' },
      capabilities: null
    })
    server.notify('initialized', {})
    const { account } = await server.request<{
      account: { type: string; planType?: string } | null
    }>('account/read', {})
    if (account?.type !== 'chatgpt') return undefined
    const read = await server.request<{
      rateLimits: CodexSnapshot
      rateLimitsByLimitId: Record<string, CodexSnapshot | undefined> | null
    }>('account/rateLimits/read', undefined)
    const snapshots = Object.values(read.rateLimitsByLimitId ?? {}).filter(
      (s): s is CodexSnapshot => s !== undefined
    )
    if (snapshots.length === 0) snapshots.push(read.rateLimits)
    const windows: LimitWindow[] = []
    let balance: string | undefined
    for (const snapshot of snapshots) {
      // The main limit is Codex's own; others (a model's) are named.
      const prefix =
        snapshot.limitId && snapshot.limitId !== 'codex'
          ? `${snapshot.limitName ?? snapshot.limitId} `
          : ''
      for (const window of [snapshot.primary, snapshot.secondary]) {
        if (!window) continue
        windows.push({
          name: `${prefix}${codexWindowName(window.windowDurationMins)}`,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt ? window.resetsAt * 1000 : undefined
        })
      }
      const credits = snapshot.credits
      if (!balance && credits?.hasCredits && !credits.unlimited && credits.balance) {
        balance = `${Math.floor(Number(credits.balance)).toLocaleString('en-US')} credits`
      }
    }
    const plan = account.planType ? ` ${capitalized(account.planType)}` : ''
    return { account: `ChatGPT${plan}`, windows, balance }
  } finally {
    server.close()
  }
}

/** "5-hour", "Weekly", "Daily", "2-day". */
function codexWindowName(minutes: number | null): string {
  if (minutes === 10_080) return 'Weekly'
  if (minutes === 1440) return 'Daily'
  if (!minutes) return 'Usage'
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`
  return `${Math.round(minutes / 60)}-hour`
}

interface AppServer {
  request<T>(method: string, params: unknown): Promise<T>
  notify(method: string, params: unknown): void
  close(): void
}

/** `codex app-server`: JSON-RPC over stdio, one message per line, without the "jsonrpc" field. */
function appServer(executable: string): AppServer {
  const child = spawn(executable, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const failAll = (error: Error): void => {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }
  child.on('error', failAll)
  // Writing to a server that has stopped; the exit below reports it.
  child.stdin.on('error', () => {})
  child.on('exit', () => failAll(new Error('Codex stopped before it answered.')))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    // Notifications have no id; only answers are waited for.
    const waiting = message.id === undefined ? undefined : pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id!)
    if (message.error) waiting.reject(new Error(message.error.message ?? 'Codex refused.'))
    else waiting.resolve(message.result)
  })
  const timer = setTimeout(() => {
    failAll(new Error('Codex did not report its limits.'))
    child.kill()
  }, TIMEOUT_MS)
  let next = 0
  const write = (message: object): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  return {
    request: <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = next++
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        write({ method, id, params })
      }),
    notify: (method, params) => write({ method, params }),
    close: () => {
      clearTimeout(timer)
      child.kill()
    }
  }
}
