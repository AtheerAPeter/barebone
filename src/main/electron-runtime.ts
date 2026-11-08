import { app, shell } from 'electron'
import { setRuntime } from './runtime'

/** The app's runtime (runtime.ts): imported by index.ts before the modules that use it. */
setRuntime({
  userData: app.getPath('userData'),
  version: app.getVersion(),
  openExternal: (url) => shell.openExternal(url)
})
