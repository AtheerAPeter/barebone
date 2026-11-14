import { homedir, userInfo } from 'node:os'
import { spawn, type IPty } from 'node-pty'
import type { TerminalInfo } from '../shared/types'
import { handle, handleAs, listen, onCallerGone, type Caller } from './remote/registry'
import { loadShellPath } from './shell-env'

/**
 * Terminals: the user's shell in a pty, run by the app, so they keep running
 * whichever view shows them, and the window and the remote link's pages show
 * the same ones. A view that opens later gets what each printed lately, then
 * what it prints from then on.
 */

/** What each terminal keeps of its output for a view that opens later, in characters. */
const BACKLOG = 256 * 1024
/** Output is sent this often at most, gathered: a busy program prints in many small pieces. */
const FLUSH_MS = 8
const MAX_COLS = 1000
const MAX_ROWS = 500

interface Terminal {
  info: TerminalInfo
  pty: IPty
  backlog: string
  /** Printed since it was last sent. */
  pending: string
  flush?: ReturnType<typeof setTimeout>
}

export class Terminals {
  private terminals = new Map<string, Terminal>()
  /** Pages of the remote link that show the terminals; the window is always told. */
  private watchers = new Set<Caller>()
  private nextId = 1

  constructor(
    private host: {
      /** Tell the window. */
      toWindow(channel: string, ...args: unknown[]): void
      /** Tell one page of the remote link. */
      toPage(caller: Caller, channel: string, args: unknown[]): void
    }
  ) {}

  register(): void {
    handle('terminal:list', () => this.list())
    handle('terminal:open', (cols: unknown, rows: unknown) => this.open(cols, rows))
    handle('terminal:close', (id: unknown) => this.terminals.get(str(id))?.pty.kill())
    // A view shows the terminals: it gets what each printed lately.
    handleAs('terminal:watch', (caller, on: unknown) => {
      if (caller !== 'window') {
        if (on === true) this.watchers.add(caller)
        else this.watchers.delete(caller)
      }
      return [...this.terminals.values()].map((t) => ({ ...this.infoOf(t), backlog: t.backlog }))
    })
    listen('terminal:write', (id: unknown, data: unknown) => {
      this.terminals.get(str(id))?.pty.write(str(data).slice(0, 64 * 1024))
    })
    // The last view to change size sets it: a shell has one size.
    listen('terminal:resize', (id: unknown, cols: unknown, rows: unknown) => {
      this.terminals.get(str(id))?.pty.resize(side(cols, MAX_COLS), side(rows, MAX_ROWS))
    })
    onCallerGone((caller) => this.watchers.delete(caller))
  }

  /** End every terminal, as the app quits. */
  stop(): void {
    for (const terminal of this.terminals.values()) terminal.pty.kill()
  }

  private list(): TerminalInfo[] {
    return [...this.terminals.values()].map((t) => this.infoOf(t))
  }

  private infoOf(terminal: Terminal): TerminalInfo {
    // The program in front, which changes as the user runs one; the Mac gives its path.
    const program = terminal.pty.process.split('/').pop()
    return { id: terminal.info.id, title: program || terminal.info.title }
  }

  private async open(cols: unknown, rows: unknown): Promise<TerminalInfo> {
    // The PATH the user's login shell has, as the agents get it.
    await loadShellPath()
    const shell = process.env.SHELL || userInfo().shell || '/bin/bash'
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: side(cols, MAX_COLS),
      rows: side(rows, MAX_ROWS),
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >
    })
    const id = String(this.nextId++)
    const terminal: Terminal = {
      info: { id, title: shell.split('/').pop() ?? 'shell' },
      pty,
      backlog: '',
      pending: ''
    }
    this.terminals.set(id, terminal)
    pty.onData((data) => {
      terminal.backlog = (terminal.backlog + data).slice(-BACKLOG)
      terminal.pending += data
      terminal.flush ??= setTimeout(() => this.flush(terminal), FLUSH_MS)
    })
    pty.onExit(() => {
      clearTimeout(terminal.flush)
      this.flush(terminal)
      this.terminals.delete(id)
      this.tell('terminal:exit', id)
      this.tell('terminal:list', this.list())
    })
    this.tell('terminal:list', this.list())
    return this.infoOf(terminal)
  }

  private flush(terminal: Terminal): void {
    terminal.flush = undefined
    if (!terminal.pending) return
    const data = terminal.pending
    terminal.pending = ''
    this.tell('terminal:data', terminal.info.id, data)
  }

  private tell(channel: string, ...args: unknown[]): void {
    this.host.toWindow(channel, ...args)
    for (const caller of this.watchers) this.host.toPage(caller, channel, args)
  }
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Bad request.')
  return value
}

/** A number of columns or rows, kept to what a terminal can be. */
function side(value: unknown, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 80
  return Math.min(max, Math.max(2, n))
}
