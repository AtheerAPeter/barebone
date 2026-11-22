import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { isMac } from './lib/platform'
import { trackGlassPresses } from './lib/glass-press'
import { followLook } from './lib/look'

// Only the Mac's window has its buttons in the page, at the sidebar's top left,
// unless the user's look.json hides them.
followLook(({ hideWindowButtons }) =>
  document.documentElement.classList.toggle('no-window-buttons', !isMac || hideWindowButtons)
)
trackGlassPresses()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
