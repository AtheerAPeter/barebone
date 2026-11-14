# syntax=docker/dockerfile:1
#
# Barebone on a Linux x64 server, with no screen: it draws on a virtual one
# (Xvfb), and you use it through its remote link, Files and Terminal included.
# Built from the repository's root:
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

# Node.js for the agents' CLIs, taken whole from its official image: Ubuntu's
# npm package brings hundreds of packages of its own.
FROM node:22-bookworm-slim AS node

# Ubuntu 26.04: the audio engine's Linux build (speech/index.ts) needs its glibc
# (2.43); Debian trixie's is older.
FROM ubuntu:26.04

ENV LANG=C.UTF-8 \
    TZ=Etc/UTC \
    HOME=/config \
    # Barebone runs with no screen of its own (src/main/remote).
    BAREBONE_HEADLESS=1 \
    # The agent CLIs below come with the image: a new image updates them.
    DISABLE_AUTOUPDATER=1

# What Electron needs, Xvfb for its screen, fonts for the pages the browser
# shows, libgomp1 for the audio engine, unzip for the downloads Barebone
# unpacks (ffmpeg), and what a terminal is used for: git, ssh, an editor, sudo.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-core \
      git \
      less \
      libasound2t64 \
      libatspi2.0-0t64 \
      libcups2t64 \
      libgbm1 \
      libgomp1 \
      libgtk-3-0t64 \
      libnotify4 \
      libnss3 \
      libsecret-1-0 \
      libuuid1 \
      libxss1 \
      libxtst6 \
      nano \
      openssh-client \
      procps \
      sudo \
      unzip \
      xauth \
      xdg-utils \
      xvfb && \
    rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    npm install -g \
      @anthropic-ai/claude-code \
      @openai/codex \
      opencode-ai \
      cline \
      command-code && \
    npm cache clean --force && \
    # /config is the user's volume: nothing from the build may stay in it, or
    # it would be root's there (opencode's installer writes its folders in ~).
    rm -rf /config

# The user Barebone and its terminals run as: uid 1000, whose home is the
# volume (/config), and who may use sudo, as on a desktop. Ubuntu's image
# comes with a user of that uid, "ubuntu", which goes.
RUN userdel --remove ubuntu && \
    useradd --uid 1000 --user-group --home-dir /config --no-create-home --shell /bin/bash barebone && \
    echo 'barebone ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/barebone && \
    chmod 440 /etc/sudoers.d/barebone && \
    install -d -o barebone -g barebone /config

COPY --from=app /src/dist/linux-unpacked/ /opt/barebone/
COPY deploy/vps/barebone-start /usr/local/bin/barebone-start

# Every library the app needs is here: a missing one fails the build, not the server.
RUN ! ldd /opt/barebone/barebone | grep 'not found'

USER barebone
WORKDIR /config
VOLUME /config
CMD ["barebone-start"]
