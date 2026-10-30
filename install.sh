#!/usr/bin/env bash
# Installs or updates Barebone on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/AtheerAPeter/barebone/main/install.sh | bash
#
# Files fetched with curl are not marked as downloaded from the internet, so the
# app opens without the "Apple could not verify" prompt that a browser download
# gets.
set -euo pipefail

REPO="AtheerAPeter/barebone"
NAME="Barebone"
APP="$NAME.app"
# The app was called Just Harness up to 1.0.63; an update replaces it.
FORMER_NAME="Just Harness"
FORMER_APP="$FORMER_NAME.app"

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' RED=$'\033[31m' BLUE=$'\033[34m' RESET=$'\033[0m'
else
  BOLD="" DIM="" GREEN="" RED="" BLUE="" RESET=""
fi

step() { printf "  ${BLUE}›${RESET} %s\n" "$1"; }
done_() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "\n  ${RED}✗ %s${RESET}\n\n" "$1" >&2; exit 1; }

printf "\n  ${BOLD}${NAME}${RESET} ${DIM}· the basics are all you need${RESET}\n\n"

[ "$(uname -s)" = "Darwin" ] || fail "$NAME runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "$NAME needs a Mac with Apple Silicon (M1 or newer)."

step "Finding the latest release"
release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") ||
  fail "Could not reach GitHub. Check your connection and try again."
url=$(printf '%s' "$release" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
version=$(printf '%s' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$url" ] || fail "The latest release has no macOS download."
done_ "Found ${version}"

work=$(mktemp -d)
mount=""
cleanup() {
  [ -n "$mount" ] && hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

step "Downloading"
curl -fL --progress-bar "$url" -o "$work/$NAME.dmg" || fail "The download failed. Try again."
done_ "Downloaded"

step "Installing"
mount=$(hdiutil attach "$work/$NAME.dmg" -nobrowse -readonly | tail -1 | cut -f3)
[ -d "$mount/$APP" ] || fail "The download did not contain $APP."

# /Applications when it is writable (admin accounts), otherwise ~/Applications.
target="/Applications"
if [ ! -w "$target" ]; then
  target="$HOME/Applications"
  mkdir -p "$target"
fi

# The app is quit first: replacing it while it runs leaves the old version
# open, and `open` below would only bring that one forward. Just Harness is
# quit too, since the new app moves its data folder only once it has quit.
#
# pgrep -a: pgrep leaves its own ancestors out of the match otherwise, and when
# the app runs this script to update itself, the app is one of them; it would
# not be found, so not quit, and the old version would stay open.
quit() {
  pgrep -af "$1.app/Contents/MacOS" >/dev/null 2>&1 || return 0
  step "Quitting $1"
  osascript -e "quit app \"$1\"" >/dev/null 2>&1 || true
  for _ in $(seq 30); do
    pgrep -af "$1.app/Contents/MacOS" >/dev/null 2>&1 || return 0
    sleep 1
  done
  fail "$1 did not quit, so $NAME was not updated. Quit it and try again."
}
quit "$NAME"
quit "$FORMER_NAME"

rm -rf "$target/$APP" "$target/$FORMER_APP"
ditto "$mount/$APP" "$target/$APP"
xattr -dr com.apple.quarantine "$target/$APP" 2>/dev/null || true
done_ "Installed to $target"

open "$target/$APP"

printf "\n  ${GREEN}${BOLD}${NAME} ${version} is ready.${RESET}\n"
printf "  ${DIM}Run the same command again any time to update.${RESET}\n\n"
