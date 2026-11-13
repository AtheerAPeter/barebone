# syntax=docker/dockerfile:1
#
# Barebone on a Linux x64 server, in a minimal desktop you open in a browser
# (linuxserver's baseimage-selkies: Barebone, a file manager and a terminal,
# and a bar to open and switch between them). Built from the repository's root:
#
#   docker compose -f deploy/vps/compose.yml up -d --build
#
# See deploy/vps/README.md.

# The app, built on the machine that builds the image (its own CPU, so no
# emulation) for Linux x64.
FROM --platform=$BUILDPLATFORM node:22-bookworm AS app
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx electron-vite build && npx electron-builder --linux --publish never

# Ubuntu 26.04: the audio engine's Linux build (speech/index.ts) needs its glibc
# (2.43); Debian trixie's is older.
FROM ghcr.io/linuxserver/baseimage-selkies:ubunturesolute

ENV TITLE=Barebone \
    PIXELFLUX_WAYLAND=true \
    NO_GAMEPAD=true \
    START_DOCKER=false \
    # The agent CLIs below come with the image: a new image updates them.
    DISABLE_AUTOUPDATER=1

# What Electron needs beyond the base, unzip for the downloads Barebone
# unpacks (ffmpeg), libgomp1 for its audio engine, PCManFM as the file
# manager, waybar as the desktop's bar (svc-panel), Node.js (the base adds NodeSource's repository but not the package)
# and the agents' CLIs.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2t64 \
      libatspi2.0-0t64 \
      libcups2t64 \
      libgomp1 \
      libnotify4 \
      libsecret-1-0 \
      libuuid1 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libxss1 \
      nodejs \
      pcmanfm \
      unzip \
      waybar && \
    npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
      cline \
      command-code && \
    apt-get autoclean && \
    # /config is the user's volume: nothing from the build may stay in it, or
    # it would be root's there (opencode's installer writes its folders in ~).
    rm -rf /config/.cache /config/.config /config/.local /config/.npm \
      /var/lib/apt/lists/* /var/tmp/* /tmp/*

COPY --from=app /src/dist/linux-unpacked/ /opt/barebone/
COPY deploy/vps/root/ /

EXPOSE 3000
VOLUME /config
