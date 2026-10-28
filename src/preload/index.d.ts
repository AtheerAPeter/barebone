import type { Api } from './index'
import type { OrbApi } from './orb'

declare global {
  interface Window {
    api: Api
    /** Only in the agent orb's page (renderer/orb.html). */
    orb: OrbApi
  }
}
