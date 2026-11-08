import { useEffect, useMemo, useState } from 'react'
import { renderSVG } from 'uqr'
import type { RemotePairing, RemoteStatus } from '../../../shared/types'
import { errorMessage } from '../lib/errors'
import { CopyIcon, GlobeIcon } from './icons'
import { SettingsCard, Switch } from './SettingsCard'

/**
 * The remote link (main/remote): this app in a browser on the user's phone or
 * another computer, through zrok. Set up here, on the Mac only: zrok joined to
 * the user's account, then devices paired by a QR code. In a browser through
 * the link, the card only signs that browser out.
 */
export function RemoteLinkCard(): React.JSX.Element {
  return window.api.remote ? <SignedInHere /> : <MacCard />
}

function SignedInHere(): React.JSX.Element {
  return (
    <SettingsCard icon={<GlobeIcon />} tone="teal" title="Remote link">
      <p>
        You&apos;re using Barebone through its remote link. The devices paired with it are listed in
        Settings on your Mac.
      </p>
      <div className="settings-row">
        <button
          className="btn"
          onClick={async () => {
            await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
            location.replace('/pair')
          }}
        >
          Sign out of this browser
        </button>
      </div>
    </SettingsCard>
  )
}

function useRemoteStatus(): RemoteStatus | undefined {
  const [status, setStatus] = useState<RemoteStatus>()
  useEffect(() => {
    window.api.remoteLink.status().then(setStatus)
    return window.api.remoteLink.onStatus(setStatus)
  }, [])
  return status
}

function MacCard(): React.JSX.Element {
  const status = useRemoteStatus()
  const [error, setError] = useState<string>()

  async function setOn(on: boolean): Promise<void> {
    setError(undefined)
    try {
      await window.api.remoteLink.setOn(on)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <SettingsCard
      icon={<GlobeIcon />}
      tone="teal"
      title="Remote link"
      action={
        status &&
        (status.zrok === 'enabled' || status.on) && (
          <span className="remote-head">
            {status.on && <LinkState status={status} />}
            <Switch label="Remote link" on={status.on} onChange={(on) => void setOn(on)} />
          </span>
        )
      }
    >
      <p>
        Use Barebone in a browser on your phone or another computer, through zrok&apos;s free
        tunnel. A device joins by scanning a QR code shown here. Barebone has to be open on a Mac
        that is awake.
      </p>
      {status?.zrok === 'disabled' && <JoinZrok />}
      {status?.on && status.link === 'online' && status.url && (
        <Pairing url={status.url} paired={status.sessions.length} />
      )}
      {status?.link === 'error' && status.error && (
        <div className="msg-error">The link is down: {status.error} It is tried again.</div>
      )}
      {error && <div className="msg-error">{error}</div>}
      {status && status.sessions.length > 0 && <Sessions status={status} />}
    </SettingsCard>
  )
}

function LinkState({ status }: { status: RemoteStatus }): React.JSX.Element {
  const label =
    status.link === 'online'
      ? 'Online'
      : status.link === 'starting'
        ? 'Starting…'
        : status.link === 'error'
          ? 'Reconnecting'
          : 'Off'
  return <span className={`remote-state ${status.link}`}>{label}</span>
}

/** Once: zrok joined to the user's account, which the tunnel runs on. */
function JoinZrok(): React.JSX.Element {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  return (
    <>
      <p>
        First, make a free account at <code>myzrok.io</code>. Its console shows your account token
        under &quot;Enable your environment&quot;. Paste it here.
      </p>
      <form
        className="settings-row"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(undefined)
          try {
            await window.api.remoteLink.enableZrok(token)
            setToken('')
          } catch (err) {
            setError(errorMessage(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        <input
          type="password"
          aria-label="zrok account token"
          placeholder="zrok account token"
          value={token}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={!token.trim() || busy}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

/**
 * Pairing a device: a one-time QR code that opens the link signed in. It
 * goes once used (a new device shows up) or expired.
 */
function Pairing({ url, paired }: { url: string; paired: number }): React.JSX.Element {
  const [pairing, setPairing] = useState<RemotePairing>()
  const [pairedBefore, setPairedBefore] = useState(paired)
  const [now, setNow] = useState(Date.now)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const qr = useMemo(
    () =>
      pairing &&
      `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(pairing.url, { ecc: 'M', border: 2 }))}`,
    [pairing]
  )

  // Used: a device more is paired than when the code was shown.
  if (pairing && paired > pairedBefore) setPairing(undefined)
  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  async function show(): Promise<void> {
    setError(undefined)
    try {
      setPairedBefore(paired)
      setPairing(await window.api.remoteLink.pair())
      setNow(Date.now())
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <p>
        Your link: <code className="remote-url">{url}</code>
      </p>
      {pairing && qr && left > 0 ? (
        <div className="telegram-pair">
          <img src={qr} alt="QR code that pairs a device" width={148} height={148} />
          <div className="remote-pair-text">
            <p>
              Scan it with your phone&apos;s camera. It works once, for{' '}
              {left >= 60 ? `${Math.ceil(left / 60)} more minutes` : `${left} more seconds`}. On
              another computer, copy the pairing link and open it there. zrok shows a notice page
              the first time: press Visit Share.
            </p>
            <div className="settings-row">
              <button
                className="btn remote-copy"
                onClick={async () => {
                  await navigator.clipboard.writeText(pairing.url)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                <CopyIcon width={14} height={14} />
                {copied ? 'Copied' : 'Copy pairing link'}
              </button>
              <button className="btn" onClick={() => setPairing(undefined)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-row">
          <button className="btn primary" onClick={() => void show()}>
            {pairing ? 'Show a new QR code' : 'Pair a device'}
          </button>
        </div>
      )}
      {error && <div className="msg-error">{error}</div>}
    </>
  )
}

const when = (time: number): string =>
  new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

function Sessions({ status }: { status: RemoteStatus }): React.JSX.Element {
  return (
    <div className="remote-list">
      <span className="settings-label">Paired devices</span>
      {status.sessions.map((session) => (
        <div key={session.id} className="remote-list-row">
          <div>
            <div>{session.device}</div>
            <p>
              Paired {when(session.createdAt)} · last used {when(session.lastSeenAt)}
            </p>
          </div>
          <button className="btn" onClick={() => void window.api.remoteLink.signOut(session.id)}>
            Sign out
          </button>
        </div>
      ))}
    </div>
  )
}
