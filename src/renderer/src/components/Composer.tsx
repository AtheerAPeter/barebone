import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AGENTS,
  autoModeOn,
  modelOptions,
  type AgentCommand,
  type AgentId,
  type AgentOption,
  type AgentStatus,
  type Chat,
  type ChatPermissions,
  type Skill,
  type Attachment
} from '../../../shared/types'
import { Picker } from './Picker'
import { EffortLevel, EffortPicker } from './EffortPicker'
import { ModelPicker } from './model-picker/ModelPicker'
import { AgentLogo } from './model-picker/AgentLogo'
import { CompletionMenu, type CompletionItem } from './CompletionMenu'
import { uploadFile } from '../remote/upload'
import { touchScreen } from '../lib/touch'
import { useLeaving } from '../lib/leaving'
import { useSheetSwipe } from '../lib/gestures'
import { addPrompt } from '../../../shared/prompt-history'
import { LevelMeter } from './LevelMeter'
import { LimitsMeter } from './LimitsMeter'
import { writePref } from '../lib/prefs'
import { TALK_KEY } from '../lib/platform'
import { useVoiceInput, type VoiceState } from '../lib/voice'
import {
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  MicIcon,
  PersonaIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
  StopIcon
} from './icons'
import { WaitingStrip } from './WaitingStrip'

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
  /**
   * Controls at the two ends of the settings row: on a phone through the
   * remote link, the top bar's buttons move here, within the thumb's reach.
   */
  leading?: React.ReactNode
  trailing?: React.ReactNode
  /**
   * The chat's settings (model, thinking, agent, permissions, usage) behind
   * one button in the settings row, in a sheet from the bottom: a phone's.
   */
  settingsSheet?: boolean
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

/** Claude Code's own auto mode, offered in Claude Code chats only. */
const AUTO_MODE = {
  value: 'auto',
  name: 'Auto mode',
  description:
    'Claude Code checks each action and blocks risky ones; asks you when it keeps blocking'
}

function permissionModes(chat: Chat): typeof PERMISSION_MODES {
  return chat.agent === 'claude'
    ? [PERMISSION_MODES[0], AUTO_MODE, ...PERMISSION_MODES.slice(1)]
    : PERMISSION_MODES
}

function permissionMode(chat: Chat): string {
  if (autoModeOn(chat)) return 'auto'
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
  onVoiceChange,
  leading,
  trailing,
  settingsSheet = false
}: ComposerProps): React.JSX.Element {
  // ChatView is keyed by chat, so each chat's composer starts from its saved draft.
  const [text, setText] = useState(chat.draft ?? '')
  const [caret, setCaret] = useState(text.length)
  const [menuActive, setMenuActive] = useState(0)
  /** Set when the user closes the menu with Escape, for the text and caret at that moment. */
  const [menuDismissed, setMenuDismissed] = useState<string>()
  /** The settings sheet is open (settingsSheet). */
  const [sheetOpen, setSheetOpen] = useState(false)
  /** It stays while it sinks away. */
  const sheet = useLeaving(sheetOpen)
  const sheetRef = useRef<HTMLDivElement>(null)
  const sheetScrimRef = useRef<HTMLDivElement>(null)
  useSheetSwipe(sheetRef, {
    enabled: settingsSheet && sheetOpen,
    onDismiss: () => setSheetOpen(false),
    scrimRef: sheetScrimRef
  })
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

  /** Send what is written. `queued`: to a working chat, it follows the turn instead of steering it. */
  function submit(queued = false): void {
    if (!canSend) return
    window.api.send(chat.id, text.trim(), attachments, queued)
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

  /** The chat's settings, beside the composer, or each on its row in the settings sheet. */
  const modelPicker = (
    <ModelPicker
      agent={chat.agent}
      projectId={chat.projectId}
      statuses={statuses}
      options={options}
      agentFixed={chat.running}
      onChange={pickModel}
    />
  )
  const effortPicker = (effort || switches.length > 0) && (
    <EffortPicker
      option={effort}
      switches={switches}
      onChange={onOptionChange}
      showLevel={settingsSheet}
    />
  )
  const personaPicker = persona && (
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
  )
  const permissionPicker = (
    <div className="permission-mode" data-mode={permissionMode(chat)}>
      <Picker
        title="Permissions"
        icon={<ShieldIcon width={15} height={15} />}
        value={permissionMode(chat)}
        values={permissionModes(chat)}
        onChange={(mode) => {
          // Per-chat settings underneath: bypass approves requests,
          // project-only still asks for anything outside the project,
          // auto mode leaves approving to Claude Code's classifier.
          const permissions: ChatPermissions = {
            bypassPermissions: mode === 'project' || mode === 'full',
            projectOnly: mode === 'project',
            autoMode: mode === 'auto'
          }
          void window.api.setPermissions(chat.id, permissions)
          // Remembered for new chats.
          writePref('permissions', permissions)
        }}
      />
    </div>
  )
  const limitsMeter = (
    <LimitsMeter
      chatId={chat.id}
      agent={chat.agent}
      source={options?.find((o) => o.id === 'source')?.currentValue}
    />
  )
  /** The model's name on the settings button, else the agent's. */
  const modelOption = modelOptions(options ?? []).model
  const modelName =
    modelOption?.values.find((v) => v.value === modelOption.currentValue)?.name ??
    AGENTS.find((a) => a.id === chat.agent)?.label ??
    chat.agent

  return (
    <>
      {chat.waitingMessages && (
        <WaitingStrip chat={chat} messages={chat.waitingMessages} onEdit={editWaiting} />
      )}
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
        {attachments.length > 0 && (
          <div className="composer-header">
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
                ? touchScreen
                  ? 'Send a message to steer it'
                  : 'Steer, or Tab to queue'
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
              return
            }
            const plain = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
            // While the agent works, Tab queues the message for after its turn.
            if (plain && e.key === 'Tab' && chat.running && canSend) {
              e.preventDefault()
              submit(true)
              return
            }
            // ↑ in an empty composer takes the last waiting message back to edit it.
            const lastWaiting = chat.waitingMessages?.at(-1)
            if (plain && e.key === 'ArrowUp' && !text && lastWaiting) {
              e.preventDefault()
              void editWaiting(lastWaiting.id)
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
                  : `Hold to talk (or hold ${TALK_KEY}), or click to start and stop`
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
              onClick={() => submit()}
            >
              <SendIcon width={18} height={18} />
            </button>
          )}
        </div>
      </div>
      {/* The chat's settings, in their own row under the composer. */}
      <div className="composer-settings">
        {leading}
        {settingsSheet ? (
          <button
            type="button"
            className="settings-summary"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            onClick={() => setSheetOpen(true)}
          >
            <AgentLogo agent={chat.agent} size={18} />
            <span className="settings-summary-text">{modelName}</span>
            {effort && <EffortLevel option={effort} />}
            <ChevronDownIcon width={14} height={14} />
          </button>
        ) : (
          <>
            {modelPicker}
            {effortPicker}
            {personaPicker}
            {permissionPicker}
            {limitsMeter}
          </>
        )}
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
        {trailing && <span className="composer-trailing-end">{trailing}</span>}
      </div>
      {settingsSheet && sheet.shown && (
        <>
          <div
            ref={sheetScrimRef}
            className={`drawer-scrim open${sheet.leaving ? ' leaving' : ''}`}
            onClick={() => setSheetOpen(false)}
          />
          <div
            ref={sheetRef}
            className={`settings-sheet${sheet.leaving ? ' leaving' : ''}`}
            role="dialog"
            aria-label="Chat settings"
          >
            <div className="sheet-grabber" aria-hidden="true" />
            <div className="settings-sheet-head">
              <span>Chat settings</span>
              <button
                type="button"
                className="icon-btn"
                title="Close"
                onClick={() => setSheetOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <SheetRow name="Model">{modelPicker}</SheetRow>
            {effortPicker && <SheetRow name="Thinking">{effortPicker}</SheetRow>}
            {personaPicker && <SheetRow name="Agent">{personaPicker}</SheetRow>}
            <SheetRow name="Permissions">{permissionPicker}</SheetRow>
            <SheetRow name="Usage">{limitsMeter}</SheetRow>
          </div>
        </>
      )}
    </>
  )
}

/** One of the settings sheet's rows: its name, and the setting's own picker. */
function SheetRow({
  name,
  children
}: {
  name: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="settings-sheet-row">
      <span className="settings-sheet-name">{name}</span>
      {children}
    </div>
  )
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
