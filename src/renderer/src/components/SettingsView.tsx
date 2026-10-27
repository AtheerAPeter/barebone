import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/errors'
import { useUpdateInstall } from '../lib/update'
import { ProvidersCard } from './ProvidersCard'

/**
 * `instructions`: the saved custom instructions.
 * `annotations`: whether agents get the browser tools that draw on pages.
 * `onProvidersChange`: a provider was added, changed or removed.
 */
export function SettingsView({
  instructions,
  annotations,
  onProvidersChange
}: {
  instructions: string | undefined
  annotations: boolean
  onProvidersChange: () => void
}): React.JSX.Element {
  return (
    <div className="settings">
      <h2>Settings</h2>
      <ProvidersCard onChange={onProvidersChange} />
      <InstructionsCard saved={instructions ?? ''} />
      <AnnotationsCard on={annotations} />
      <section className="settings-card">
        <h3>Web search</h3>
        <p>
          Chats on the app&apos;s own agent (Custom providers, OpenCode API, Cline API and Command
          Code API) search the web with Exa, as opencode does. Searches work without a key on
          Exa&apos;s free, rate-limited tier. With a key from <code>dashboard.exa.ai</code>, they
          use your Exa account.
        </p>
        <KeyForm label="Exa API key" saved={window.api.exa} />
      </section>
      <section className="settings-card">
        <h3>Voice input</h3>
        <p>
          Hold the microphone button in the composer, or the right ⌘ key, while you speak. When you
          let go, Whisper on Groq writes out what you said in the language you spoke, such as
          Arabic, English or German. A click on the button records until the next click. The
          recording is sent to Groq. It takes a Groq API key, free from{' '}
          <code>console.groq.com</code>.
        </p>
        <KeyForm label="Groq API key" saved={window.api.voice} />
      </section>
      <UpdatesCard />
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

/** The user's own instructions, added to the system prompt of the app's own agent's new chats. */
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
    <section className="settings-card">
      <h3>Custom instructions</h3>
      <p>
        Added to the system prompt of every new chat on the app&apos;s own agent (Custom providers,
        OpenCode API, Cline API and Command Code API) and of the subagents it starts, before the
        project&apos;s <code>AGENTS.md</code> or <code>CLAUDE.md</code>. A chat keeps the
        instructions it started with, so a change applies to chats started after it.
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
    </section>
  )
}

/** Whether agents get the browser tools that draw on pages, and the skill that teaches with them. */
function AnnotationsCard({ on }: { on: boolean }): React.JSX.Element {
  const [error, setError] = useState<string>()

  async function set(value: boolean): Promise<void> {
    setError(undefined)
    try {
      await window.api.setAnnotations(value)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section className="settings-card">
      <h3>Drawing on pages</h3>
      <p>
        Gives every agent browser tools that draw on the page in the browser panel (boxes and arrows
        with labels, a pointer, and a caption card) and wait for your clicks. Agents use them to
        teach and explain, and the built-in <code>browser-tutorial</code> skill shows them how.
        Turned off, the tools and the skill stay out of the chats&apos; context. A change applies to
        chats started after it.
      </p>
      <div className="segmented settings-switch" role="group" aria-label="Drawing on pages">
        <button type="button" className={on ? '' : 'on'} onClick={() => set(false)}>
          Off
        </button>
        <button type="button" className={on ? 'on' : ''} onClick={() => set(true)}>
          On
        </button>
      </div>
      {error && <div className="msg-error">{error}</div>}
    </section>
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
    <section className="settings-card">
      <h3>Updates</h3>
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
    </section>
  )
}
