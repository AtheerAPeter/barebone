import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

/**
 * The `barebone` command (src/cli), built on its own: `npm run build:cli`.
 * It shares the app's main-process code, and electron-vite's main build
 * resolves that code's `?asset` imports as the app's build does. A build of
 * its own, not another input of the app's: modules that read Barebone's data
 * as they load must run after the entry's runtime (cli/runtime.ts), and
 * chunks shared between two entries would run before it.
 */
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  version: string
}

export default defineConfig({
  main: {
    define: { BAREBONE_VERSION: JSON.stringify(version) },
    build: {
      outDir: 'out/cli',
      // Bundled, as the app's main process is; Playwright only finds the
      // Chromium it installed, from its own package.
      externalizeDeps: false,
      rollupOptions: {
        input: { main: resolve('src/cli/main.ts') },
        external: ['playwright-core']
      }
    },
    resolve: {
      alias: {
        'playwright-injected-script': resolve(
          'node_modules/playwright-core/lib/generated/injectedScriptSource.js'
        ),
        'playwright-keyboard-layout': resolve(
          'node_modules/playwright-core/lib/server/usKeyboardLayout.js'
        )
      }
    }
  }
})
