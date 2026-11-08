/**
 * What the code the app and the `barebone` command share needs of the program
 * it runs in: where Barebone keeps its data, its version, and how a link is
 * opened for the user. The app (electron-runtime.ts) and the command
 * (cli/runtime.ts) each set it up in their entry's first import, before any
 * module that reads its data loads.
 */
export interface Runtime {
  /** The folder Barebone keeps its data in. */
  userData: string
  version: string
  /** Open a link for the user: in their browser on the Mac, or sent to them from a server. */
  openExternal(url: string): Promise<void>
}

let runtime: Runtime | undefined

export function setRuntime(value: Runtime): void {
  runtime = value
}

function current(): Runtime {
  if (!runtime) throw new Error('The runtime is used before its entry point set it up.')
  return runtime
}

export function userDataPath(): string {
  return current().userData
}

export function appVersion(): string {
  return current().version
}

export function openExternal(url: string): Promise<void> {
  return current().openExternal(url)
}
