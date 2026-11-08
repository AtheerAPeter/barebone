import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { renderSVG } from 'uqr'
import type { MobileToolCheck, SpeechStatus } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { useTelegramStatus } from '../lib/telegram'
import { useUpdateInstall } from '../lib/update'
import {
  DownloadIcon,
  MicIcon,
  PencilIcon,
  PhoneIcon,
  RouteIcon,
  SearchIcon,
  SpeakerIcon,
  TelegramIcon,
  TextIcon,
  VideoIcon
} from './icons'
import { ProvidersCard } from './ProvidersCard'
import { RemoteLinkCard } from './RemoteLinkCard'
import { SettingsCard, Switch, type SettingsTone } from './SettingsCard'

/**
 * `instructions`: the saved custom instructions.
 * `annotations`: whether agents get the browser tools that draw on pages.
 * `recording`: whether agents get the browser tools that record a tab as a video.
 * `codeTours`: whether agents get the walkthrough tool, which plays in the code panel.
 * `mobile`: whether agents get the device tools, for mobile apps.
 * `speech`: whether agents may speak out loud (the speak tool).
 * `onProvidersChange`: a provider was added, changed or removed.
 */
export function SettingsView({
  instructions,
  annotations,
  recording,
  codeTours,
  mobile,
  speech,
  onProvidersChange
}: {
  instructions: string | undefined
  annotations: boolean
  recording: boolean
  codeTours: boolean
  mobile: boolean
  speech: boolean
  onProvidersChange: () => void
}): React.JSX.Element {
  return (
    <div className="settings">
      <h2>Settings</h2>
      <ProvidersCard onChange={onProvidersChange} />
      <InstructionsCard saved={instructions ?? ''} />
      <AnnotationsCard on={annotations} />
      <RecordingCard on={recording} />
      <CodeToursCard on={codeTours} />
      <MobileCard on={mobile} />
      <SettingsCard icon={<SearchIcon />} tone="blue" title="Web search">
        <p>
          Chats on the app&apos;s own agent (Custom providers, OpenCode API, Cline API and Command
          Code API) search the web with Exa, as opencode does. Searches work without a key on
          Exa&apos;s free, rate-limited tier. With a key from <code>dashboard.exa.ai</code>, they
          use your Exa account.
        </p>
        <KeyForm label="Exa API key" saved={window.api.exa} />
      </SettingsCard>
      <SettingsCard icon={<MicIcon />} tone="green" title="Voice input">
        <p>
          Hold the microphone button in the composer, or the right ⌘ key, while you speak. When you
          let go, Whisper on Groq writes out what you said in the language you spoke, such as
          Arabic, English or German. A click on the button records until the next click. The
          recording is sent to Groq. It takes a Groq API key, free from{' '}
          <code>console.groq.com</code>.
        </p>
        <KeyForm label="Groq API key" saved={window.api.voice} />
      </SettingsCard>
      <TelegramCard />
      <RemoteLinkCard />
      <SpeechCard on={speech} />
      {/* Updating quits and reopens the app: something to do on the Mac. */}
      {!window.api.remote && <UpdatesCard />}
    </div>
  )
}

/** An API key the main process keeps: replaced or removed here, shown by its last four characters. */
function KeyForm({
  label,
  saved
}: {
  label: string
  saved: {
    keyHint: () => Promise<string | null>
    setKey: (key: string | null) => Promise<string | null>
  }
}): React.JSX.Element {
  /** The saved key's last four characters; null when none is saved, undefined while loading. */
  const [hint, setHint] = useState<string | null>()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string>()

  useEffect(() => {
    saved.keyHint().then(setHint)
  }, [saved])

  async function save(value: string | null): Promise<void> {
    setError(undefined)
    try {
      setHint(await saved.setKey(value))
      setKey('')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <form
        className="settings-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) save(key)
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
        <button type="submit" className="btn primary" disabled={!key.trim()}>
          {hint ? 'Replace' : 'Save'}
        </button>
        {hint && (
          <button type="button" className="btn" onClick={() => save(null)}>
            Remove
          </button>
        )}
      </form>
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/** Control from Telegram: the bot token, pairing, and which chat the bot controls. */
function TelegramCard(): React.JSX.Element {
  const status = useTelegramStatus()
  const bot = status?.bot ? `@${status.bot}` : 'your bot'
  return (
    <SettingsCard icon={<TelegramIcon />} tone="blue" title="Control from Telegram">
      <p>
        Guide a chat from your phone. In Telegram, send <code>/newbot</code> to @BotFather and paste
        the token it gives you here. Then choose Control from Telegram in a chat&apos;s menu in the
        sidebar. What you send the bot goes to that chat, and chats it starts with{' '}
        <code>@chats</code> show as cards that keep up with what they do. Bot chats in Telegram are
        not end-to-end encrypted. Barebone has to be open on a Mac that is awake.
      </p>
      <KeyForm label="Telegram bot token" saved={window.api.telegram} />
      {status?.state === 'pairing' && status.bot && status.code && (
        <TelegramPairing bot={status.bot} code={status.code} />
      )}
      {status?.state === 'ready' && (
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
      {status?.error && <div className="msg-error">{status.error}</div>}
    </SettingsCard>
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

/** The user's own instructions, given to every agent's new chats. */
function InstructionsCard({ saved }: { saved: string }): React.JSX.Element {
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
    <SettingsCard icon={<TextIcon />} tone="orange" title="Custom instructions">
      <p>
        Given to every new chat, on every agent. Claude Code and Codex get them in their system
        prompt, after their own; the app&apos;s own agent before the project&apos;s{' '}
        <code>AGENTS.md</code> or <code>CLAUDE.md</code>, and its subagents too. Agents that take no
        system prompt read them with the chat&apos;s first message. A chat keeps the instructions it
        started with, so a change applies to chats started after it.
      </p>
      <form
        className="settings-instructions"
        onSubmit={(e) => {
          e.preventDefault()
          save()
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
    </SettingsCard>
  )
}

/** A card whose switch turns a setting main keeps on or off, with what went wrong saving it. */
function ToggleCard({
  icon,
  tone,
  title,
  on,
  save,
  children
}: {
  icon: ReactNode
  tone: SettingsTone
  title: string
  on: boolean
  save: (on: boolean) => Promise<void>
  children: ReactNode
}): React.JSX.Element {
  const [error, setError] = useState<string>()

  async function set(value: boolean): Promise<void> {
    setError(undefined)
    try {
      await save(value)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <SettingsCard
      icon={icon}
      tone={tone}
      title={title}
      action={<Switch label={title} on={on} onChange={set} />}
    >
      {children}
      {error && <div className="msg-error">{error}</div>}
    </SettingsCard>
  )
}

/** Whether agents get the browser tools that draw on pages, and the skill that teaches with them. */
function AnnotationsCard({ on }: { on: boolean }): React.JSX.Element {
  return (
    <ToggleCard
      icon={<PencilIcon />}
      tone="pink"
      title="Drawing on pages"
      on={on}
      save={window.api.setAnnotations}
    >
      <p>
        Gives every agent browser tools that draw on the page in the browser panel (boxes and arrows
        with labels, a pointer, and a caption card) and wait for your clicks. Agents use them to
        teach and explain, and the built-in <code>browser-tutorial</code> skill shows them how.
        Turned off, the tools and the skill stay out of the chats&apos; context. A change applies to
        chats started after it.
      </p>
    </ToggleCard>
  )
}

/** Whether agents get the browser tools that record a tab as a video. */
function RecordingCard({ on }: { on: boolean }): React.JSX.Element {
  return (
    <ToggleCard
      icon={<VideoIcon />}
      tone="red"
      title="Recording videos"
      on={on}
      save={window.api.setRecording}
    >
      <p>
        Gives every agent browser tools that record a tab of the browser panel as an MP4 video, for
        when you ask for a demo or a walkthrough. The video shows the page as you see it, with what
        agents draw on it, and the agent&apos;s voice is its sound when speech is on. The browser is
        signed in to your accounts, so what a page shows is in the video. A change applies to chats
        started after it.
      </p>
    </ToggleCard>
  )
}

/** Whether agents get the walkthrough tool, which walks the user through code in the code panel. */
function CodeToursCard({ on }: { on: boolean }): React.JSX.Element {
  return (
    <ToggleCard
      icon={<RouteIcon />}
      tone="purple"
      title="Code walkthroughs"
      on={on}
      save={window.api.setCodeTours}
    >
      <p>
        Gives every agent a tool that walks you through code in the code panel: how a feature works,
        where data goes, or what your uncommitted changes do. The agent plans the whole route, and
        it plays stop after stop, the voice saying each one when speech is on. The code it passes
        through stays on screen, file by file, with short notes on its lines and links showing where
        it goes next. You can pause it and step back and forth. Turned off, the tool stays out of
        the chats&apos; context; source control in the panel works either way. A change applies to
        chats started after it.
      </p>
    </ToggleCard>
  )
}

/**
 * Whether agents get the device tools, for mobile apps,
 * and which of the tools they use are installed.
 */
function MobileCard({ on }: { on: boolean }): React.JSX.Element {
  const [checks, setChecks] = useState<MobileToolCheck[]>()

  useEffect(() => {
    if (on) window.api.devices.checks().then(setChecks)
  }, [on])

  return (
    <ToggleCard
      icon={<PhoneIcon />}
      tone="gray"
      title="Mobile apps"
      on={on}
      save={window.api.setMobile}
    >
      <p>
        Gives every agent tools that run and test mobile apps on the iOS simulators and Android
        emulators and phones on this computer: reading the screen, tapping, swiping and typing,
        opening links and apps, device settings, the apps&apos; logs and crashes, and Metro for
        React Native and Expo. You watch and use the devices in the Simulator app and the
        emulator&apos;s own window; the tools work only while an agent uses them. Turned off, the
        tools stay out of the chats&apos; context. A change applies to chats started after it.
      </p>
      {on && checks && (
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
      )}
    </ToggleCard>
  )
}

/** What the samples say, in the languages the voice was chosen for. */
const SAMPLES = [
  {
    language: 'ar',
    name: 'Arabic',
    text: 'مرحبا، أنا الصوت الذي يتحدث به وكلاؤك. سأخبرك عندما يحتاج شيء إلى انتباهك.'
  },
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

const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`

/**
 * Whether agents may speak out loud (the speak tool), and the voice they speak
 * with, which runs on this Mac and is downloaded once.
 */
function SpeechCard({ on }: { on: boolean }): React.JSX.Element {
  const [status, setStatus] = useState<SpeechStatus>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    window.api.speech.status().then(setStatus)
    return window.api.speech.onStatus(setStatus)
  }, [])

  async function run(action: () => Promise<void>): Promise<void> {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <SettingsCard
      icon={<SpeakerIcon />}
      tone="teal"
      title="Spoken messages"
      action={
        <Switch
          label="Spoken messages"
          on={on}
          onChange={(value) => run(() => window.api.speech.set(value))}
        />
      }
    >
      <p>
        Agents can say things out loud, such as when they need you or finish a long task, in a
        natural voice that runs on this Mac: Arabic, English, German and 28 more languages. The
        voice (Supertonic 3) is downloaded once{status ? `, ${megabytes(status.total)}` : ''}.
      </p>
      {status?.state === 'downloading' && (
        <div className="speech-download">
          <div className="speech-progress">
            <div style={{ width: `${(100 * status.received) / status.total}%` }} />
          </div>
          <span>
            Downloading the voice: {megabytes(status.received)} of {megabytes(status.total)}
          </span>
          <button type="button" className="btn" onClick={() => window.api.speech.cancelDownload()}>
            Cancel
          </button>
        </div>
      )}
      {on && status?.state === 'missing' && (
        <div className="settings-row">
          <button
            type="button"
            className="btn primary"
            onClick={() => run(() => window.api.speech.download())}
          >
            Download the voice
          </button>
        </div>
      )}
      {status?.state === 'failed' && (
        <>
          <div className="msg-error">{status.message}</div>
          <div className="settings-row">
            <button
              type="button"
              className="btn"
              onClick={() => run(() => window.api.speech.download())}
            >
              Try again
            </button>
          </div>
        </>
      )}
      {status?.state === 'ready' && (
        <div className="settings-row speech-ready">
          <span className="settings-label">Hear it</span>
          {SAMPLES.map((sample) => (
            <button
              key={sample.language}
              type="button"
              className="btn"
              onClick={() => run(() => window.api.speech.sample(sample.text, sample.language))}
            >
              {sample.name}
            </button>
          ))}
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            onClick={() => run(() => window.api.speech.remove())}
          >
            Remove the voice
          </button>
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
    </SettingsCard>
  )
}

/** The app's version and a check for a newer release, which it can install from here. */
function UpdatesCard(): React.JSX.Element {
  const [version, setVersion] = useState<string>()
  /** The newer release found; null once a check finds none; undefined before any. */
  const [newer, setNewer] = useState<string | null>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const update = useUpdateInstall()

  useEffect(() => {
    window.api.appVersion().then(setVersion)
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
    <SettingsCard icon={<DownloadIcon />} tone="gray" title="Updates">
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
          onClick={check}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {(error ?? update.error) && <div className="msg-error">{error ?? update.error}</div>}
    </SettingsCard>
  )
}
