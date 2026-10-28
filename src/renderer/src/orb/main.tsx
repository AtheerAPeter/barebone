import './orb.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Orb } from './Orb'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Orb />
  </StrictMode>
)
