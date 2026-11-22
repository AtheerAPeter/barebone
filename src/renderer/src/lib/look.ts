import { useEffect, useState } from 'react'
import type { Look } from '../../../shared/types'

/**
 * The user's own look.css (main/look.ts), drawn over the app's styles: the
 * last element of the body, so it comes after every stylesheet, even one
 * loaded later into the head. Each save on the Mac replaces it at once.
 */

const applied = new Set<() => void>()

/**
 * Something that measures the page to place what it draws over it (the
 * browser panel's page) measures again: a look can move a part without
 * resizing it.
 */
export function onLookApplied(listener: () => void): () => void {
  applied.add(listener)
  return () => applied.delete(listener)
}

/** The look as it is now, for Settings to show and switch; undefined until it is read. */
export function useLook(): Look | undefined {
  const [look, setLook] = useState<Look>()
  useEffect(() => {
    let changed = false
    const off = window.api.look.onChange((next) => {
      changed = true
      setLook(next)
    })
    void window.api.look.get().then((next) => changed || setLook(next))
    return off
  }, [])
  return look
}

/** Draw the look, and each change to it; `then` runs after each, for the page to follow it. */
export function followLook(then: (look: Look) => void): void {
  const style = document.createElement('style')
  style.id = 'custom-look'
  document.body.append(style)
  let changed = false
  const apply = (look: Look): void => {
    style.textContent = look.css
    then(look)
    for (const listener of applied) listener()
  }
  window.api.look.onChange((look) => {
    changed = true
    apply(look)
  })
  // A change that came while it was asked for is newer.
  void window.api.look.get().then((look) => changed || apply(look))
  // A page of the remote link missed the changes made while its connection was down.
  if (window.api.remote) {
    window.api.remoteBrowser.onReconnected(() => void window.api.look.get().then(apply))
  }
}
