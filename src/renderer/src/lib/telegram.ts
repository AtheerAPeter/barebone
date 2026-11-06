import { useEffect, useState } from 'react'
import type { TelegramStatus } from '../../../shared/types'

/** Control from Telegram's status, kept up to date; undefined while loading. */
export function useTelegramStatus(): TelegramStatus | undefined {
  const [status, setStatus] = useState<TelegramStatus>()
  useEffect(() => {
    window.api.telegram.status().then(setStatus)
    return window.api.telegram.onStatus(setStatus)
  }, [])
  return status
}
