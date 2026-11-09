import { useEffect, useMemo, useState } from 'react'
import { renderSVG } from 'uqr'
import { errorMessage } from '../lib/errors'
import { CopyIcon } from './icons'
import { Switch } from './SettingsRow'
import type { RemotePairing, RemoteStatus } from '../../../shared/types'

/**
 * The remote link (main/remote): this app in a browser on the user's phone or
 * another computer, through zrok. These are the body and the status of its
 * Settings row: set up on the Mac only, while a browser through the link signs
 * that browser out.
 */
export function SignedInBody(): React.JSX.Element {
  return (
    <>
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
    </>
  )
}

/**
 * The Mac's side of the row: zrok, the pairing QR code and the paired devices.
 * Its switch is the row's, which saves through main and passes what went wrong.
 */
export function RemoteLinkBody({
  status,
  error
}: {
  status: RemoteStatus | undefined
  error?: string
}): React.JSX.Element {
  return (
    <>
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
      {status?.zrok === 'enabled' && <BrowserAccess on={status.browser} />}
    </>
  )
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

/**
 * Whether paired devices may see and use the browser's tabs, which are signed
 * in to the user's accounts. Off until turned on here; the link cannot turn it on.
 */
function BrowserAccess({ on }: { on: boolean }): React.JSX.Element {
  const [error, setError] = useState<string>()
  return (
    <div className="remote-list">
      <div className="remote-list-row">
        <div>
          <div>Phones can use the browser</div>
          <p>
            Paired devices see and control this Mac&apos;s browser tabs, which are signed in to your
            accounts.
          </p>
        </div>
        <Switch
          label="Phones can use the browser"
          on={on}
          onChange={(next) => {
            setError(undefined)
            window.api.remoteLink.setBrowser(next).catch((e) => setError(errorMessage(e)))
          }}
        />
      </div>
      {error && <div className="msg-error">{error}</div>}
    </div>
  )
}

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
