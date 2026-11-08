import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AGENTS,
  modelOptions,
  type AgentCommand,
  type AgentId,
  type AgentOption,
  type AgentStatus,
  type Chat,
  type Skill,
  type Attachment
} from '../../../shared/types'
import { Picker } from './Picker'
import { EffortPicker } from './EffortPicker'
import { ModelPicker } from './model-picker/ModelPicker'
import { CompletionMenu, type CompletionItem } from './CompletionMenu'
import { uploadFile } from '../remote/upload'
import { touchScreen } from '../lib/touch'
import { addPrompt } from '../../../shared/prompt-history'
import { LevelMeter } from './LevelMeter'
import { writePref } from '../lib/prefs'
import { useVoiceInput, type VoiceState } from '../lib/voice'
import {
  CloseIcon,
  FileIcon,
  MicIcon,
  PencilIcon,
  PersonaIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
  StopIcon,
  TrashIcon
} from './icons'

interface ComposerProps {
  chat: Chat
  statuses: Partial<Record<AgentId, AgentStatus>>
  /** Undefined while the agent session is starting. */
  options?: AgentOption[]
  optionsError?: string
  commands: AgentCommand[]
  skills: Skill[]
  projectPath: string
  /** Switch agents, starting with the given settings (e.g. the model picked with it). */
  onAgentChange: (agent: AgentId, settings: Record<string, string>) => void
  onOptionChange: (optionId: string, value: string) => Promise<void>
  /** The chat is folded into the agent orb: dictation goes to the orb's input. */
  folded: boolean
  /** Voice input started, ended or is being written out, for the orb to show. */
  onVoiceChange: (state: VoiceState) => void
}

/** How much the agent may do without asking, per chat. */
const PERMISSION_MODES = [
  { value: 'ask', name: 'Ask', description: 'Every tool request asks you first' },
  {
    value: 'project',
    name: 'Auto in project',
    description: 'Runs inside the project; asks before touching anything outside'
  },
  { value: 'full', name: 'Full access', description: 'Runs every request without asking' }
]

function permissionMode(chat: Chat): string {
  if (!chat.bypassPermissions) return 'ask'
  return chat.projectOnly ? 'project' : 'full'
}

/**
 * @-tags. `@browser` tells the agent to work in the built-in browser panel;
 * `@chats` to split the work into new chats that report back.
 */
const TAGS: CompletionItem[] = [
  { name: 'browser', description: 'Use the built-in browser (keeps your logins)', kind: 'tag' },
  { name: 'chats', description: 'Split the work into new chats that report back', kind: 'tag' }
]

/** Text shorter than this gets no suggestion: too little to tell which prompt is meant. */
const SUGGEST_FROM = 3

/**
 * The rest of the line of the newest earlier prompt that starts with the
 * text, case aside. Only to the line's end, so a long prompt is taken a line
 * at a time instead of filling the composer.
 */
function promptSuggestion(history: string[], text: string): string {
  if (text.trim().length < SUGGEST_FROM) return ''
  const typed = text.toLowerCase()
  for (const prompt of history) {
    if (prompt.length <= text.length) continue
    // The prompt's start is cut before lowering, as some letters change length when lowered.
    if (prompt.slice(0, text.length).toLowerCase() !== typed) continue
    const line = prompt.slice(text.length).split('\n', 1)[0]
    if (line) return line
  }
  return ''
}

export function Composer({
  chat,
  statuses,
  options,
  optionsError,
  commands,
  skills,
  projectPath,
  onAgentChange,
  onOptionChange,
  folded,
  onVoiceChange
}: ComposerProps): React.JSX.Element {
  // ChatView is keyed by chat, so each chat's composer starts from its saved draft.
  const [text, setText] = useState(chat.draft ?? '')
  const [caret, setCaret] = useState(text.length)
  const [menuActive, setMenuActive] = useState(0)
  /** Set when the user closes the menu with Escape, for the text and caret at that moment. */
  const [menuDismissed, setMenuDismissed] = useState<string>()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const status = statuses[chat.agent]

  // What is being completed: `/name` at the very start, or `@tag` anywhere before the caret.
  const trigger = useMemo(() => {
    const before = text.slice(0, caret)
    const slash = before.match(/^\/(\S*)$/)
    if (slash) return { kind: 'slash' as const, query: slash[1], start: 0 }
    const mention = before.match(/(?:^|\s)@([^\s@]*)$/)
    if (mention)
      return { kind: 'mention' as const, query: mention[1], start: caret - mention[1].length - 1 }
    return undefined
  }, [text, caret])

  // Project files for @, re-read each time the @ menu opens so new files show up.
  const [files, setFiles] = useState<string[]>([])
  const mentioning = trigger?.kind === 'mention'
  useEffect(() => {
    if (!mentioning) return
    let cancelled = false
    window.api.listFiles(projectPath).then((list) => {
      if (!cancelled) setFiles(list)
    })
    return () => {
      cancelled = true
    }
  }, [mentioning, projectPath])

  const menuItems = useMemo((): CompletionItem[] => {
    if (!trigger) return []
    let all: CompletionItem[]
    if (trigger.kind === 'mention') {
      const q = trigger.query.toLowerCase()
      const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase()
      const matches = files
        .filter((path) => path.toLowerCase().includes(q))
        // File names that start with the query first, then shorter paths.
        .sort(
          (a, b) =>
            Number(!baseName(a).startsWith(q)) - Number(!baseName(b).startsWith(q)) ||
            a.length - b.length
        )
        .slice(0, 50)
        .map((path) => ({ name: path, description: '', kind: 'file' as const }))
      return [...TAGS.filter((t) => t.name.includes(q)), ...matches]
    } else {
      const commandNames = new Set(commands.map((c) => c.name))
      all = [
        ...commands.map((c) => ({ ...c, kind: 'command' as const })),
        ...skills
          // Codex lists each skill it found as a `$name` command.
          .filter((s) => !commandNames.has(s.name) && !commandNames.has(`$${s.name}`))
          .map((s) => ({ name: s.name, description: s.description, kind: 'skill' as const }))
      ]
    }
    const q = trigger.query.toLowerCase()
    return all
      .filter((item) => item.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)))
  }, [trigger, files, commands, skills])

  const menuOpen = trigger !== undefined && menuDismissed !== `${caret}:${text}`

  // What the user sent in this project's chats, for completing what they type.
  const [history, setHistory] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    window.api.promptHistory(chat.projectId).then((saved) => {
      // Anything sent before the history arrived stays on top of it.
      if (!cancelled) setHistory((sent) => sent.reduceRight(addPrompt, saved))
    })
    return () => {
      cancelled = true
    }
  }, [chat.projectId])
  /** Set when the user closes the suggestion with Escape, for the text at that moment. */
  const [suggestionDismissed, setSuggestionDismissed] = useState<string>()

  function choose(item: CompletionItem): void {
    if (!trigger) return
    const inserted = `${item.kind === 'tag' || item.kind === 'file' ? '@' : '/'}${item.name} `
    const next = text.slice(0, trigger.start) + inserted + text.slice(caret)
    const position = trigger.start + inserted.length
    setText(next)
    setCaret(position)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(position, position)
    })
  }

  useEffect(() => {
    // On a touch screen focus would open the keyboard over the chat just opened: it waits for a tap.
    if (touchScreen) return
    const el = textareaRef.current
    el?.focus()
    // After a restored draft, to go on typing.
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [chat.id])

  // The draft is saved shortly after typing stops, and at once when the chat is
  // left. That save goes out before App asks to delete the chat left if empty
  // (unmount effects run before App's effect), so a chat with a draft stays.
  const chatId = chat.id
  const savedDraft = useRef(text)
  const typedText = useRef(text)
  useEffect(() => {
    typedText.current = text
    if (text === savedDraft.current) return
    const timer = setTimeout(() => {
      savedDraft.current = text
      window.api.setDraft(chatId, text)
    }, 400)
    return () => clearTimeout(timer)
  }, [chatId, text])
  useEffect(
    () => () => {
      if (typedText.current !== savedDraft.current) window.api.setDraft(chatId, typedText.current)
    },
    [chatId]
  )

  /**
   * Set once the text wraps: it then takes its own row above the buttons, as
   * in ChatGPT, and keeps it until the composer is emptied.
   */
  const [expanded, setExpanded] = useState(false)

  /** The rest of an earlier prompt, shown after the caret for Tab to take. */
  const suggestion = useMemo(
    () =>
      !menuOpen && caret === text.length && suggestionDismissed !== text
        ? promptSuggestion(history, text)
        : '',
    [history, text, caret, menuOpen, suggestionDismissed]
  )
  /** Draws the suggestion behind the textarea, wrapped as the text is. */
  const suggestionRef = useRef<HTMLDivElement>(null)

  function acceptSuggestion(): void {
    const next = text + suggestion
    setText(next)
    setCaret(next.length)
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.length, next.length))
  }

  // Grow with content, the suggestion included, up to a limit.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const shown = suggestionRef.current
    el.style.height = 'auto'
    if (shown) shown.style.height = 'auto'
    const style = getComputedStyle(el)
    const oneLine =
      parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const content = Math.max(el.scrollHeight, shown?.scrollHeight ?? 0)
    const wraps = content > oneLine + 1
    setExpanded(el.value !== '' && (expanded || wraps))
    const height = `${Math.min(content, 240)}px`
    el.style.height = height
    if (shown) {
      shown.style.height = height
      shown.scrollTop = el.scrollTop
    }
  }, [text, expanded, suggestion])

  const [attachments, setAttachments] = useState<Attachment[]>([])
  /** Why files could not be sent to the Mac, through the remote link. */
  const [uploadError, setUploadError] = useState<string>()
  const [dragging, setDragging] = useState(false)

  // While the agent works, a message steers it (see AgentManager.wait).
  const canSend = (text.trim().length > 0 || attachments.length > 0) && status?.available !== false

  const addAttachments = (added: Attachment[]): void =>
    setAttachments((current) => [
      ...current,
      ...added.filter((a) => !a.path || !current.some((c) => c.path === a.path))
    ])

  /** Files from a paste or drop. Pasted screenshots have no path, so their data is read. */
  async function attachFiles(files: FileList): Promise<void> {
    // A browser through the remote link has no paths: the files go to the Mac first.
    if (window.api.remote) {
      try {
        addAttachments(await Promise.all(Array.from(files).map(uploadFile)))
      } catch (error) {
        setUploadError((error as Error).message)
      }
      return
    }
    const added: Attachment[] = []
    for (const file of Array.from(files)) {
      const path = window.api.pathForFile(file)
      if (path) {
        added.push({ name: file.name, path, mimeType: file.type || undefined })
      } else if (file.type.startsWith('image/')) {
        const data = await new Promise<string>((done) => {
          const reader = new FileReader()
          reader.onload = () => done(String(reader.result).split(',')[1] ?? '')
          reader.readAsDataURL(file)
        })
        added.push({ name: file.name || 'Pasted image', mimeType: file.type, data })
      }
    }
    addAttachments(added)
  }

  function submit(): void {
    if (!canSend) return
    window.api.send(chat.id, text.trim(), attachments)
    setHistory((current) => addPrompt(current, text))
    setText('')
    setAttachments([])
    setCaret(0)
  }

  /**
   * Put dictated text at the caret, as if typed there, with a space on each
   * side it needs one. With the chat folded away, it goes to the orb's input.
   */
  function insertSpoken(spoken: string): void {
    if (folded) return window.api.orb.draft(spoken)
    const el = textareaRef.current
    if (!el) return
    const before = el.value.slice(0, el.selectionEnd)
    const after = el.value.slice(el.selectionEnd)
    const inserted =
      (before && !/\s$/.test(before) ? ' ' : '') + spoken + (after && !/^\s/.test(after) ? ' ' : '')
    const position = before.length + inserted.length
    setText(before + inserted + after)
    setCaret(position)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(position, position)
    })
  }
  const voice = useVoiceInput(insertSpoken)
  useEffect(() => onVoiceChange(voice.state), [onVoiceChange, voice.state])
  // Talking over an agent that speaks: it stops, and does not end up in the recording.
  useEffect(() => {
    if (voice.state === 'recording') void window.api.speech.stop()
  }, [voice.state])
  // The orb shows how loud the microphone is while the chat is folded.
  const { level } = voice
  useEffect(() => {
    if (!folded || voice.state !== 'recording') return
    const timer = setInterval(() => window.api.orb.level(level.current), LEVEL_MS)
    return () => clearInterval(timer)
  }, [folded, voice.state, level])

  /** Take a waiting message back into the composer, before what is typed there, to edit it. */
  async function editWaiting(id: string): Promise<void> {
    const message = await window.api.takeWaiting(chat.id, id)
    if (!message) return
    const next = text.trim() ? `${message.text}\n\n${text}` : message.text
    setText(next)
    setCaret(next.length)
    addAttachments(message.attachments)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(next.length, next.length)
    })
  }

  /**
   * The options shown besides the model picker (which also covers cline's
   * provider): the thinking effort, with the on/off options (Fast mode,
   * Ultracode) in its menu, and the persona the agent's main conversation
   * runs as (Claude Code's custom agents, offered once the user has some).
   * Anything else the agent offers is ignored, including mode: chats always
   * run in build mode.
   */
  const effort = options?.find((o) => o.category === 'thought_level')
  const switches = options?.filter((o) => o.type === 'boolean') ?? []
  const persona = options?.find((o) => o.category === 'agent' && o.type !== 'boolean')
  /** Who the message goes to: the agent, or for the custom providers the chat's provider. */
  const source = modelOptions(options ?? []).source
  const addressee =
    (chat.agent === 'custom-api' &&
      source?.values.find((v) => v.value === source.currentValue)?.name) ||
    AGENTS.find((a) => a.id === chat.agent)?.label

  /** Apply a model picked in the model picker, with its provider when it has one. */
  async function pickModel(agent: AgentId, settings: [string, string][]): Promise<void> {
    if (agent !== chat.agent) return onAgentChange(agent, Object.fromEntries(settings))
    // In order: the model list depends on the provider set before it.
    for (const [optionId, value] of settings) {
      if (options?.find((o) => o.id === optionId)?.currentValue !== value) {
        await onOptionChange(optionId, value)
      }
    }
  }
  const error = status?.error ?? optionsError

  return (
    <>
      <div
        className={`composer${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''}${voice.state !== 'idle' ? ' listening' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setDragging(false)
          attachFiles(e.dataTransfer.files)
        }}
      >
        {(attachments.length > 0 || chat.waitingMessages) && (
          <div className="composer-header">
            {attachments.length > 0 && (
              <div className="attachments">
                {attachments.map((a, index) => (
                  <span className="attachment" key={`${a.path ?? a.name}-${index}`} title={a.path}>
                    <AttachmentPicture attachment={a} />
                    <span className="attachment-name">{a.name}</span>
                    <button
                      type="button"
                      title="Remove"
                      onClick={() =>
                        setAttachments((current) => current.filter((_, i) => i !== index))
                      }
                    >
                      <CloseIcon width={11} height={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {chat.waitingMessages && (
              <div className="waiting-messages">
                <div className="waiting-label">Joins the turn at its next step</div>
                {chat.waitingMessages.map((message) => (
                  <div className="waiting-message" key={message.id}>
                    <span className="waiting-text" title={message.text}>
                      {message.text}
                    </span>
                    <button
                      type="button"
                      className="label-btn"
                      onClick={() => editWaiting(message.id)}
                    >
                      <PencilIcon width={12} height={12} />
                      Edit
                    </button>
                    <button
                      type="button"
                      className="label-btn danger"
                      onClick={() => window.api.takeWaiting(chat.id, message.id)}
                    >
                      <TrashIcon width={12} height={12} />
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {menuOpen && (
          <CompletionMenu
            items={menuItems}
            active={menuActive}
            onHover={setMenuActive}
            onChoose={choose}
          />
        )}
        <div className="composer-leading">
          <button
            type="button"
            className="icon-btn round"
            title="Attach files"
            onClick={async () => {
              setUploadError(undefined)
              try {
                addAttachments(await window.api.pickFiles())
              } catch (error) {
                setUploadError((error as Error).message)
              }
            }}
          >
            <PlusIcon width={20} height={20} />
          </button>
        </div>
        {voice.state !== 'idle' && (
          <div className="voice-live" aria-live="polite">
            {voice.state === 'recording' ? (
              <>
                <span className="voice-dot" />
                <span className="voice-word">Listening</span>
                <LevelMeter level={voice.level} />
              </>
            ) : (
              <span className="voice-word shimmer">Writing out…</span>
            )}
          </div>
        )}
        {suggestion && (
          <div className="composer-suggestion" ref={suggestionRef} aria-hidden="true">
            <span className="composer-suggestion-typed">{text}</span>
            {suggestion}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          aria-description={suggestion ? `Suggestion: ${suggestion}. Tab to accept.` : undefined}
          onScroll={(e) => {
            if (suggestionRef.current) suggestionRef.current.scrollTop = e.currentTarget.scrollTop
          }}
          placeholder={
            chat.waiting
              ? 'Waiting for your answer above'
              : chat.running
                ? 'Working… send a message to steer it'
                : `Ask ${addressee}…`
          }
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            setMenuActive(0)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            // Files and images on the clipboard become attachments; text pastes normally.
            if (e.clipboardData.files.length === 0) return
            e.preventDefault()
            attachFiles(e.clipboardData.files)
          }}
          onKeyDown={(e) => {
            if (menuOpen && menuItems.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setMenuActive((i) => (i + step + menuItems.length) % menuItems.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                choose(menuItems[Math.min(menuActive, menuItems.length - 1)])
                return
              }
            }
            if (menuOpen && e.key === 'Escape') {
              // Handled: closing the menu must not also stop the agent.
              e.preventDefault()
              setMenuDismissed(`${caret}:${text}`)
              return
            }
            if (suggestion && !e.nativeEvent.isComposing) {
              const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
              if (plain && (e.key === 'Tab' || e.key === 'ArrowRight')) {
                e.preventDefault()
                acceptSuggestion()
                return
              }
              if (e.key === 'Escape') {
                // As with the menu: hiding the suggestion must not also stop the agent.
                e.preventDefault()
                setSuggestionDismissed(text)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-trailing">
          <button
            type="button"
            className={`icon-btn round voice-button${voice.state === 'recording' ? ' recording' : ''}`}
            title={
              voice.state === 'recording'
                ? 'Recording: let go, or click, to finish'
                : voice.state === 'transcribing'
                  ? 'Writing out…'
                  : 'Hold to talk (or hold right ⌘), or click to start and stop'
            }
            disabled={voice.state === 'transcribing'}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              // The release comes here even when the pointer has left the button.
              e.currentTarget.setPointerCapture(e.pointerId)
              voice.press()
            }}
            onPointerUp={voice.release}
            // Enter or Space on the focused button: a click, with no pointer.
            onClick={(e) => e.detail === 0 && voice.press()}
          >
            {voice.state === 'transcribing' ? (
              <span className="spinner" />
            ) : voice.state === 'recording' ? (
              <StopIcon width={16} height={16} />
            ) : (
              <MicIcon width={18} height={18} />
            )}
          </button>
          {chat.running && !canSend ? (
            <button
              className="send-button stop"
              title="Stop (Esc)"
              onClick={() => window.api.cancel(chat.id)}
            >
              <StopIcon width={16} height={16} />
            </button>
          ) : (
            <button
              className="send-button"
              title="Send (Enter)"
              disabled={!canSend}
              onClick={submit}
            >
              <SendIcon width={18} height={18} />
            </button>
          )}
        </div>
      </div>
      {/* The chat's settings, in their own row under the composer. */}
      <div className="composer-settings">
        <ModelPicker
          agent={chat.agent}
          projectId={chat.projectId}
          statuses={statuses}
          options={options}
          agentFixed={chat.running}
          onChange={pickModel}
        />
        {(effort || switches.length > 0) && (
          <EffortPicker option={effort} switches={switches} onChange={onOptionChange} />
        )}
        {persona && (
          <Picker
            title={persona.name}
            icon={<PersonaIcon width={15} height={15} />}
            value={persona.currentValue}
            // Claude Code's "Default" says nothing on its own beside the other pickers.
            values={persona.values.map((v) =>
              v.value === 'default' ? { ...v, name: `Default ${persona.name.toLowerCase()}` } : v
            )}
            onChange={(value) => void onOptionChange(persona.id, value)}
          />
        )}
        <div className="permission-mode" data-mode={permissionMode(chat)}>
          <Picker
            title="Permissions"
            icon={<ShieldIcon width={15} height={15} />}
            value={permissionMode(chat)}
            values={PERMISSION_MODES}
            onChange={(mode) => {
              // Two per-chat settings underneath: bypass approves requests,
              // project-only still asks for anything outside the project.
              const permissions = {
                bypassPermissions: mode !== 'ask',
                projectOnly: mode === 'project'
              }
              window.api.setPermissions(chat.id, permissions)
              // Remembered for new chats.
              writePref('permissions', permissions)
            }}
          />
        </div>
        {chat.context && <ContextMeter context={chat.context} />}
        {voice.error && (
          <span className="composer-error" title={voice.error}>
            {voice.error}
          </span>
        )}
        {uploadError && (
          <span className="composer-error" title={uploadError}>
            {uploadError}
          </span>
        )}
        {!options && !error && <span className="composer-hint">Starting agent…</span>}
        {error && (
          <span className="composer-error" title={error}>
            {error}
          </span>
        )}
      </div>
    </>
  )
}

/** From this share of the context window on, the meter shows it is filling up. */
const CONTEXT_FULL = 0.8

/** How much of the model's context window the conversation fills, as the agent last reported it. */
function ContextMeter({ context }: { context: { used: number; size: number } }): React.JSX.Element {
  const share = context.size > 0 ? Math.min(1, context.used / context.size) : 0
  const radius = 6
  const round = 2 * Math.PI * radius
  return (
    <span
      className={`context-meter${share >= CONTEXT_FULL ? ' full' : ''}`}
      title={`Context: ${tokenCount(context.used)} of ${tokenCount(context.size)} tokens used`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r={radius} className="context-track" />
        <circle
          cx="8"
          cy="8"
          r={radius}
          className="context-fill"
          strokeDasharray={`${share * round} ${round}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {Math.round(share * 100)}%
    </span>
  )
}

/** "850", "53k", "1M", "1.5M". */
function tokenCount(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** How often the orb is told the microphone's level while dictating. */
const LEVEL_MS = 50
/** Image files the composer shows a thumbnail of; the types agents accept as images. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i

/** An attachment's picture: a pasted image itself, an image file's thumbnail, else a file icon. */
function AttachmentPicture({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const { data, mimeType, path } = attachment
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  useEffect(() => {
    if (data || !path || !IMAGE_FILE.test(path)) return
    let cancelled = false
    window.api.thumbnail(path).then((url) => {
      if (!cancelled) setThumbnail(url)
    })
    return () => {
      cancelled = true
    }
  }, [data, path])
  const src = data ? `data:${mimeType};base64,${data}` : thumbnail
  return src ? <img src={src} alt="" /> : <FileIcon width={13} height={13} />
}
