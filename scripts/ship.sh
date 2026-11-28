#!/usr/bin/env bash
# Fast, parallel release & deployment pipeline for Barebone.
#
#   npm run ship -- [options]
#
# Options:
#   --bump           Bump patch version, commit "Release <ver>", and tag v<ver>
#   --notes <text>   Release notes for GitHub release (default: auto-generated)
#   --no-release     Skip git push and GitHub release
#   --no-local       Skip updating local /Applications/Barebone.app
#   --no-linux       Skip updating the Linux laptop
#   --full-linux     Force a full electron-builder rebuild on the Linux laptop
#   --skip-checks    Skip parallel lint and typecheck
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LINUX_HOST="${BAREBONE_LINUX_HOST:-atheer@192.168.2.54}"
LINUX_SSH_KEY="${BAREBONE_SSH_KEY:-$HOME/.ssh/id_ed25519}"

BUMP=0
DO_RELEASE=1
DO_LOCAL=1
DO_LINUX=1
FULL_LINUX=0
SKIP_CHECKS=0
NOTES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bump) BUMP=1 ;;
    --notes) NOTES="${2:-}"; shift ;;
    --no-release) DO_RELEASE=0 ;;
    --no-local) DO_LOCAL=0 ;;
    --no-linux) DO_LINUX=0 ;;
    --full-linux) FULL_LINUX=1 ;;
    --skip-checks) SKIP_CHECKS=1 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

START_TS=$(date +%s)
elapsed() { printf "%ds" "$(( $(date +%s) - START_TS ))"; }
step() { printf "\n[%s] › %s\n" "$(elapsed)" "$1"; }
ok()   { printf "[%s] ✓ %s\n" "$(elapsed)" "$1"; }

# 1. Optional version bump + tag
if [ "$BUMP" -eq 1 ]; then
  step "Bumping patch version"
  npm version patch --no-git-tag-version >/dev/null
  VERSION=$(node -p "require('./package.json').version")
  git add package.json package-lock.json
  git commit -m "Release ${VERSION}"
  git tag "v${VERSION}"
  ok "Tagged v${VERSION}"
else
  VERSION=$(node -p "require('./package.json').version")
fi

printf "\nShipping Barebone v%s\n" "$VERSION"

# 2. Parallel lint + typecheck
if [ "$SKIP_CHECKS" -eq 0 ]; then
  step "Running typecheck (node + web) and lint in parallel"
  npm run typecheck:node &
  p_node=$!
  npm run typecheck:web &
  p_web=$!
  npm run lint &
  p_lint=$!
  wait "$p_node"
  wait "$p_web"
  wait "$p_lint"
  ok "Checks passed"
fi

# 3. Single Vite build
step "Building bundles (electron-vite)"
npx electron-vite build
ok "Bundles built"

# 4. Mac DMG packaging (DMG-only, ULFO, no zip/blockmap)
if [ "$DO_RELEASE" -eq 1 ] || [ "$DO_LOCAL" -eq 1 ]; then
  step "Packaging signed macOS DMG (v${VERSION})"
  npx electron-builder --mac --publish never
  DMG="dist/barebone-${VERSION}.dmg"
  APP_SRC="dist/mac-arm64/Barebone.app"
  [ -f "$DMG" ] || { echo "Missing expected DMG: $DMG" >&2; exit 1; }
  [ -d "$APP_SRC" ] || { echo "Missing expected app: $APP_SRC" >&2; exit 1; }
  ok "Packaged $DMG ($(du -h "$DMG" | awk '{print $1}'))"
fi

# 5. Parallel deploy functions
deploy_local() {
  local target="/Applications"
  [ -w "$target" ] || { target="$HOME/Applications"; mkdir -p "$target"; }
  local staging
  staging=$(mktemp -d "$target/.Barebone-update.XXXXXX")
  trap 'rm -rf "$staging"' RETURN

  ditto "$APP_SRC" "$staging/Barebone.app"
  xattr -dr com.apple.quarantine "$staging/Barebone.app" 2>/dev/null || true

  if pgrep -af "Barebone.app/Contents/MacOS" >/dev/null 2>&1; then
    osascript -e 'quit app "Barebone"' >/dev/null 2>&1 || true
    for _ in $(seq 20); do
      pgrep -af "Barebone.app/Contents/MacOS" >/dev/null 2>&1 || break
      sleep 0.5
    done
  fi

  [ ! -e "$target/Barebone.app" ] || mv "$target/Barebone.app" "$staging/old.app"
  if ! mv "$staging/Barebone.app" "$target/Barebone.app"; then
    [ ! -e "$staging/old.app" ] || mv "$staging/old.app" "$target/Barebone.app"
    echo "Failed to install Barebone.app into $target" >&2
    return 1
  fi
  open "$target/Barebone.app"
  echo "Local Mac updated to v${VERSION} (${target}/Barebone.app)"
}

deploy_release() {
  git push origin main "v${VERSION}"
  if gh release view "v${VERSION}" >/dev/null 2>&1; then
    gh release upload "v${VERSION}" "$DMG" --clobber
  elif [ -n "$NOTES" ]; then
    gh release create "v${VERSION}" "$DMG" --title "$VERSION" --notes "$NOTES"
  else
    gh release create "v${VERSION}" "$DMG" --title "$VERSION" --generate-notes
  fi
  echo "GitHub release v${VERSION} published"
}

compute_deps_hash() {
  {
    node -p "require('./package.json').devDependencies.electron"
    shasum -a 256 package-lock.json
    if [ -d resources ]; then
      find resources -type f | LC_ALL=C sort | xargs shasum -a 256
    fi
  } | shasum -a 256 | awk '{print $1}'
}

deploy_linux() {
  local ssh_opts=(-i "$LINUX_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=8)
  local deps_hash
  deps_hash=$(compute_deps_hash)

  local remote_state
  remote_state=$(ssh "${ssh_opts[@]}" "$LINUX_HOST" '
    hash=$(cat /opt/barebone/.deps-hash 2>/dev/null || echo "")
    asar_ok=0
    [ -f /opt/barebone/resources/app.asar ] && [ -f "$HOME/barebone-src/node_modules/@electron/asar/bin/asar.js" ] && asar_ok=1
    echo "$hash $asar_ok"
  ')
  local remote_hash asar_ok
  read -r remote_hash asar_ok <<<"$remote_state"

  if [ "$FULL_LINUX" -eq 0 ] && [ "$asar_ok" -eq 1 ] && [ "$remote_hash" = "$deps_hash" ]; then
    echo "Linux deps unchanged — using fast app.asar hot-swap"
    tar -czf - out package.json install.sh | ssh "${ssh_opts[@]}" "$LINUX_HOST" "
      set -euo pipefail
      ASAR=\$HOME/barebone-src/node_modules/@electron/asar/bin/asar.js
      STAGE=\$HOME/.barebone/asar-stage
      TMP=\$(mktemp -d /tmp/barebone-fast.XXXXXX)
      trap 'rm -rf \"\$TMP\"' EXIT

      mkdir -p \"\$TMP/in\"
      tar -xzf - -C \"\$TMP/in\"

      if [ ! -d \"\$STAGE\" ] || [ \"\$(cat \"\$STAGE/.deps-hash\" 2>/dev/null || true)\" != '$deps_hash' ]; then
        rm -rf \"\$STAGE\"
        node \"\$ASAR\" extract /opt/barebone/resources/app.asar \"\$STAGE\"
        echo '$deps_hash' > \"\$STAGE/.deps-hash\"
      fi

      rm -rf \"\$STAGE/out\"
      mv \"\$TMP/in/out\" \"\$STAGE/out\"
      cp \"\$TMP/in/package.json\" \"\$STAGE/package.json\"
      [ -d \"\$HOME/barebone-src\" ] && cp \"\$TMP/in/package.json\" \"\$HOME/barebone-src/package.json\" || true

      node \"\$ASAR\" pack \"\$STAGE\" \"\$TMP/app.asar\" \
        --unpack-dir '{resources,node_modules/onnxruntime-node/bin,node_modules/node-pty/prebuilds}'

      systemctl --user stop barebone.service
      sudo install -m 644 \"\$TMP/app.asar\" /opt/barebone/resources/app.asar.new
      sudo mv /opt/barebone/resources/app.asar.new /opt/barebone/resources/app.asar
      sudo install -m 755 \"\$TMP/in/install.sh\" /opt/barebone/resources/install.sh
      systemctl --user start barebone.service
      sleep 2
      systemctl --user is-active --quiet barebone.service
    "
    echo "Linux laptop hot-swapped to v${VERSION}"
  else
    echo "Linux deps changed or uninitialized — running full build on Linux laptop"
    git archive --format=tar.gz HEAD | ssh "${ssh_opts[@]}" "$LINUX_HOST" 'cat > /tmp/barebone-src.tar.gz'
    ssh "${ssh_opts[@]}" "$LINUX_HOST" "
      set -euo pipefail
      ~/.barebone/update.sh
      tail -n 5 ~/.barebone/update.log
      grep -q 'UPDATE-EXIT 0' <(tail -n 3 ~/.barebone/update.log)
      systemctl --user stop barebone.service
      sudo rm -rf /opt/barebone.old
      sudo mv /opt/barebone /opt/barebone.old
      sudo mv /opt/barebone.new /opt/barebone
      sudo rm -rf /opt/barebone.old
      echo '$deps_hash' | sudo tee /opt/barebone/.deps-hash >/dev/null
      rm -rf ~/.barebone/asar-stage /tmp/barebone-src.tar.gz
      systemctl --user start barebone.service
      sleep 2
      systemctl --user is-active --quiet barebone.service
    "
    echo "Linux laptop rebuilt and updated to v${VERSION}"
  fi
}

step "Deploying targets in parallel"
LOG_DIR=$(mktemp -d)
trap 'rm -rf "$LOG_DIR"' EXIT

pids=()
names=()

if [ "$DO_LOCAL" -eq 1 ]; then
  deploy_local >"$LOG_DIR/local.log" 2>&1 &
  pids+=($!)
  names+=("local")
fi
if [ "$DO_RELEASE" -eq 1 ]; then
  deploy_release >"$LOG_DIR/release.log" 2>&1 &
  pids+=($!)
  names+=("release")
fi
if [ "$DO_LINUX" -eq 1 ]; then
  deploy_linux >"$LOG_DIR/linux.log" 2>&1 &
  pids+=($!)
  names+=("linux")
fi

fail=0
for i in "${!pids[@]}"; do
  name="${names[$i]}"
  if wait "${pids[$i]}"; then
    ok "${name}: $(tail -n 1 "$LOG_DIR/${name}.log")"
  else
    printf "[%s] ✗ %s failed:\n" "$(elapsed)" "$name" >&2
    cat "$LOG_DIR/${name}.log" >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1
printf "\n✓ Shipped Barebone v%s in %s\n" "$VERSION" "$(elapsed)"
