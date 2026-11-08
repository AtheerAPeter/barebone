import './pair.css'

/**
 * The remote link's pairing page. The QR code on the Mac opens it with a
 * one-time code after the #, which never leaves the browser except to the Mac
 * here (main/remote/server.ts), which then sets the session cookie. Kept apart
 * from the app's code, so a device that is not paired loads none of it.
 */

const message = document.getElementById('message') as HTMLParagraphElement

const UNPAIRED =
  'To use Barebone here, open Settings on your Mac, go to Remote link and scan its QR code.'

async function pair(): Promise<void> {
  const code = location.hash.slice(1)
  // Out of the address bar and the history: it is spent once used.
  history.replaceState(null, '', location.pathname)
  message.classList.remove('error')
  if (!code) {
    message.textContent = UNPAIRED
    return
  }
  message.textContent = 'Pairing with your Mac…'
  try {
    const response = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code })
    })
    if (response.ok) {
      location.replace('/')
      return
    }
    const result = (await response.json().catch(() => ({}))) as { error?: string }
    message.textContent = result.error ?? UNPAIRED
    message.classList.add('error')
  } catch {
    message.textContent = 'Your Mac could not be reached. Check that Barebone is open on it.'
    message.classList.add('error')
  }
}

void pair()
// A pairing link opened in a tab already on this page only changes what follows the #.
window.addEventListener('hashchange', () => void pair())
