import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { trackGlassPresses } from './lib/glass-press'
import { isMac } from './lib/platform'

// Only the Mac's window has Liquid Glass behind it (main/index.ts, addGlass).
if (!isMac) document.documentElement.classList.add('no-glass')
trackGlassPresses()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
