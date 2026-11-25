import { useEffect, useState } from 'react'
import type { ChatWorkspace } from '../../../shared/types'

/** How often the checkouts are read again while the chat works. */
const WHILE_WORKING_MS = 15_000

/**
 * The git checkouts a chat works in (main/workspaces.ts), read when the chat
 * opens, as its turns start and end, every little while during one, and when
 * the window comes back to the front.
 */
export function useChatWorkspaces(chatId: string | undefined, running: boolean): ChatWorkspace[] {
  const [read, setRead] = useState<{ chatId: string; workspaces: ChatWorkspace[] }>()
  useEffect(() => {
    if (!chatId) return
    let current = true
    const load = (): void => {
      window.api.chatWorkspaces(chatId).then(
        (workspaces) => current && setRead({ chatId, workspaces }),
        // Out of reach for now (a busy disk, a removed folder): the last read stays.
        () => undefined
      )
    }
    load()
    const timer = running ? setInterval(load, WHILE_WORKING_MS) : undefined
    window.addEventListener('focus', load)
    return () => {
      current = false
      clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [chatId, running])
  // Another chat's checkouts never show for this one while its own load.
  return read && read.chatId === chatId ? read.workspaces : []
}

let homePromise: Promise<string> | undefined

/** This computer's home folder, to show paths under it with ~; undefined until known. */
export function useHome(): string | undefined {
  const [home, setHome] = useState<string>()
  useEffect(() => {
    let current = true
    homePromise ??= window.api.fileManager.home()
    homePromise.then(
      (path) => current && setHome(path),
      () => undefined
    )
    return () => {
      current = false
    }
  }, [])
  return home
}
