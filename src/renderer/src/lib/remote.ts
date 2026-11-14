import { useEffect, useState } from 'react'
import type { RemoteStatus } from '../../../shared/types'

/** The remote link's status, kept up to date; undefined while loading. */
export function useRemoteStatus(): RemoteStatus | undefined {
  const [status, setStatus] = useState<RemoteStatus>()
  useEffect(() => {
    // Through the link to a Mac it is the Mac's to show: refused, it stays undefined.
    window.api.remoteLink.status().then(setStatus, () => undefined)
    return window.api.remoteLink.onStatus(setStatus)
  }, [])
  return status
}
