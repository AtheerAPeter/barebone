import { useEffect, useState } from 'react'
import type { RemoteStatus } from '../../../shared/types'

/** The remote link's status, kept up to date; undefined while loading. */
export function useRemoteStatus(): RemoteStatus | undefined {
  const [status, setStatus] = useState<RemoteStatus>()
  useEffect(() => {
    window.api.remoteLink.status().then(setStatus)
    return window.api.remoteLink.onStatus(setStatus)
  }, [])
  return status
}
