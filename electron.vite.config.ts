import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Dependencies are bundled in, not loaded from node_modules at runtime: one
    // file starts faster than hundreds of small ones read out of the asar.
    // ONNX Runtime is native code, which cannot be bundled: it is a dependency
    // the app ships (see electron-builder.yml).
    build: {
      externalizeDeps: false,
      minify: true,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The speech engine's own process (main/speech).
          'speech-worker': resolve('src/main/speech/worker.ts')
        },
        external: ['onnxruntime-node']
      }
    },
    resolve: {
      alias: {
        // Playwright's in-page runtime, bundled into the main process. Its package
        // does not export this file, so it is resolved by path (the version is pinned).
        'playwright-injected-script': resolve(
          'node_modules/playwright-core/lib/generated/injectedScriptSource.js'
        ),
        // Key names, codes and key codes of a US keyboard, for typing as key presses.
        'playwright-keyboard-layout': resolve(
          'node_modules/playwright-core/lib/server/usKeyboardLayout.js'
        )
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // Imports nothing but `electron`, so it builds to one file: a sandboxed
          // preload cannot load other files.
          page: resolve('src/preload/page.ts'),
          // The agent orb's page, sandboxed too.
          orb: resolve('src/preload/orb.ts')
        },
        // Browser pages are sandboxed, and a sandboxed preload must be a plain
        // CommonJS script. `.cjs` because package.json declares "type": "module".
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      // electron-vite leaves output unminified by default; the renderer loads faster minified.
      minify: true,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // The agent orb over the browser page (main/orb.ts).
          orb: resolve('src/renderer/orb.html')
        }
      },
      // Fonts stay files: the page's CSP allows fonts from 'self', not data: URLs.
      assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined)
    }
  }
})
