import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { renderSVG } from 'uqr'
import type {
  DownloadId,
  Downloads,
  DownloadStatus,
  MobileToolCheck,
  TelegramStatus,
  VoiceModelId
} from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { useRemoteStatus } from '../lib/remote'
import { useTelegramStatus } from '../lib/telegram'
import { useUpdateInstall } from '../lib/update'
import {
  CloseIcon,
  DownloadIcon,
  MusicIcon,
  GlobeIcon,
  MicIcon,
  PencilIcon,
  PhoneIcon,
  RouteIcon,
  SearchIcon,
  ServerIcon,
  SpeakerIcon,
  TelegramIcon,
  TextIcon,
  VideoIcon
} from './icons'
import { ProvidersBody } from './ProvidersCard'
import { RemoteLinkBody, SignedInBody } from './RemoteLinkCard'
import { SettingsRow, Switch, type SettingsTone } from './SettingsRow'

/** The filter above the list: every setting, the ones on, the ones off, the ones missing something. */
type Filter = 'all' | 'on' | 'off' | 'needs'
const FILTERS: { id: Filter; name: string }[] = [
  { id: 'all', name: 'All' },
  { id: 'on', name: 'On' },
  { id: 'off', name: 'Off' },
  { id: 'needs', name: 'Needs setup' }
]

/** The groups of Settings, in the order they are shown. */
const GROUPS = ['Agents', 'Abilities', 'Voice', 'Connections', 'App'] as const
type Group = (typeof GROUPS)[number]

/**
 * One setting, as the list needs it: what it is called, the line that says what
 * it does, what it is now (for the filters) and the row that shows it.
 */
interface RowDef {
  id: string
  group: Group
  name: string
  summary: string
  /** Words the search finds it by, beyond its name and summary. */
  keywords: string
  /** On or off, for the filters; unset when the setting has no such state. */
  state?: 'on' | 'off'
  /** Missing a key or a pairing: what the "Needs setup" filter shows. */
  needs?: boolean
  icon: ReactNode
  tone: SettingsTone
  pill?: string
  pillTone?: 'on' | 'off' | 'warn'
  /** The switch, or a button that opens the row. */
  action?: ReactNode
  detail: ReactNode
}

/** The API keys main keeps, shown by their last four characters. */
interface KeyHints {
  exa?: string | null
  voice?: string | null
  telegram?: string | null
}

/**
 * Settings: every switch, key and link the app has, as one list grouped by what
 * it touches. A line per setting says what it does and what it is now; the
 * chevron opens the full explanation and the fields. Search and the filters
 * narrow the list, so what is off, or missing a key, is one click away.
 */
export function SettingsView({
  instructions,
  annotations,
  recording,
  codeTours,
  mobile,
  speech,
  voices,
  music,
  onProvidersChange
}: {
  instructions: string | undefined
  annotations: boolean
  recording: boolean
  codeTours: boolean
  mobile: boolean
  speech: boolean
  voices: Voices
  music: boolean
  onProvidersChange: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  /** The one row whose explanation is open. */
  const [open, setOpen] = useState<string>()
  const [hints, setHints] = useState<KeyHints>({})
  const [providers, setProviders] = useState<number>()
  const [version, setVersion] = useState<string>()
  const [downloads, setDownloads] = useState<Downloads>()
  /** What went wrong saving a switch, per setting. */
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const telegram = useTelegramStatus()
  const remote = useRemoteStatus()
  /** A browser through the remote link: it signs itself out, it cannot link this Mac. */
  const remoteClient = Boolean(window.api.remote)

  useEffect(() => {
    window.api.exa.keyHint().then((hint) => setHints((h) => ({ ...h, exa: hint })))
    window.api.voice.keyHint().then((hint) => setHints((h) => ({ ...h, voice: hint })))
    window.api.telegram.keyHint().then((hint) => setHints((h) => ({ ...h, telegram: hint })))
    window.api.providers.list().then((list) => setProviders(list.length))
    window.api.appVersion().then(setVersion)
    window.api.downloads.status().then(setDownloads)
    return window.api.downloads.onStatus(setDownloads)
  }, [])

  function setHint(name: keyof KeyHints, hint: string | null): void {
    setHints((h) => ({ ...h, [name]: hint }))
  }

  function refreshProviders(): void {
    window.api.providers.list().then((list) => setProviders(list.length))
    onProvidersChange()
  }

  /** Saves a switch, and shows what went wrong under its row if it did. */
  async function run(id: string, action: () => Promise<unknown>): Promise<void> {
    setErrors((e) => ({ ...e, [id]: undefined }))
    try {
      await action()
    } catch (e) {
      setErrors((err) => ({ ...err, [id]: errorMessage(e) }))
    }
  }

  const onOff = (
    id: string,
    label: string,
    on: boolean,
    save: (on: boolean) => Promise<unknown>
  ): React.JSX.Element => (
    <Switch
      label={label}
      on={on}
      onChange={(value) => {
        void run(id, () => save(value))
      }}
    />
  )

  const manage = (id: string, label: string): ReactNode => (
    <button
      type="button"
      className="btn setting-action"
      onClick={() => setOpen(open === id ? undefined : id)}
    >
      {label}
    </button>
  )

  const keyState = (hint: string | null | undefined): 'on' | 'off' | undefined =>
    hint === undefined ? undefined : hint ? 'on' : 'off'
  const keyPill = (hint: string | null | undefined): string => (hint ? 'Key saved' : 'Add a key')
  const keyTone = (hint: string | null | undefined): 'on' | 'warn' => (hint ? 'on' : 'warn')

  const rows: RowDef[] = [
    {
      id: 'providers',
      group: 'Agents',
      name: 'Providers',
      summary: 'The APIs chats can run on. Each one adds its models to the model picker.',
      keywords: 'custom api key base url openai anthropic ollama openrouter models server',
      icon: <ServerIcon />,
      tone: 'indigo',
      pill: providers === undefined ? undefined : providers > 0 ? `${providers} set` : 'None',
      pillTone: providers ? 'on' : 'off',
      action: manage('providers', 'Manage'),
      detail: (
        <>
          <p>
            Add any API that speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages.
            Its models show in the model picker under Custom providers, and chats on them run on the
            app&apos;s own agent.
          </p>
          <ProvidersBody onChange={refreshProviders} />
        </>
      )
    },
    {
      id: 'instructions',
      group: 'Agents',
      name: 'Custom instructions',
      summary: 'One block of text every new chat is told before it starts.',
      keywords: 'prompt system agents claude codex rules language german',
      icon: <TextIcon />,
      tone: 'orange',
      pill: instructions?.trim() ? 'Saved' : 'Not set',
      pillTone: instructions?.trim() ? 'on' : 'off',
      action: manage('instructions', 'Edit'),
      detail: (
        <>
          <p>
            Given to every new chat, on every agent. Claude Code and Codex get them in their system
            prompt, after their own; the app&apos;s own agent before the project&apos;s{' '}
            <code>AGENTS.md</code> or <code>CLAUDE.md</code>, and its subagents too. Agents that
            take no system prompt read them with the chat&apos;s first message. A chat keeps the
            instructions it started with, so a change applies to chats started after it.
          </p>
          <InstructionsForm saved={instructions ?? ''} />
        </>
      )
    },
    {
      id: 'annotations',
      group: 'Abilities',
      name: 'Drawing on pages',
      summary: 'Agents can box, point and caption in the browser, then wait for your click.',
      keywords: 'browser draw arrows labels pointer tutorial annotations',
      state: annotations ? 'on' : 'off',
      icon: <PencilIcon />,
      tone: 'pink',
      pill: annotations ? 'On' : 'Off',
      pillTone: annotations ? 'on' : 'off',
      action: onOff('annotations', 'Drawing on pages', annotations, window.api.setAnnotations),
      detail: (
        <>
          <p>
            Gives every agent browser tools that draw on the page in the browser panel (boxes and
            arrows with labels, a pointer, and a caption card) and wait for your clicks. Agents use
            them to teach and explain, and the built-in <code>browser-tutorial</code> skill shows
            them how. Turned off, the tools and the skill stay out of the chats&apos; context.
          </p>
          <Scope />
          {errors.annotations && <div className="msg-error">{errors.annotations}</div>}
        </>
      )
    },
    {
      id: 'recording',
      group: 'Abilities',
      name: 'Recording videos',
      summary: 'Agents can record a browser tab as an MP4, with their voice.',
      keywords: 'video mp4 demo walkthrough record screen tab',
      state: recording ? 'on' : 'off',
      icon: <VideoIcon />,
      tone: 'red',
      pill: recording ? 'On' : 'Off',
      pillTone: recording ? 'on' : 'off',
      action: onOff('recording', 'Recording videos', recording, window.api.setRecording),
      detail: (
        <>
          <p>
            Gives every agent browser tools that record a tab of the browser panel as an MP4 video,
            for when you ask for a demo or a walkthrough. The video shows the page as you see it,
            with what agents draw on it, and the agent&apos;s voice is its sound when speech is on.
            The browser is signed in to your accounts, so what a page shows is in the video.
          </p>
          <Scope />
          {errors.recording && <div className="msg-error">{errors.recording}</div>}
          <h4 className="settings-subhead">Thumbnails</h4>
          <p>
            With ffmpeg on this Mac, every video gets a thumbnail: its best still, saved as a JPEG
            beside it and put in as its first frame, so players and sites show that one.
          </p>
          <DownloadBody id="ffmpeg" what="ffmpeg" status={downloads?.ffmpeg} />
        </>
      )
    },
    {
      id: 'music',
      group: 'Abilities',
      name: 'Music',
      summary:
        'Agents can make music on this Mac: a drum roll when a task is done, tracks for videos.',
      keywords:
        'music soundtrack background track stable audio video demo drum roll fanfare jingle',
      state: music ? 'on' : 'off',
      needs: music && downloads?.music.state === 'missing',
      icon: <MusicIcon />,
      tone: 'pink',
      pill: music ? 'On' : 'Off',
      pillTone: music ? 'on' : 'off',
      action: onOff('music', 'Music', music, window.api.setMusic),
      detail: (
        <>
          <p>
            Agents make instrumental music from a description, with Stable Audio 3 Small on this
            Mac. When an agent tells you out loud that a task is done, it can play a drum roll
            before the news or a little tune under its words. It can also make a track to play
            quietly under the voice of a video it records. The model is downloaded once
            {downloads ? `, ${megabytes(downloads.music.total)}` : ''}.
          </p>
          <DownloadBody id="music" what="the music model" status={downloads?.music} />
          {errors.music && <div className="msg-error">{errors.music}</div>}
        </>
      )
    },
    {
      id: 'codeTours',
      group: 'Abilities',
      name: 'Code walkthroughs',
      summary: 'Agents can walk you through code, stop after stop, in the code panel.',
      keywords: 'code tour route stops explain source panel narration',
      state: codeTours ? 'on' : 'off',
      icon: <RouteIcon />,
      tone: 'purple',
      pill: codeTours ? 'On' : 'Off',
      pillTone: codeTours ? 'on' : 'off',
      action: onOff('codeTours', 'Code walkthroughs', codeTours, window.api.setCodeTours),
      detail: (
        <>
          <p>
            Gives every agent a tool that walks you through code in the code panel: how a feature
            works, where data goes, or what your uncommitted changes do. The agent plans the whole
            route, and it plays stop after stop, the voice saying each one when speech is on. The
            code it passes through stays on screen, file by file, with short notes on its lines and
            links showing where it goes next. You can pause it and step back and forth. Turned off,
            the tool stays out of the chats&apos; context; source control in the panel works either
            way.
          </p>
          <Scope />
          {errors.codeTours && <div className="msg-error">{errors.codeTours}</div>}
        </>
      )
    },
    {
      id: 'mobile',
      group: 'Abilities',
      name: 'Mobile apps',
      summary: 'Agents can read and tap screens on simulators and emulators.',
      keywords: 'ios android simulator emulator device metro react native adb',
      state: mobile ? 'on' : 'off',
      icon: <PhoneIcon />,
      tone: 'gray',
      pill: mobile ? 'On' : 'Off',
      pillTone: mobile ? 'on' : 'off',
      action: onOff('mobile', 'Mobile apps', mobile, window.api.setMobile),
      detail: (
        <>
          <p>
            Gives every agent tools that run and test mobile apps on the iOS simulators and Android
            emulators and phones on this computer: reading the screen, tapping, swiping and typing,
            opening links and apps, device settings, the apps&apos; logs and crashes, and Metro for
            React Native and Expo. You watch and use the devices in the Simulator app and the
            emulator&apos;s own window; the tools work only while an agent uses them. Turned off,
            the tools stay out of the chats&apos; context.
          </p>
          <Scope />
          {mobile && <MobileChecks />}
          {errors.mobile && <div className="msg-error">{errors.mobile}</div>}
        </>
      )
    },
    {
      id: 'voice',
      group: 'Voice',
      name: 'Voice input',
      summary: 'Hold ⌘ or the mic to dictate; Whisper on Groq writes it out.',
      keywords: 'speech to text dictate microphone whisper groq language arabic',
      state: keyState(hints.voice),
      needs: hints.voice === null,
      icon: <MicIcon />,
      tone: 'green',
      pill: hints.voice === undefined ? undefined : keyPill(hints.voice),
      pillTone: keyTone(hints.voice),
      action: manage('voice', hints.voice ? 'Manage' : 'Add key'),
      detail: (
        <>
          <p>
            Hold the microphone button in the composer, or the right ⌘ key, while you speak. When
            you let go, Whisper on Groq writes out what you said in the language you spoke, such as
            Arabic, English or German. A click on the button records until the next click. The
            recording is sent to Groq. It takes a Groq API key, free from{' '}
            <code>console.groq.com</code>.
          </p>
          <KeyForm
            label="Groq API key"
            hint={hints.voice}
            save={window.api.voice.setKey}
            onSaved={(hint) => setHint('voice', hint)}
          />
        </>
      )
    },
    {
      id: 'speech',
      group: 'Voice',
      name: 'Spoken messages',
      summary: 'Agents can say things out loud in a natural voice on this Mac.',
      keywords: 'voice speak out loud supertonic audio language arabic german',
      state: speech ? 'on' : 'off',
      needs:
        speech &&
        downloads !== undefined &&
        VOICES.every(({ id }) => downloads[id].state !== 'ready'),
      icon: <SpeakerIcon />,
      tone: 'teal',
      pill: speech ? 'On' : 'Off',
      pillTone: speech ? 'on' : 'off',
      action: onOff('speech', 'Spoken messages', speech, window.api.speech.set),
      detail: (
        <>
          <p>
            Agents can say things out loud, such as when they need you or finish a long task, in a
            voice that runs on this Mac. Download a voice, turn it on, and pick which one speaks
            Arabic and which every other language.
          </p>
          <VoicesBody on={speech} voices={voices} downloads={downloads} />
          {errors.speech && <div className="msg-error">{errors.speech}</div>}
        </>
      )
    },
    {
      id: 'search',
      group: 'Connections',
      name: 'Web search',
      summary: 'Chats look things up on the web through Exa.',
      keywords: 'web lookup exa search key internet',
      state: keyState(hints.exa),
      needs: hints.exa === null,
      icon: <SearchIcon />,
      tone: 'blue',
      pill: hints.exa === undefined ? undefined : keyPill(hints.exa),
      pillTone: keyTone(hints.exa),
      action: manage('search', hints.exa ? 'Manage' : 'Add key'),
      detail: (
        <>
          <p>
            Chats on the app&apos;s own agent (Custom providers, OpenCode API, Cline API and Command
            Code API) search the web with Exa, as opencode does. Searches work without a key on
            Exa&apos;s free, rate-limited tier. With a key from <code>dashboard.exa.ai</code>, they
            use your Exa account.
          </p>
          <KeyForm
            label="Exa API key"
            hint={hints.exa}
            save={window.api.exa.setKey}
            onSaved={(hint) => setHint('exa', hint)}
          />
        </>
      )
    },
    {
      id: 'telegram',
      group: 'Connections',
      name: 'Control from Telegram',
      summary: 'Guide a chat from your phone through your own bot.',
      keywords: 'telegram bot phone remote chat botfather pair qr',
      state: telegram ? (telegram.state === 'ready' ? 'on' : 'off') : undefined,
      needs: telegram ? telegram.state !== 'ready' : undefined,
      icon: <TelegramIcon />,
      tone: 'blue',
      pill: telegram ? (telegram.state === 'ready' ? 'Paired' : 'Not paired') : undefined,
      pillTone: telegram?.state === 'ready' ? 'on' : 'warn',
      action: manage('telegram', telegram?.state === 'ready' ? 'Manage' : 'Set up'),
      detail: (
        <>
          <p>
            Guide a chat from your phone. In Telegram, send <code>/newbot</code> to @BotFather and
            paste the token it gives you here. Then choose Control from Telegram in a chat&apos;s
            menu in the sidebar. What you send the bot goes to that chat, and chats it starts with{' '}
            <code>@chats</code> show as cards that keep up with what they do. Bot chats in Telegram
            are not end-to-end encrypted. Barebone has to be open on a Mac that is awake.
          </p>
          <KeyForm
            label="Telegram bot token"
            hint={hints.telegram}
            save={window.api.telegram.setKey}
            onSaved={(hint) => setHint('telegram', hint)}
          />
          <TelegramStatusBlock status={telegram} />
        </>
      )
    },
    {
      id: 'remote',
      group: 'Connections',
      name: 'Remote link',
      summary: 'Use chats from a browser on your phone or another computer.',
      keywords: 'remote zrok tunnel phone browser pair qr link',
      state: remoteClient ? undefined : remote ? (remote.on ? 'on' : 'off') : undefined,
      icon: <GlobeIcon />,
      tone: 'teal',
      pill: remoteClient ? 'This browser' : remote ? (remote.on ? 'On' : 'Off') : undefined,
      pillTone: remote?.on ? 'on' : 'off',
      action: remoteClient
        ? undefined
        : remote
          ? onOff('remote', 'Remote link', remote.on, window.api.remoteLink.setOn)
          : undefined,
      detail: (
        <>
          {remoteClient ? (
            <SignedInBody />
          ) : (
            <RemoteLinkBody status={remote} error={errors.remote} />
          )}
        </>
      )
    },
    {
      id: 'updates',
      group: 'App',
      name: 'Updates',
      summary: 'Barebone checks for a newer release every few hours.',
      keywords: 'version update release install newer',
      icon: <DownloadIcon />,
      tone: 'gray',
      pill: version ? `v${version}` : undefined,
      detail: <UpdatesBody version={version} />
    }
  ]

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return (row: RowDef): boolean => {
      if (filter === 'on' && row.state !== 'on') return false
      if (filter === 'off' && row.state !== 'off') return false
      if (filter === 'needs' && row.needs !== true) return false
      if (!words.length) return true
      const text = `${row.name} ${row.summary} ${row.keywords} ${row.group}`.toLowerCase()
      return words.every((word) => text.includes(word))
    }
  }, [query, filter])

  const shown = rows.filter(matches).length
  const clear = (): void => {
    setQuery('')
    setFilter('all')
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>Settings</h2>
        <p>Everything your agents can do, in one list. Search it, or show only what is off.</p>
      </div>
      <label className="settings-search">
        <SearchIcon />
        <input
          type="text"
          aria-label="Search settings"
          placeholder="Search settings — name, action, or group"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // A search being cleared keeps Settings open; an empty one leaves it.
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="settings-search-clear"
            aria-label="Clear the search"
            onClick={() => setQuery('')}
          >
            <CloseIcon />
          </button>
        )}
      </label>
      <div className="settings-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="settings-filter"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.name}
          </button>
        ))}
        <span className="settings-count">
          {shown} of {rows.length}
        </span>
      </div>
      {GROUPS.map((group) => {
        const list = rows.filter((row) => row.group === group && matches(row))
        if (!list.length) return null
        return (
          <section className="settings-block" key={group}>
            <h3 className="settings-group">{group}</h3>
            {list.map((row) => (
              <SettingsRow
                key={row.id}
                icon={row.icon}
                tone={row.tone}
                name={row.name}
                summary={row.summary}
                pill={row.pill}
                pillTone={row.pillTone}
                action={row.action}
                open={open === row.id}
                onToggle={() => setOpen(open === row.id ? undefined : row.id)}
              >
                {row.detail}
              </SettingsRow>
            ))}
          </section>
        )
      })}
      {shown === 0 && (
        <div className="settings-empty">
          <p>Nothing matches.</p>
          <button type="button" className="btn" onClick={clear}>
            Clear the search and filters
          </button>
        </div>
      )}
    </div>
  )
}

/** The line under the switches about what a change touches. */
function Scope(): React.JSX.Element {
  return <p className="setting-scope">A change applies to chats started after it.</p>
}

/**
 * An API key the main process keeps: replaced or removed here, shown by its
 * last four characters, which the row's state says too.
 */
function KeyForm({
  label,
  hint,
  save,
  onSaved
}: {
  label: string
  /** The saved key's last four characters; null when none is saved. */
  hint: string | null | undefined
  save: (key: string | null) => Promise<string | null>
  onSaved: (hint: string | null) => void
}): React.JSX.Element {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  async function store(value: string | null): Promise<void> {
    setError(undefined)
    setSaving(true)
    try {
      onSaved(await save(value))
      setKey('')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) void store(key)
        }}
      >
        <input
          type="password"
          aria-label={label}
          placeholder={hint ? `Saved key ending in ${hint}` : label}
          value={key}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={!key.trim() || saving}>
          {hint ? 'Replace' : 'Save'}
        </button>
        {hint && (
          <button type="button" className="btn" disabled={saving} onClick={() => void store(null)}>
            Remove
          </button>
        )}
      </form>
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/** The user's own instructions, given to every agent's new chats. */
function InstructionsForm({ saved }: { saved: string }): React.JSX.Element {
  const [text, setText] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  async function save(): Promise<void> {
    setSaving(true)
    setError(undefined)
    try {
      await window.api.setInstructions(text)
      setText(text.trim())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <form
        className="settings-instructions"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <textarea
          aria-label="Custom instructions"
          rows={6}
          value={text}
          placeholder="For example: Answer in German. Run the tests before saying a change is done."
          onChange={(e) => setText(e.target.value)}
        />
        <div className="new-skill-actions">
          <button type="submit" className="btn primary" disabled={saving || text.trim() === saved}>
            Save
          </button>
        </div>
      </form>
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/** What Settings has for the voices: the ones turned off, and which speaks what. */
export interface Voices {
  off: VoiceModelId[]
  voiceFor: { arabic?: VoiceModelId; other?: VoiceModelId }
  supertonicInChats: boolean
  description?: string
}

/** The voices, as Settings lists them. */
const VOICES: { id: VoiceModelId; name: string; about: string }[] = [
  {
    id: 'supertonic',
    name: 'Supertonic 3',
    about: 'Fast and clear, in 31 languages, always in the same tone.'
  },
  {
    id: 'voxcpm2',
    name: 'VoxCPM2',
    about:
      'Natural, and it speaks in the mood each message asks for, in 30 languages. A little slower than speech, so live answers pause between sentences.'
  }
]

/** The voice VoxCPM2 speaks in until another is described (main/speech). */
const DEFAULT_VOICE = 'A warm, friendly man in his thirties with a clear, natural voice'

/** What the samples say. */
const SAMPLES = [
  {
    language: 'en',
    name: 'English',
    text: "Hi, I'm the voice your agents speak with. I'll tell you when something needs you."
  },
  {
    language: 'de',
    name: 'German',
    text: 'Hallo, ich bin die Stimme deiner Agenten. Ich sage dir Bescheid, wenn etwas dich braucht.'
  }
]

const megabytes = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`

/** Runs an action, keeping what went wrong to show under it. */
function useAction(): [string | undefined, (action: () => Promise<unknown>) => Promise<void>] {
  const [error, setError] = useState<string>()
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return [error, run]
}

/**
 * Something the app downloads (a voice, the music model, ffmpeg): its download
 * with a bar and Cancel, the button that starts it, and Remove once it is
 * here. `ready` is what shows beside Remove then.
 */
function DownloadBody({
  id,
  what,
  status,
  ready
}: {
  id: DownloadId
  what: string
  status: DownloadStatus | undefined
  ready?: ReactNode
}): React.JSX.Element | null {
  const [error, run] = useAction()
  if (!status) return null
  return (
    <>
      {status.state === 'downloading' && (
        <div className="speech-download">
          <div className="speech-progress">
            <div style={{ width: `${(100 * status.received) / status.total}%` }} />
          </div>
          <span>
            {megabytes(status.received)} of {megabytes(status.total)}
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => void run(() => window.api.downloads.cancel(id))}
          >
            Cancel
          </button>
        </div>
      )}
      {status.state === 'missing' && (
        <div className="settings-row">
          <button
            type="button"
            className="btn primary"
            onClick={() => void run(() => window.api.downloads.fetch(id))}
          >
            Download {what} ({megabytes(status.total)})
          </button>
        </div>
      )}
      {status.state === 'failed' && (
        <>
          <div className="msg-error">{status.message}</div>
          <div className="settings-row">
            <button
              type="button"
              className="btn"
              onClick={() => void run(() => window.api.downloads.fetch(id))}
            >
              Try again
            </button>
          </div>
        </>
      )}
      {status.state === 'ready' && (
        <div className="settings-row speech-ready">
          {ready}
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            onClick={() => void run(() => window.api.downloads.remove(id))}
          >
            Remove ({megabytes(status.total)})
          </button>
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/**
 * The voices under the Spoken messages row: each one's download, its switch
 * and samples; which speaks Arabic and which every other language; and the
 * voice VoxCPM2 speaks in, made from a description.
 */
function VoicesBody({
  on,
  voices,
  downloads
}: {
  on: boolean
  voices: Voices
  downloads: Downloads | undefined
}): React.JSX.Element | null {
  const [error, run] = useAction()
  if (!downloads) return null
  const usable = (id: VoiceModelId): boolean =>
    on && downloads[id].state === 'ready' && !voices.off.includes(id)
  const picked = (which: 'arabic' | 'other'): VoiceModelId => voices.voiceFor[which] ?? 'supertonic'

  return (
    <>
      {VOICES.map((voice) => {
        const ready = downloads[voice.id].state === 'ready'
        const voiceOn = !voices.off.includes(voice.id)
        return (
          <div key={voice.id} className="voice-model">
            <div className="voice-model-head">
              <div>
                <div className="settings-label">{voice.name}</div>
                <p>{voice.about}</p>
              </div>
              {ready && (
                <Switch
                  label={voice.name}
                  on={voiceOn}
                  onChange={(value) =>
                    void run(() => window.api.speech.setVoiceOn(voice.id, value))
                  }
                />
              )}
            </div>
            <DownloadBody
              id={voice.id}
              what={voice.name}
              status={downloads[voice.id]}
              ready={
                usable(voice.id) && (
                  <>
                    <span className="settings-label">Hear it</span>
                    {SAMPLES.map((sample) => (
                      <button
                        key={sample.language}
                        type="button"
                        className="btn"
                        onClick={() =>
                          void run(() =>
                            window.api.speech.sample(sample.text, sample.language, voice.id)
                          )
                        }
                      >
                        {sample.name}
                      </button>
                    ))}
                  </>
                )
              }
            />
            {voice.id === 'voxcpm2' && usable('voxcpm2') && (
              // An agent can change the voice too (set_voice): the field starts anew then.
              <VoiceDescription
                key={voices.description ?? DEFAULT_VOICE}
                description={voices.description ?? DEFAULT_VOICE}
              />
            )}
          </div>
        )
      })}
      {(['arabic', 'other'] as const).map((which) => (
        <div key={which} className="provider-field">
          <span>{which === 'arabic' ? 'Arabic speaks with' : 'Other languages speak with'}</span>
          <div className="segmented">
            {VOICES.map((voice) => (
              <button
                key={voice.id}
                type="button"
                className={picked(which) === voice.id ? 'on' : ''}
                disabled={!usable(voice.id)}
                onClick={() => void run(() => window.api.speech.setVoiceFor(which, voice.id))}
              >
                {voice.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      {usable('supertonic') && usable('voxcpm2') && (
        <div className="voice-model">
          <div className="voice-model-head">
            <div>
              <div className="settings-label">Supertonic in chats</div>
              <p>
                Chats speak with Supertonic, which starts at once. Videos keep the voices picked
                above.
              </p>
            </div>
            <Switch
              label="Supertonic in chats"
              on={voices.supertonicInChats}
              onChange={(value) => void run(() => window.api.speech.setSupertonicInChats(value))}
            />
          </div>
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/** The voice VoxCPM2 speaks in: a description, made into a voice on this Mac. */
function VoiceDescription({ description }: { description: string }): React.JSX.Element {
  const [text, setText] = useState(description)
  const [making, setMaking] = useState(false)
  const [error, run] = useAction()

  return (
    <form
      className="provider-field"
      onSubmit={(e) => {
        e.preventDefault()
        setMaking(true)
        void run(() => window.api.speech.makeVoice(text)).finally(() => setMaking(false))
      }}
    >
      <span>Its voice</span>
      <div className="settings-row">
        <input
          value={text}
          placeholder={DEFAULT_VOICE}
          aria-label="The voice VoxCPM2 speaks in"
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="submit"
          className="btn primary"
          disabled={making || !text.trim() || text.trim() === description}
        >
          {making ? 'Making it…' : 'Make this voice'}
        </button>
      </div>
      <p>
        Describe who speaks and how they sound. Agents can change it too, when a video needs another
        voice.
      </p>
      {error && <div className="msg-error">{error}</div>}
    </form>
  )
}

/** Whether the tools the device tools need are on this Mac, under the Mobile apps row. */
function MobileChecks(): React.JSX.Element | null {
  const [checks, setChecks] = useState<MobileToolCheck[]>()

  useEffect(() => {
    window.api.devices.checks().then(setChecks)
  }, [])

  if (!checks) return null
  return (
    <ul className="mobile-checks">
      {checks.map((check) => (
        <li key={check.name} className={check.found ? 'found' : 'missing'}>
          <strong>{check.name}</strong>{' '}
          {check.found ? (
            <>is installed, for {check.use}.</>
          ) : (
            <>
              is missing, needed for {check.use}. <code>{check.install}</code>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Pairing with the bot: a QR code of its start link for the phone's camera,
 * and the same link for Telegram on this Mac. Opening it sends the bot the code.
 */
function TelegramPairing({ bot, code }: { bot: string; code: string }): React.JSX.Element {
  const link = `https://t.me/${bot}?start=${code}`
  const qr = useMemo(
    () => `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { ecc: 'M', border: 2 }))}`,
    [link]
  )
  return (
    <div className="telegram-pair">
      <img src={qr} alt="QR code of the pairing link" width={132} height={132} />
      <p>
        To pair, scan this with your phone&apos;s camera. It opens @{bot} in Telegram: press Start.
        With Telegram on this Mac,{' '}
        <a href={`tg://resolve?domain=${bot}&start=${code}`} target="_blank" rel="noreferrer">
          open it here
        </a>{' '}
        instead.
      </p>
    </div>
  )
}

/** Where Control from Telegram stands: pairing, paired, or what went wrong. */
function TelegramStatusBlock({
  status
}: {
  status: TelegramStatus | undefined
}): React.JSX.Element | null {
  if (!status) return null
  const bot = status.bot ? `@${status.bot}` : 'your bot'
  return (
    <>
      {status.state === 'pairing' && status.bot && status.code && (
        <TelegramPairing bot={status.bot} code={status.code} />
      )}
      {status.state === 'ready' && (
        <p>
          Paired with {bot}.{' '}
          {status.linkedTitle ? (
            <>
              It controls <b>{status.linkedTitle}</b>.
            </>
          ) : (
            'No chat is linked yet.'
          )}
        </p>
      )}
      {status.error && <div className="msg-error">{status.error}</div>}
    </>
  )
}

/** The app's version and a check for a newer release, which it can install from here. */
function UpdatesBody({ version }: { version: string | undefined }): React.JSX.Element {
  /** The newer release found; null once a check finds none; undefined before any. */
  const [newer, setNewer] = useState<string | null>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const update = useUpdateInstall()

  useEffect(() => {
    // The app checks on its own every few hours; a release it found shows at once.
    window.api.update.available().then((found) => found && setNewer(found))
    return window.api.update.onAvailable(setNewer)
  }, [])

  async function check(): Promise<void> {
    setChecking(true)
    setError(undefined)
    try {
      setNewer(await window.api.update.check())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <p>
        {newer
          ? `Version ${newer} is out. Updating quits Barebone, installs it and opens it again.`
          : newer === null
            ? `Version ${version} is the latest.`
            : `This is version ${version ?? '…'}.`}
      </p>
      <div className="settings-row">
        {newer && (
          <button
            type="button"
            className="btn primary"
            disabled={update.installing}
            onClick={update.install}
          >
            {update.installing ? 'Updating…' : `Update to v${newer}`}
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={checking || update.installing}
          onClick={() => void check()}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {(error ?? update.error) && <div className="msg-error">{error ?? update.error}</div>}
    </>
  )
}
