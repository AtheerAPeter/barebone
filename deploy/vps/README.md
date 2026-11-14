# Barebone on a Linux server

Barebone runs in a Docker container on a Linux x64 server, with no screen of
its own. You use it from your phone or laptop through its remote link (zrok),
in the browser or added to the home screen. Files and Terminal in its sidebar
cover what you would otherwise need a desktop for: browsing, uploading and
downloading files, and a shell to clone projects and sign in to agents.

Everything Barebone keeps is on one Docker volume (`config`, the container's
home folder `/config`). That covers chats, settings, the browser's cookies and
logins, the agents' logins (`~/.claude`, `~/.codex` and the others), and the
projects you clone there. Rebuilding the image or restarting the server keeps
all of it.

## What you need

- A Linux server on x64 with Docker and Docker Compose. At least 4 GB of
  memory, and 8 GB if you use VoxCPM2 or music.
- A free zrok account (<https://myzrok.io>). Its console shows your account
  token under "Enable your environment".

## Start it

On the server:

```sh
git clone <this repository> barebone && cd barebone
BAREBONE_ZROK_TOKEN='your zrok token' docker compose -f deploy/vps/compose.yml up -d --build
```

The first build takes a while. It builds the app from source, then the image
with the agents' CLIs: Claude Code, Codex, opencode, Cline and Command Code.

Then pair your phone:

```sh
docker compose -f deploy/vps/compose.yml logs barebone
```

Until a device is paired, Barebone prints a pairing link and its QR code
there. Open the link on your phone or scan the code. It works once, for 5
minutes; `docker compose -f deploy/vps/compose.yml restart` prints a new one.

To pair more devices later, open Settings → Remote link on a paired device and
press Pair a device. The same place lists the paired devices and signs them
out.

## Set Barebone up

1. Sign in to the agents you use: open Terminal in the sidebar and run
   `claude`, `codex login`, `opencode auth login`, `cline auth` or `cmd login`.
   Or sign in from Barebone's Settings where it offers that.
2. Optionally, Settings → Telegram.

## Day to day

- **Projects:** clone them in Terminal (your home folder is `/config`, for
  example `git clone … ~/projects/app`), or make the folder in Files. Then
  press New chat and type the folder's path, like `~/projects/app`: Tab goes
  into a folder, Enter opens it as a project.
- **Files:** the ⋮ on a row renames, moves, downloads or deletes it. Upload
  puts files from your device into the folder shown. Deleting is for good:
  there is no Trash on the server.
- **Terminal:** shells keep running when you close the view or your phone
  locks, and every device sees the same ones. On a phone, the key row above
  the keyboard has Esc, Tab, Ctrl and the arrows.
- **Restarts:** if Barebone quits, Docker starts it again. Running chats stop
  when it quits.
- **Push to talk** is right Ctrl, not right ⌘.
- **Updating:** `git pull`, then the same `docker compose … up -d --build`. The
  app's own updater installs Mac releases only.

## Sandboxes

Chromium keeps each web page in a sandbox made of Linux user namespaces.
Docker allows creating them only with `CAP_SYS_ADMIN`, which this container
does not get. Instead, `seccomp.json` is Docker's own profile
([moby/profiles](https://github.com/moby/profiles/blob/seccomp/v0.3.0/seccomp/default.json),
`seccomp/v0.3.0`) with one rule added: `clone` and `unshare` are allowed, as
on a Linux desktop. Pages stay sandboxed, and the container keeps Docker's
other limits, its AppArmor profile included.

## Not on Linux

- iOS simulators need a Mac.
- Android emulators need `/dev/kvm`, which most servers do not have. A phone
  on USB is not possible on a remote server.
- Speech and music run on the CPU, so they are slower than on Apple Silicon.
- Videos the agents record have Opus sound, not AAC: Chromium on Linux has no
  AAC encoder. Browsers, Telegram and iPhones on iOS 17 or later play them.
