# Barebone on a Linux server

Barebone runs in a Docker container on a Linux x64 server, in a minimal
desktop you open in your browser ([linuxserver's Selkies image](https://github.com/linuxserver/docker-baseimage-selkies),
Ubuntu 26.04). The desktop is Barebone, a file manager (PCManFM) and a
terminal, with a bar along the bottom to open them and switch between the open
windows. Nothing else. From your phone or laptop
you can also use Barebone through the remote link (zrok) and Telegram, as on
the Mac.

Everything Barebone keeps is on one Docker volume (`config`, the desktop's
`/config` folder). That covers chats, settings, the browser's cookies and
logins, the agents' logins (`~/.claude`, `~/.codex` and the others), and the
projects you clone there. Rebuilding the image or restarting the server keeps
all of it.

## What you need

- A Linux server on x64 with Docker and Docker Compose. At least 4 GB of
  memory, and 8 GB if you use VoxCPM2 or music.
- SSH access to it.

## Start it

On the server:

```sh
git clone <this repository> barebone && cd barebone
# Once: the container's AppArmor profile (see Sandboxes), kept across reboots.
cp deploy/vps/apparmor-barebone /etc/apparmor.d/barebone
apparmor_parser -r -W /etc/apparmor.d/barebone
BAREBONE_PASSWORD='choose-one' docker compose -f deploy/vps/compose.yml up -d --build
```

On a server without AppArmor, skip the two AppArmor lines; Docker then
ignores the profile.

The first build takes a while. It builds the app from source, then the
desktop image with the agents' CLIs: Claude Code, Codex, opencode, Cline and
Command Code.

## Open the desktop

The desktop listens on the server itself only, so it is never on the internet
on its own. The first time, before the remote link is set up, open a tunnel
from your computer:

```sh
ssh -L 3000:localhost:3000 you@your-server
```

Then open <http://localhost:3000/desktop/> and sign in as `barebone` with the
password you chose. If something else on the server has port 3000, start it
with `BAREBONE_PORT=3300` (any free port) and tunnel that port instead.

Barebone opens in the desktop. Browsers treat `localhost` as a secure page,
so the desktop's sound, microphone and clipboard work through the tunnel.

Once the remote link is on (below), a paired device opens the desktop from
the link instead: Desktop in the sidebar, or the link's address with
`/desktop/` added. It needs no tunnel and no password: Barebone signs in for
paired devices, and the desktop is reachable only by them.

## Set Barebone up

In the desktop:

1. Sign in to the agents you use. Click Terminal in the bar and run
   `claude`, `codex login`, `opencode auth login`, `cline auth` or
   `cmd login`. Or sign in from Barebone's Settings where it offers that.
2. Settings → Remote link: add your zrok token, turn the link on, and scan
   the QR code with your phone.
3. Optionally, Settings → Telegram.

Your phone then reaches Barebone through the remote link, and the desktop
through Desktop in its sidebar. To pair another browser, Pair a device there
shows a one-time QR code and link.

## Day to day

- **Projects:** clone them in the terminal (your home folder is `/config`,
  for example `git clone … ~/projects/app`), or make the folder in Files.
  Then in Barebone press New chat (Ctrl+N) and type the folder's path, like
  `~/projects/app`: Tab goes into a folder, Enter opens it as a project. This
  works from your phone too.
- **Closing Barebone** quits it, and the desktop starts it again at once.
  Running chats stop when it quits.
- **Files:** drop a file onto the desktop's page to upload it into
  `/config/Desktop`. The sidebar of the page (Files) downloads files from
  there.
- **Push to talk** is right Ctrl, not right ⌘.
- **Updating:** `git pull`, then the same `docker compose … up -d --build`.
  The app's own updater installs Mac releases only.

## Sandboxes

Chromium keeps each web page in a sandbox made of Linux user namespaces. The
desktop's image loaders (GTK's glycin, used by the folder picker) run in
bubblewrap, which also mounts inside its namespace. Docker allows both only
with `CAP_SYS_ADMIN`, which this container does not get. Instead,
`seccomp.json` is Docker's own profile
([moby/profiles](https://github.com/moby/profiles/blob/seccomp/v0.3.0/seccomp/default.json),
`seccomp/v0.3.0`) with one rule added: `clone`, `unshare`, `mount`,
`pivot_root` and `umount2` are allowed, as on a Linux desktop. The kernel
still refuses mounts outside a namespace a process made itself, so even root
in the container cannot mount anything. Pages stay sandboxed, and the
container keeps Docker's other limits.

On servers with AppArmor (Ubuntu, Debian), Docker's own AppArmor profile also
denies every mount, which stops bubblewrap. `apparmor-barebone` is that
profile ([moby/profiles](https://github.com/moby/profiles/blob/apparmor/v0.2.2/apparmor/testdata/default.golden),
`apparmor/v0.2.2`, which Docker 29 uses), unchanged for everything in the
container, plus a child profile that only `/usr/bin/bwrap` runs in: there,
and only there, `mount` and `pivot_root` are allowed. Ubuntu's restriction on user namespaces
(`kernel.apparmor_restrict_unprivileged_userns`) does not stop the container:
it was checked on Ubuntu 26.04 with Docker 29.9.

## Not on Linux

- iOS simulators need a Mac.
- Android emulators need `/dev/kvm`, which most servers do not have. A phone
  on USB is not possible on a remote server.
- Speech and music run on the CPU, so they are slower than on Apple Silicon.
- Videos the agents record have Opus sound, not AAC: Chromium on Linux has no
  AAC encoder. Browsers, Telegram and iPhones on iOS 17 or later play them.
