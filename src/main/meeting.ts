import { app, ipcMain, type IpcMainEvent } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  MEETING_LANGUAGES,
  type Attachment,
  type ChatSender,
  type MeetingLanguage,
  type MeetingState,
  type SpeechStop,
  type SpokenAudio
} from '../shared/types'
import type { AgentManager } from './agents'
import type { BuiltinBrowser, ChatPage } from './browser'
import { LISTEN_MODELS } from './meeting-models'
import { downloadFiles, haveFiles, totalSize } from './models'
import type { Speech } from './speech'
import { isPocketLanguage } from './speech/pocket-voices'
import * as store from './store'

/**
 * The chat's agent in a Google Meet call, one call at a time. The user opens
 * the call in the browser panel and lets the AI join; the tab then gives the
 * page the AI's microphone and ears (preload/meeting.ts). What the call says
 * is transcribed on this Mac by Moonshine (native/listen) and comes to the
 * agent as messages from the meeting: when someone says its name, when the
 * user writes in the chat, and when the call ends, each with what was said
 * since the last and a screenshot of the call. The agent answers with the
 * speak tool, whose voice goes into the call (Pocket where it speaks the
 * language), and sees and acts in the call with the browser tools.
 */

type Why = Extract<ChatSender, { kind: 'meeting' }>['why']

/** A line someone said, with when it began (ms since the epoch). */
interface Line {
  text: string
  at: number
}

interface Session {
  chatId: string
  tab: ChatPage
  language: MeetingLanguage
  name: string
  status: MeetingState['status']
  download?: MeetingState['download']
  /** Stops its download when it ends first. */
  abort: AbortController
  listener?: ChildProcessWithoutNullStreams
  /** When the listener was given its first audio: its lines' times count from here. */
  heardFrom?: number
  /** Said since the agent last heard. */
  pending: Line[]
  /** What the agent was saying when someone talked over it, since it last heard. */
  cutOff: string[]
  /** Set once it is ending, so it ends once. */
  ending: boolean
  /** Stop following the tab's navigations. */
  detach?: () => void
}

/** How long the listener gets to write out its last lines once the call is over. */
const LAST_LINES_MS = 5000

const listenDir = (): string => join(app.getPath('userData'), 'meeting', 'listen')

/** The speech-to-text program: in the app's Resources, or as `npm run build:listen` builds it. */
function listenerPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'barebone-listen')
    : join(app.getAppPath(), 'native/listen/.build/release/barebone-listen')
}

const label = (language: MeetingLanguage): string =>
  MEETING_LANGUAGES.find((l) => l.code === language)!.label

/** Text compared for a name: case, accents and width set aside. */
const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/** Whether a line says the name as a word of its own, in any script. */
function names(text: string, name: string): boolean {
  const escaped = fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(fold(text))
}

const clock = (at: number): string => new Date(at).toLocaleTimeString('en-GB', { hour12: false })

export class Meetings {
  private session?: Session

  constructor(
    private readonly deps: {
      browser: BuiltinBrowser
      agents: AgentManager
      speech: Speech
      /** The meeting, for the window; null when there is none. */
      state: (state: MeetingState | null) => void
      /** Tell the user something in a chat, as a notice. */
      notice: (chatId: string, text: string) => void
    }
  ) {
    ipcMain.on('meeting:heard', (event, samples: unknown) => this.heard(event, samples))
    ipcMain.on('meeting:ended', (event) => {
      if (this.inCall(event)) void this.finish('ended')
    })
    ipcMain.on('meeting:played', (event, id: string, what: 'begun' | 'ended') => {
      if (!this.inCall(event)) return
      if (what === 'begun') deps.speech.begun(id)
      else deps.speech.ended(id)
    })
  }

  state(): MeetingState | null {
    const s = this.session
    if (!s) return null
    return {
      chatId: s.chatId,
      tabId: s.tab.id,
      language: s.language,
      name: s.name,
      status: s.status,
      ...(s.download ? { download: s.download } : {})
    }
  }

  /**
   * Let the chat's agent join the call open in one of its tabs. Throws why it
   * cannot. Its models download first, the first time a language is used.
   */
  join(chatId: string, tabId: string, language: MeetingLanguage, rawName: string): void {
    const name = rawName.trim()
    if (this.session) {
      throw new Error('The AI is in a meeting already. Let it leave that one first.')
    }
    if (!MEETING_LANGUAGES.some((l) => l.code === language)) {
      throw new Error(`Meetings can't be in "${language}".`)
    }
    if (!name || name.includes(',')) {
      throw new Error('Give the AI a name to answer to, without commas.')
    }
    if (!store.speechOn()) {
      throw new Error('Turn on the voice in Settings first: the AI speaks in the meeting with it.')
    }
    if (!isPocketLanguage(language) && this.deps.speech.status().state !== 'ready') {
      throw new Error(
        `The AI speaks ${label(language)} with the voice in Settings, which is not downloaded yet.`
      )
    }
    const tab = this.deps.browser.tabs(chatId).tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error('That tab is closed.')
    if (new URL(tab.contents.getURL() || 'about:blank').hostname !== 'meet.google.com') {
      throw new Error('Open the Google Meet call in this tab first.')
    }
    store.setMeeting({ language, name })
    const session: Session = {
      chatId,
      tab,
      language,
      name,
      status: 'preparing',
      abort: new AbortController(),
      pending: [],
      cutOff: [],
      ending: false
    }
    this.session = session
    // The page loads again, now with the AI's microphone: the meeting's
    // pre-join screen asks for one as it loads.
    this.deps.browser.setMeeting(tab, true, true)
    this.deps.speech.setMeeting(chatId)
    tab.contents.once('destroyed', () => {
      if (this.session === session) void this.finish('closed')
    })
    // A reload stays in the meeting (its page can join the call again); a page
    // of another site cannot be in the call.
    const navigated = (_event: unknown, url: string): void => {
      if (new URL(url).hostname !== 'meet.google.com') void this.finish('ended')
    }
    tab.contents.on('did-navigate', navigated)
    session.detach = () => tab.contents.off('did-navigate', navigated)
    this.emit()
    void this.prepare(session)
  }

  /** The user takes the AI out of the call: its tab loads again, which leaves it. */
  leave(chatId: string): void {
    if (this.session?.chatId === chatId) void this.finish('left')
  }

  /** The chat was deleted: its meeting ends, with no one to tell. */
  forget(chatId: string): void {
    if (this.session?.chatId === chatId) void this.finish('forgotten')
  }

  /** Quitting: the listener stops with the app. */
  dispose(): void {
    this.session?.listener?.kill()
  }

  /**
   * Before the user's message to the chat in the meeting goes to its agent:
   * what was said since it last heard goes first, so it reads them in order.
   */
  async beforeUserMessage(chatId: string): Promise<void> {
    const s = this.session
    if (s?.chatId === chatId && s.status === 'live') await this.wake(s, 'user')
  }

  /**
   * Play a piece of what the chat in the meeting says into the call. False
   * when the chat is in none: it plays to the user then, in the window.
   */
  play(audio: SpokenAudio): boolean {
    const s = this.session
    if (!s || audio.chatId !== s.chatId || s.tab.contents.isDestroyed()) return false
    const { id, samples, sampleRate, last } = audio
    s.tab.contents.send('meeting:play', { id, samples, sampleRate, last })
    return true
  }

  /** Stop playing into the call what speech/index.ts stops. */
  stop(which: SpeechStop): void {
    const s = this.session
    if (!s || s.tab.contents.isDestroyed()) return
    if (which.chatId === undefined || which.chatId === s.chatId)
      s.tab.contents.send('meeting:stop', which)
  }

  /** What the call says, 16 kHz, from its page: to the listener, once it listens. */
  private heard(event: IpcMainEvent, samples: unknown): void {
    const s = this.session
    if (!s || !this.inCall(event) || s.status !== 'live' || s.ending || !s.listener) return
    if (!ArrayBuffer.isView(samples)) return
    s.heardFrom ??= Date.now()
    s.listener.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
  }

  /** Whether a message comes from the call's page. */
  private inCall(event: IpcMainEvent): boolean {
    return this.session !== undefined && event.sender === this.session.tab.contents
  }

  private emit(): void {
    this.deps.state(this.state())
  }

  /** Download what the language needs, those files not here yet, then start listening. */
  private async prepare(s: Session): Promise<void> {
    const model = LISTEN_MODELS[s.language]
    const pocket = this.deps.speech.pocketFiles(s.language)
    if (!haveFiles(listenDir(), model.files) || !this.deps.speech.pocketReady(s.language)) {
      const total = totalSize(model.files) + totalSize(pocket)
      let listened = 0
      let lastEmit = 0
      const progress = (received: number): void => {
        s.download = { received, total }
        if (Date.now() - lastEmit < 200) return
        lastEmit = Date.now()
        this.emit()
      }
      try {
        await downloadFiles(listenDir(), model.files, s.abort.signal, (n) =>
          progress((listened = n))
        )
        if (isPocketLanguage(s.language)) {
          await this.deps.speech.fetchPocket(s.language, s.abort.signal, (n) =>
            progress(listened + n)
          )
        }
      } catch (error) {
        if (this.session !== s) return
        this.deps.notice(
          s.chatId,
          `The AI could not join the meeting: its models did not download (${(error as Error).message}).`
        )
        void this.finish('failed')
        return
      }
      s.download = undefined
    }
    if (this.session !== s) return
    this.listen(s, join(listenDir(), model.dir), model.arch)
  }

  /** Start the speech-to-text program; the agent is told to join once it is ready. */
  private listen(s: Session, modelDir: string, arch: string): void {
    let listener: ChildProcessWithoutNullStreams
    try {
      listener = spawn(listenerPath(), [modelDir, arch, s.name])
    } catch (error) {
      this.deps.notice(s.chatId, `The AI could not start listening: ${(error as Error).message}`)
      void this.finish('failed')
      return
    }
    s.listener = listener
    let failure: string | undefined
    listener.on('error', (error) => (failure = error.message))
    // Its stdin closes when it ends; what was still being written then is of no use.
    listener.stdin.on('error', () => undefined)
    listener.stderr.on('data', (data: Buffer) => console.error('[listen]', data.toString().trim()))
    createInterface({ input: listener.stdout }).on('line', (line) => {
      let event: { type: string; text?: string; start?: number; message?: string }
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type === 'ready') this.live(s)
      else if (event.type === 'started' && !s.ending) this.someoneSpeaks(s)
      else if (event.type === 'completed' && event.text) {
        s.pending.push({
          text: event.text,
          at: (s.heardFrom ?? Date.now()) + (event.start ?? 0) * 1000
        })
        // The last lines, written out as the meeting ends, go with its end.
        if (!s.ending && names(event.text, s.name)) void this.wake(s, 'named')
      } else if (event.type === 'error') failure = event.message
    })
    listener.on('exit', (code) => {
      if (this.session !== s || s.ending) return
      this.deps.notice(
        s.chatId,
        `The AI stopped listening to the meeting${failure ? `: ${failure}` : code ? ` (exit code ${code})` : ''}, so it left the call.`
      )
      void this.finish('failed')
    })
  }

  /** Listening: the agent is told to join the call. */
  private live(s: Session): void {
    if (this.session !== s) return
    s.status = 'live'
    this.emit()
    const code = s.language
    const tab = s.tab.id
    const text = [
      `The user asked you to join the Google Meet call in tab ${tab} of your browser, as their AI assistant. People in the call will call you "${s.name}". The call is in ${label(code)}.`,
      '',
      'Join it now:',
      `1. Tab ${tab} shows Meet's screen before the call. If another Google account than the user's is signed in, named "${s.name}" or close to it, switch to it with the account switcher there, so people can tell you from the user. With no such account, join with the one shown.`,
      '2. Leave the camera off. The microphone is ready, and it is only your voice. Click "Join now", or "Ask to join" and wait to be let in.',
      `3. Once in, say with speak, in one or two short sentences, that you are the user's AI assistant and people can talk to you by saying "${s.name}".`,
      '',
      'While you are in the call:',
      `- What people say comes to you as messages from the meeting: when someone says "${s.name}", when the user writes to you, and when the call ends. Each has what was said since the last one, with the time, and a screenshot of the call. Who said each line is not written: tell from the screenshot and what is said, and say "someone" when you cannot tell.`,
      `- speak talks into the call, not to the user. Use language "${code}". Keep it to one to three short, plain sentences: no lists, code, links or markdown. Answer what you were asked. When no one asked you anything, say nothing: end your turn.`,
      '- Someone talking over you stops your voice. The next message tells you what was not heard.',
      `- Look at the call whenever it helps, with a screenshot of tab ${tab}. Share links or text in Meet's chat.`,
      '- What you write in this chat is for the user only; the call does not see it.',
      '- When the call ends you are told. Then write the user a summary here: what was decided, open questions, and who does what.'
    ].join('\n')
    this.deps.agents.fromMeeting(s.chatId, text, [], 'joined')
  }

  /** Someone began a line: if the AI is talking, it stops, as a person would. */
  private someoneSpeaks(s: Session): void {
    const saying = this.deps.speech.saying(s.chatId)
    if (saying.length === 0) return
    s.cutOff.push(...saying)
    this.deps.speech.stop(s.chatId)
  }

  /** Bring the agent what was said since it last heard, with a screenshot of the call. */
  private async wake(s: Session, why: Why): Promise<void> {
    const lines = s.pending.splice(0)
    const cutOff = s.cutOff.splice(0)
    if (why === 'user' && lines.length === 0 && cutOff.length === 0) return
    const over = why === 'ended' || why === 'left'
    const parts: string[] = []
    if (lines.length > 0) {
      parts.push(
        `What was said in the call, ${clock(lines[0].at)} to ${clock(lines.at(-1)!.at)}:`,
        ...lines.map((line) => `${clock(line.at)}  ${line.text}`)
      )
    } else {
      parts.push('Nothing was said in the call since you last heard.')
    }
    if (cutOff.length > 0) {
      parts.push(
        '',
        `Someone talked over you while you were saying: "${cutOff.join(' ')}". The rest of it was not heard.`
      )
    }
    parts.push(
      '',
      why === 'named'
        ? `Someone said your name, "${s.name}". If you were asked something, answer with speak; if not, say nothing.`
        : why === 'user'
          ? 'That was the call up to now. The user wrote to you next.'
          : `${why === 'ended' ? 'The call ended.' : 'The user took you out of the call.'} Write them a summary of it here: what was decided, open questions, and who does what. Do not use speak: you are no longer in the call.`
    )
    const attachments: Attachment[] = []
    // The call's page is gone once it is over.
    if (!over && !this.deps.browser.windowHidden && !s.tab.contents.isDestroyed()) {
      try {
        attachments.push({
          name: 'call.png',
          mimeType: 'image/png',
          data: await s.tab.driver.screenshot()
        })
      } catch (error) {
        console.error('[meeting] no screenshot of the call:', (error as Error).message)
      }
    }
    this.deps.agents.fromMeeting(s.chatId, parts.join('\n'), attachments, why)
  }

  /**
   * End the meeting: the listener writes out its last lines, the agent hears
   * them (unless the meeting never began or the chat is gone), and the tab
   * is itself again. When the user takes the AI out, or it failed, the tab
   * loads again, which leaves the call.
   */
  private async finish(
    reason: 'ended' | 'left' | 'closed' | 'failed' | 'forgotten'
  ): Promise<void> {
    const s = this.session
    if (!s || s.ending) return
    s.ending = true
    s.detach?.()
    s.abort.abort()
    this.deps.speech.stop(s.chatId)
    const listener = s.listener
    if (listener && listener.exitCode === null) {
      const exited = new Promise<void>((resolve) => listener.once('exit', () => resolve()))
      listener.stdin.end()
      const timer = setTimeout(() => listener.kill(), LAST_LINES_MS)
      await exited
      clearTimeout(timer)
    }
    this.session = undefined
    this.deps.speech.setMeeting(undefined)
    if (!s.tab.contents.isDestroyed()) {
      this.deps.browser.setMeeting(s.tab, false, reason === 'left' || reason === 'failed')
    }
    this.emit()
    if (s.status === 'live' && reason !== 'forgotten' && reason !== 'failed') {
      await this.wake(s, reason === 'left' ? 'left' : 'ended')
    }
    this.deps.browser.prune()
  }
}
