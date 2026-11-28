import type { Configuration } from 'electron-builder'

// Each platform has one complete list of files, and there is no top-level one.
// electron-builder turns a top-level `files` into a file set of its own, apart
// from a platform's, so with both it copies the app twice: only the first copy
// gets its default exclusions (.git, the output folder dist, node_modules), and
// each lets through what the other leaves out. With the two lists, 1.4.10 packed
// the repository, its history and every earlier build into a 3.7 GB dmg.
const files = [
  '!**/.vscode/*',
  // Agent worktrees and settings, which would otherwise be packed whole.
  '!.claude/**',
  '!src/*',
  '!electron.vite.config.{js,ts,mjs,cjs}',
  '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
  '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
  '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}',
  // What is for working on the app, not running it: design previews (untracked
  // ones too, which would be published with a release), the server image's
  // setup, build scripts, stray files at the top, and type-check caches.
  '!{design-preview,deploy,scripts}/**',
  '!{index.html,*.tsbuildinfo}',
  // The Codex and Claude Code adapters run the user's own CLI (main/agents.ts),
  // so the copies their packages bring, 600 MB of them, stay out.
  '!node_modules/@openai/codex{,-*}/**',
  '!node_modules/@anthropic-ai/claude-agent-sdk-*/**',
  '!node_modules/{sonner,inspect-webkit}/**',
  // The terminal's pty (main/terminals.ts) runs from its prebuilt binaries; its
  // sources are for building them.
  '!node_modules/node-pty/{src,third_party,scripts,binding.gyp}'
]

const config: Configuration = {
  appId: 'dev.barebone.app',
  productName: 'Barebone',
  directories: {
    buildResources: 'build'
  },
  asarUnpack: [
    'resources/**',
    // Native code is loaded from real files, not from inside the asar.
    'node_modules/onnxruntime-node/bin/**',
    'node_modules/node-pty/prebuilds/**'
  ],
  // The app updates itself with the script users install it with (main/updates.ts).
  extraResources: [{ from: 'install.sh', to: 'install.sh' }],
  win: {
    files,
    executableName: 'barebone'
  },
  nsis: {
    artifactName: '${name}-${version}-setup.${ext}',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  mac: {
    // Only build the signed DMG: install.sh and in-app updates (main/updates.ts) install the .dmg,
    // so skipping the unused .zip target and blockmaps cuts packaging time roughly in half.
    target: [{ target: 'dmg', arch: ['arm64'] }],
    files: [
      ...files,
      // The speech engine's runtime (main/speech): only this Mac's build, and one
      // copy of its library (the binding loads libonnxruntime.1.dylib; the
      // versioned file is an identical copy).
      '!node_modules/onnxruntime-node/bin/napi-v*/{linux,win32}/**',
      '!node_modules/onnxruntime-node/bin/napi-v*/darwin/*/libonnxruntime.*.*.*.dylib',
      // iOS simulators' input and accessibility trees (main/device-ios.ts) use only
      // serve-sim's native module, not its server, sources or helpers, nor the
      // packages they use.
      '!node_modules/serve-sim/{Sources,Tests,scripts,src}/**',
      '!node_modules/serve-sim/dist/{simax,simcam,simduo}/**',
      '!node_modules/serve-sim/dist/*.{js,cjs}',
      '!node_modules/node-pty/prebuilds/{linux,win32}-*/**'
    ],
    asarUnpack: ['node_modules/serve-sim/dist/native/**'],
    // Signed with a self-signed certificate in the login keychain of the Mac that
    // builds releases. macOS remembers a privacy grant (Desktop, microphone) by the
    // signature's designated requirement: an ad-hoc one is the build's hash, so each
    // update asked again; this certificate's stays the same across builds. Downloads
    // still show the unidentified-developer prompt; a Developer ID and notarization
    // would remove it. Without the certificate the build fails rather than ship an
    // unsigned app, which macOS reports as "damaged".
    identity: 'Barebone Code Signing',
    forceCodeSigning: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSMicrophoneUsageDescription: 'Barebone uses the microphone for voice input in chats.',
      NSDocumentsFolderUsageDescription:
        "Application requests access to the user's Documents folder.",
      NSDownloadsFolderUsageDescription:
        "Application requests access to the user's Downloads folder."
    },
    notarize: false
  },
  dmg: {
    artifactName: '${name}-${version}.${ext}',
    // Hardware-accelerated LZFSE on Apple Silicon (macOS 10.11+): much faster and slightly smaller than UDZO.
    format: 'ULFO',
    // Updates use install.sh + GitHub Releases, not electron-updater blockmaps.
    writeUpdateInfo: false
  },
  // Linux on x64, for a server: run in a container on a virtual screen
  // (deploy/vps), so an unpacked folder rather than an installer.
  linux: {
    target: [{ target: 'dir', arch: 'x64' }],
    executableName: 'barebone',
    category: 'Utility',
    files: [
      ...files,
      // The speech engine's runtime: only the x64 Linux build.
      '!node_modules/onnxruntime-node/bin/napi-v*/{darwin,win32}/**',
      '!node_modules/onnxruntime-node/bin/napi-v*/linux/arm64/**',
      '!node_modules/node-pty/prebuilds/{darwin-*,win32-*,linux-arm64}/**',
      // Mac only: iOS simulators.
      '!node_modules/serve-sim/**'
    ]
  },
  appImage: {
    artifactName: '${name}-${version}.${ext}'
  },
  npmRebuild: false
}

export default config
