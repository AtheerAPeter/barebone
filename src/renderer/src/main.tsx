import './styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { isMac } from './lib/platform'

// Only the Mac's window has its buttons in the page, at the sidebar's top left.
if (!isMac) document.documentElement.classList.add('no-window-buttons')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
