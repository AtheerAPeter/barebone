import './styles.css'
import './remote/remote.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { trackGlassPresses } from './lib/glass-press'
import { ConnectionBar } from './remote/ConnectionBar'
import { remoteApi } from './remote/socket'

/**
 * The app's UI in a browser, through the remote link (main/remote): the same
 * App, with the window's API over a WebSocket to the Mac. Served only to a
 * signed-in browser; the sign-in page is login.html.
 */
const remote = remoteApi()
window.api = remote.api

// A pairing link opened in a browser already paired lands here with its code after the #:
// unused, it goes from the address bar and the history.
if (location.hash) history.replaceState(null, '', location.pathname)

trackGlassPresses()

// After window.api is set: the app reads it as it loads.
void import('./App').then(({ default: App }) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <ConnectionBar onConnection={remote.onConnection} />
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
)
