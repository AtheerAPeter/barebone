import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { renderSVG } from 'uqr'
import {
  NAME_MAX,
  type DownloadId,
  type Downloads,
  type DownloadStatus,
  type MobileToolCheck,
  type TelegramStatus,
  type VoiceModelId
} from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { isMac, TALK_KEY } from '../lib/platform'
import { useRemoteStatus } from '../lib/remote'
import { useTelegramStatus } from '../lib/telegram'
import { useLook } from '../lib/look'
import { useUpdateInstall } from '../lib/update'
import { PHONE, useMedia } from '../lib/touch'
import { useHorizontalSwipe } from '../lib/gestures'
import {
  CloseIcon,
  DownloadIcon,
  GlobeIcon,
  MicIcon,
  MusicIcon,
  PaletteIcon,
  PencilIcon,
  PhoneIcon,
  PlugIcon,
  RouteIcon,
  SearchIcon,
  ServerIcon,
  SlidersIcon,
  SparklesIcon,
  SpeakerIcon,
  TagIcon,
  TelegramIcon,
  TextIcon,
  VideoIcon,
  WaveformIcon,
  WrenchIcon
} from './icons'
import { ProvidersBody } from './ProvidersCard'
import { RemoteLinkBody, SignedInBody } from './RemoteLinkCard'
import { SettingsDialog, SettingsRow, Switch } from './SettingsRow'

/** The sections of Settings, in the order the side lists them. */
const GROUPS = ['General', 'Agents', 'Abilities', 'Voice', 'Connections'] as const
type Group = (typeof GROUPS)[number]

const GROUP_ICONS: Record<Group, ReactNode> = {
  General: <SlidersIcon />,
  Agents: <SparklesIcon />,
  Abilities: <WrenchIcon />,
  Voice: <WaveformIcon />,
  Connections: <PlugIcon />
}

/**
 * One setting, as the page needs it: what it is called, what it does, what it
 * is now, its controls, and its fields if it has any.
 */
interface RowDef {
  id: string
  group: Group
  name: string
  /** What it does in a line, for the search. */
  summary: string
  /** Words the search finds it by, beyond its name and summary. */
  keywords: string
  icon: ReactNode
  /** What it does in full, in the info popover. */
  info: ReactNode
  /** What it is now, in words; a switch says it itself. */
  status?: string
  /** Missing something it needs to work, such as a key or a download. */
  needs?: boolean
  /** Its switch, if it has one. */
  toggle?: ReactNode
  /** Its fields, opened in a dialog by a button with this label. */
  panel?: { label: string; body: ReactNode }
}

/** The API keys main keeps, shown by their last four characters. */
interface KeyHints {
  exa?: string | null
  voice?: string | null
  telegram?: string | null
}

/**
 * Settings: every switch, key and link the app has, in sections listed at the
 * side. A line per setting: its name, what it is now, and its switch or the
 * button that opens its fields. What it does is behind the info button. The
 * search looks through every section at once.
 */
export function SettingsView({
  name,
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
  name: string | undefined
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
  const [section, setSection] = useState<Group>('General')
  /** The setting whose fields are open in a dialog. */
  const [open, setOpen] = useState<string>()
  const [hints, setHints] = useState<KeyHints>({})
  const [providers, setProviders] = useState<number>()
  const [version, setVersion] = useState<string>()
  const [downloads, setDownloads] = useState<Downloads>()
  /** What went wrong saving a switch, per setting. */
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const telegram = useTelegramStatus()
  const remote = useRemoteStatus()
  const look = useLook()
  /** A browser through the remote link: it signs itself out, it cannot link this Mac. */
  const remoteClient = Boolean(window.api.remote)
  const pageRef = useRef<HTMLDivElement>(null)
  const phone = useMedia(PHONE) && remoteClient

  // Swipe left/right across Settings sections on a phone; swiping right on the first opens the sidebar.
  useHorizontalSwipe(pageRef, {
    enabled: phone && !query.trim() && !open,
    canSwipe: (dir) => {
      const idx = GROUPS.indexOf(section)
      return dir === -1 ? idx < GROUPS.length - 1 : idx > 0
    },
    onSwipe: (dir) => {
      const idx = GROUPS.indexOf(section)
      const next = GROUPS[idx - dir]
      if (next) setSection(next)
    }
  })

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

  // A key shows only once saved: the button says when one is missing.
  const keyStatus = (hint: string | null | undefined): string | undefined =>
    hint ? 'Key saved' : undefined

  const rows: RowDef[] = [
    {
      id: 'name',
      group: 'General',
      name: 'Name',
      summary: 'What this Barebone is called, to tell several apart.',
      keywords: 'name rename profile title home screen instance server',
      icon: <TagIcon />,
      info: (
        <p>
          The title of the remote link&apos;s page, its tab, and the app&apos;s name when you add
          the page to a phone&apos;s Home Screen. Name each Barebone you use, such as Home or
          Server, to see at once which one is open. A Home Screen app keeps the name it was added
          with.
        </p>
      ),
      status: name ?? 'Barebone',
      panel: { label: 'Edit', body: <NameForm saved={name ?? ''} /> }
    },
    {
      id: 'look',
      group: 'General',
      name: 'Custom look',
      summary: 'Ask a chat to restyle Barebone: colors, layout, messages, tool calls, icons.',
      keywords: 'look theme css style colors fonts layout appearance icons reset custom',
      icon: <PaletteIcon />,
      info: (
        <p>
          Ask any chat to change how Barebone looks: its colors and fonts, where things sit, the
          messages, tool calls and icons, the window&apos;s buttons. The chat writes a stylesheet,{' '}
          <code>look.css</code>, and <code>look.json</code>, and the window changes as each is
          saved. The remote link&apos;s pages get the same look. The switch turns it off and on
          again; so does View → Custom Look in the menu bar, for when a look hides this page.
        </p>
      ),
      status: look && !look.files ? 'None yet' : undefined,
      toggle:
        look?.files && onOff('look', 'Custom look', look.on, (on) => window.api.look.setOn(on)),
      panel: look?.files
        ? {
            label: 'Reset',
            body: (
              <>
                <p>Go back to Barebone&apos;s own look. The look&apos;s files go to the Trash.</p>
                <div className="settings-row">
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => {
                      setOpen(undefined)
                      void run('look', () => window.api.look.reset())
                    }}
                  >
                    Reset to Barebone&apos;s look
                  </button>
                </div>
              </>
            )
          }
        : undefined
    },
    {
      id: 'updates',
      group: 'General',
      name: 'Updates',
      summary: CHECKS_UPDATES
        ? 'Barebone checks for a newer release every few hours.'
        : 'Barebone is updated by installing its new build.',
      keywords: 'version update release install newer',
      icon: <DownloadIcon />,
      info: (
        <p>
          {CHECKS_UPDATES
            ? 'Barebone checks for a newer release every few hours, and can install it from here.'
            : 'Barebone is updated by installing its new build in its place.'}
        </p>
      ),
      status: version ? `v${version}` : undefined,
      panel: CHECKS_UPDATES
        ? { label: 'Check', body: <UpdatesBody version={version} /> }
        : undefined
    },
    {
      id: 'providers',
      group: 'Agents',
      name: 'Providers',
      summary: 'The APIs chats can run on. Each one adds its models to the model picker.',
      keywords: 'custom api key base url openai anthropic ollama openrouter models server',
      icon: <ServerIcon />,
      info: (
        <p>
          Add any API that speaks OpenAI Chat Completions, OpenAI Responses or Anthropic Messages.
          Its models show in the model picker under Custom providers, and chats on them run on the
          app&apos;s own agent.
        </p>
      ),
      status: providers ? `${providers} added` : undefined,
      panel: {
        label: providers ? 'Manage' : 'Add',
        body: <ProvidersBody onChange={refreshProviders} />
      }
    },
    {
      id: 'instructions',
      group: 'Agents',
      name: 'Custom instructions',
      summary: 'One block of text every new chat is told before it starts.',
      keywords: 'prompt system agents claude codex rules language german',
      icon: <TextIcon />,
      info: (
        <p>
          Given to every new chat, on every agent. Claude Code and Codex get them in their system
          prompt, after their own; the app&apos;s own agent before the project&apos;s{' '}
          <code>AGENTS.md</code> or <code>CLAUDE.md</code>, and its subagents too. Agents that take
          no system prompt read them with the chat&apos;s first message. A chat keeps the
          instructions it started with, so a change applies to chats started after it.
        </p>
      ),
      status: instructions?.trim() ? 'Saved' : undefined,
      panel: {
        label: instructions?.trim() ? 'Edit' : 'Add',
        body: <InstructionsForm saved={instructions ?? ''} />
      }
    },
    {
      id: 'annotations',
      group: 'Abilities',
      name: 'Drawing on pages',
      summary: 'Agents can box, point and caption in the browser, then wait for your click.',
      keywords: 'browser draw arrows labels pointer tutorial annotations',
      icon: <PencilIcon />,
      info: (
        <>
          <p>
            Gives every agent browser tools that draw on the page in the browser panel (boxes and
            arrows with labels, a pointer, and a caption card) and wait for your clicks. Agents use
            them to teach and explain, and the built-in <code>browser-tutorial</code> skill shows
            them how. Turned off, the tools and the skill stay out of the chats&apos; context.
          </p>
          <Scope />
        </>
      ),
      toggle: onOff('annotations', 'Drawing on pages', annotations, window.api.setAnnotations)
    },
    {
      id: 'recording',
      group: 'Abilities',
      name: 'Recording videos',
      summary: 'Agents can record a browser tab as an MP4, with their voice.',
      keywords: 'video mp4 demo walkthrough record screen tab thumbnails ffmpeg',
      icon: <VideoIcon />,
      info: (
        <>
          <p>
            Gives every agent browser tools that record a tab of the browser panel as an MP4 video,
            for when you ask for a demo or a walkthrough. The video shows the page as you see it,
            with what agents draw on it, and the agent&apos;s voice is its sound when speech is on.
            The browser is signed in to your accounts, so what a page shows is in the video.
          </p>
          <Scope />
        </>
      ),
      toggle: onOff('recording', 'Recording videos', recording, window.api.setRecording),
      panel: {
        label: 'Thumbnails',
        body: (
          <>
            <p>
              With ffmpeg on this Mac, every video gets a thumbnail: its best still, saved as a JPEG
              beside it and put in as its first frame, so players and sites show that one.
            </p>
            <DownloadBody id="ffmpeg" what="ffmpeg" status={downloads?.ffmpeg} />
          </>
        )
      }
    },
    {
      id: 'music',
      group: 'Abilities',
      name: 'Music',
      summary:
        'Agents can make music on this Mac: a drum roll when a task is done, tracks for videos.',
      keywords:
        'music soundtrack background track stable audio video demo drum roll fanfare jingle',
      icon: <MusicIcon />,
      info: (
        <p>
          Agents make instrumental music from a description, with Stable Audio 3 Small on this Mac.
          When an agent tells you out loud that a task is done, it can play a drum roll before the
          news or a little tune under its words. It can also make a track to play quietly under the
          voice of a video it records. The model is downloaded once
          {downloads ? `, ${megabytes(downloads.music.total)}` : ''}.
        </p>
      ),
      status: music && downloads?.music.state === 'missing' ? 'Not downloaded' : undefined,
      needs: music && downloads?.music.state === 'missing',
      toggle: onOff('music', 'Music', music, window.api.setMusic),
      panel: {
        label: 'Model',
        body: <DownloadBody id="music" what="the music model" status={downloads?.music} />
      }
    },
    {
      id: 'codeTours',
      group: 'Abilities',
      name: 'Code walkthroughs',
      summary: 'Agents can walk you through code, stop after stop, in the code panel.',
      keywords: 'code tour route stops explain source panel narration',
      icon: <RouteIcon />,
      info: (
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
        </>
      ),
      toggle: onOff('codeTours', 'Code walkthroughs', codeTours, window.api.setCodeTours)
    },
    {
      id: 'mobile',
      group: 'Abilities',
      name: 'Mobile apps',
      summary: 'Agents can read and tap screens on simulators and emulators.',
      keywords: 'ios android simulator emulator device metro react native adb',
      icon: <PhoneIcon />,
      info: (
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
        </>
      ),
      toggle: onOff('mobile', 'Mobile apps', mobile, window.api.setMobile),
      panel: mobile ? { label: 'Tools', body: <MobileChecks /> } : undefined
    },
    {
      id: 'voice',
      group: 'Voice',
      name: 'Voice input',
      summary: `Hold ${TALK_KEY} or the mic to dictate; Whisper on Groq writes it out.`,
      keywords: 'speech to text dictate microphone whisper groq language arabic',
      icon: <MicIcon />,
      info: (
        <p>
          Hold the microphone button in the composer, or the {TALK_KEY} key, while you speak. When
          you let go, Whisper on Groq writes out what you said in the language you spoke, such as
          Arabic, English or German. A click on the button records until the next click. The
          recording is sent to Groq. It takes a Groq API key, free from{' '}
          <code>console.groq.com</code>.
        </p>
      ),
      status: keyStatus(hints.voice),
      panel: {
        label: hints.voice ? 'Manage' : 'Add key',
        body: (
          <KeyForm
            label="Groq API key"
            hint={hints.voice}
            save={window.api.voice.setKey}
            onSaved={(hint) => setHint('voice', hint)}
          />
        )
      }
    },
    {
      id: 'speech',
      group: 'Voice',
      name: 'Spoken messages',
      summary: 'Agents can say things out loud in a natural voice on this Mac.',
      keywords: 'voice speak out loud supertonic voxcpm audio language arabic german',
      icon: <SpeakerIcon />,
      info: (
        <p>
          Agents can say things out loud, such as when they need you or finish a long task, in a
          voice that runs on this Mac. Download a voice, turn it on, and pick which one speaks
          Arabic and which every other language.
        </p>
      ),
      status:
        speech &&
        downloads !== undefined &&
        VOICES.every(({ id }) => downloads[id].state !== 'ready')
          ? 'No voice yet'
          : undefined,
      needs:
        speech &&
        downloads !== undefined &&
        VOICES.every(({ id }) => downloads[id].state !== 'ready'),
      toggle: onOff('speech', 'Spoken messages', speech, window.api.speech.set),
      panel: {
        label: 'Voices',
        body: <VoicesBody on={speech} voices={voices} downloads={downloads} />
      }
    },
    {
      id: 'search',
      group: 'Connections',
      name: 'Web search',
      summary: 'Chats look things up on the web through Exa.',
      keywords: 'web lookup exa search key internet',
      icon: <SearchIcon />,
      info: (
        <p>
          Chats on the app&apos;s own agent (Custom providers, OpenCode API, Cline API and Command
          Code API) search the web with Exa, as opencode does. Searches work without a key on
          Exa&apos;s free, rate-limited tier. With a key from <code>dashboard.exa.ai</code>, they
          use your Exa account.
        </p>
      ),
      status: keyStatus(hints.exa),
      panel: {
        label: hints.exa ? 'Manage' : 'Add key',
        body: (
          <KeyForm
            label="Exa API key"
            hint={hints.exa}
            save={window.api.exa.setKey}
            onSaved={(hint) => setHint('exa', hint)}
          />
        )
      }
    },
    {
      id: 'telegram',
      group: 'Connections',
      name: 'Control from Telegram',
      summary: 'Guide a chat from your phone through your own bot.',
      keywords: 'telegram bot phone remote chat botfather pair qr',
      icon: <TelegramIcon />,
      info: (
        <p>
          Guide a chat from your phone. In Telegram, send <code>/newbot</code> to @BotFather and
          paste the token it gives you here. Then choose Control from Telegram in a chat&apos;s menu
          in the sidebar. What you send the bot goes to that chat, and chats it starts with{' '}
          <code>@chats</code> show as cards that keep up with what they do. Bot chats in Telegram
          are not end-to-end encrypted. Barebone has to be open on a Mac that is awake.
        </p>
      ),
      status: telegram?.state === 'ready' ? 'Paired' : undefined,
      panel: {
        label: telegram?.state === 'ready' ? 'Manage' : 'Set up',
        body: (
          <>
            <KeyForm
              label="Telegram bot token"
              hint={hints.telegram}
              save={window.api.telegram.setKey}
              onSaved={(hint) => setHint('telegram', hint)}
            />
            <TelegramStatusBlock status={telegram} />
          </>
        )
      }
    },
    {
      id: 'remote',
      group: 'Connections',
      name: 'Remote link',
      summary: 'Use chats from a browser on your phone or another computer.',
      keywords: 'remote zrok cloudflare tunnel phone browser pair qr link devices',
      icon: <GlobeIcon />,
      info: (
        <p>
          Use Barebone in a browser on your phone or another computer. A device joins by scanning a
          QR code, and paired devices see and control Barebone&apos;s browser tabs, which are signed
          in to your accounts.
        </p>
      ),
      status: remoteClient ? 'This browser' : undefined,
      toggle:
        !remoteClient && remote
          ? onOff('remote', 'Remote link', remote.on, window.api.remoteLink.setOn)
          : undefined,
      panel: {
        label: remoteClient ? 'Manage' : 'Devices',
        body: (
          <>
            {/* Through the link it signs the browser out; on a server, where the link is set
                up from its paired devices (main/remote), the link's own body comes first. */}
            {remoteClient && remote && <RemoteLinkBody status={remote} error={errors.remote} />}
            {remoteClient ? (
              <SignedInBody managedHere={Boolean(remote)} />
            ) : (
              <RemoteLinkBody status={remote} error={errors.remote} />
            )}
          </>
        )
      }
    }
  ]

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const searching = words.length > 0
  const matches = (row: RowDef): boolean => {
    const text = `${row.name} ${row.summary} ${row.keywords} ${row.group}`.toLowerCase()
    return words.every((word) => text.includes(word))
  }
  // A search looks through every section; otherwise the chosen one shows.
  const groups = searching ? GROUPS : [section]
  const found = searching && rows.some(matches)
  const dialog = rows.find((row) => row.id === open)

  return (
    <div className="settings">
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          <label className="settings-search">
            <SearchIcon />
            <input
              type="text"
              aria-label="Search settings"
              placeholder="Search"
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
          <div className="settings-sections">
            {GROUPS.map((group) => (
              <button
                key={group}
                type="button"
                className="settings-section"
                aria-current={!searching && section === group ? 'page' : undefined}
                onClick={() => {
                  setSection(group)
                  setQuery('')
                }}
              >
                {GROUP_ICONS[group]}
                {group}
              </button>
            ))}
          </div>
        </nav>
        <div className="settings-page" ref={pageRef}>
          {groups.map((group) => {
            const list = rows.filter((row) => row.group === group && matches(row))
            if (!list.length) return null
            return (
              <section className="settings-block" key={group}>
                <h3 className="settings-group">{group}</h3>
                <div className="settings-list">
                  {list.map((row) => (
                    <SettingsRow
                      key={row.id}
                      icon={row.icon}
                      name={row.name}
                      info={row.info}
                      status={row.status}
                      warn={row.needs}
                      error={errors[row.id]}
                      action={
                        <>
                          {row.panel && (
                            <button
                              type="button"
                              className="btn setting-action"
                              onClick={() => setOpen(row.id)}
                            >
                              {row.panel.label}
                            </button>
                          )}
                          {row.toggle}
                        </>
                      }
                    />
                  ))}
                </div>
              </section>
            )
          })}
          {searching && !found && (
            <div className="settings-empty">
              <p>No setting matches &ldquo;{query.trim()}&rdquo;.</p>
              <button type="button" className="btn" onClick={() => setQuery('')}>
                Clear search
              </button>
            </div>
          )}
        </div>
      </div>
      {dialog?.panel && (
        <SettingsDialog title={dialog.name} onClose={() => setOpen(undefined)}>
          {dialog.panel.body}
        </SettingsDialog>
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

/** What this Barebone is called; empty goes back to "Barebone". */
function NameForm({ saved }: { saved: string }): React.JSX.Element {
  const [text, setText] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  async function save(): Promise<void> {
    setSaving(true)
    setError(undefined)
    try {
      await window.api.setName(text)
      setText(text.trim().replace(/\s+/g, ' '))
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
          void save()
        }}
      >
        <input
          aria-label="Name"
          placeholder="Barebone"
          value={text}
          maxLength={NAME_MAX}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={saving || text.trim() === saved}>
          Save
        </button>
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

/**
 * Releases install on the Mac only (main/updates.ts): elsewhere, as in the
 * app's window on a Linux server, a new build is installed in its place.
 */
const CHECKS_UPDATES = isMac || window.api.remote

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

  if (!CHECKS_UPDATES) return <p>{`This is version ${version ?? '…'}.`}</p>

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
