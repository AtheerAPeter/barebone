import './pair.css'

/**
 * The remote link's pairing page. A pairing link (the QR code in Settings →
 * Remote link, or the one a server prints in its log) opens it with a one-time
 * code after the #, which never leaves the browser except to Barebone here
 * (main/remote/server.ts), which then sets the session cookie. Kept apart from
 * the app's code, so a device that is not paired loads none of it.
 */

const message = document.getElementById('message') as HTMLParagraphElement
const form = document.getElementById('paste') as HTMLFormElement
const field = document.getElementById('paste-link') as HTMLInputElement

const UNPAIRED =
  'To use Barebone here, open a pairing link, or paste one below. Settings → Remote link → Pair a device makes one.'

/**
 * Whether this device is signed in after all. The app comes here when it cannot
 * tell (main/remote/server.ts or the tunnel was down, as while the computer
 * restarts), and a Home Screen app opens again on the page it was left on, which
 * has no address bar to leave by: so this page goes back to the app by itself
 * once the link answers for a session it knows. zrok's notice page answers 200
 * too, but not with JSON.
 */
async function signedIn(): Promise<boolean> {
  const response = await fetch('/api/session', {
    credentials: 'same-origin',
    cache: 'no-store'
  }).catch(() => undefined)
  return (
    response?.status === 200 &&
    (response.headers.get('content-type') ?? '').startsWith('application/json')
  )
}

/** How often a page left here asks again whether it is signed in, while it is shown. */
const RECHECK_MS = 10_000

async function backIfSignedIn(): Promise<void> {
  if (document.visibilityState === 'visible' && (await signedIn())) location.replace('/')
}

function show(text: string, error = false): void {
  message.textContent = text
  message.classList.toggle('error', error)
}

/** The code in a pasted pairing link (what follows its #), or the code pasted alone. */
function codeIn(text: string): string {
  const trimmed = text.trim()
  const hash = trimmed.indexOf('#')
  return hash >= 0 ? trimmed.slice(hash + 1) : trimmed
}

async function pairWith(code: string): Promise<void> {
  show('Pairing…')
  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code })
    })
    if (response.ok) {
      // A browser can refuse the session cookie (blocked cookies for the site):
      // going on to the app would only bring it back here without saying why.
      if (await signedIn()) return location.replace('/')
      show(
        'Paired, but this browser did not keep the sign-in. Allow cookies for this site, then pair again with a new link.',
        true
      )
      return
    }
    const result = (await response.json().catch(() => ({}))) as { error?: string }
    show(result.error ?? UNPAIRED, true)
  } catch {
    show('Barebone could not be reached. Check that it is running, then try again.', true)
  }
}

/** A pairing link opened here: its code is after the #. */
async function pairFromAddress(): Promise<void> {
  const code = location.hash.slice(1)
  // Out of the address bar and the history: it is spent once used.
  history.replaceState(null, '', location.pathname)
  if (code) return pairWith(code)
  if (await signedIn()) return location.replace('/')
  show(UNPAIRED)
  form.hidden = false
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const code = codeIn(field.value)
  if (!code) return field.focus()
  field.value = ''
  void pairWith(code)
})

void pairFromAddress()
// A pairing link opened in a tab already on this page only changes what follows the #.
window.addEventListener('hashchange', () => void pairFromAddress())
// Opened again from the Home Screen or the tab switcher, or kept open: back to the app
// as soon as the link answers for this device's session.
document.addEventListener('visibilitychange', () => void backIfSignedIn())
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void backIfSignedIn()
})
setInterval(() => void backIfSignedIn(), RECHECK_MS)
