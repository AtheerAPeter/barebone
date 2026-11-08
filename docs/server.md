# Barebone on a server

The `barebone` command runs Barebone without its window, on a Linux server, so you control it entirely from Telegram. It runs the same agents and the same bot as the app: the linked chat, `/projects`, `/new`, `/model`, `/thinking`, `/stop`, permissions and forms as buttons, and a card for each chat the linked chat starts.

Agents get the same browser tools as in the app, backed by a headless Chromium on the server. Their screenshots reach Telegram as photos, as they do from the Mac.

What stays on the Mac: screen recording (videos of tabs), phone simulators and devices, writing out voice notes, the spoken voice, and code walkthroughs. The bot says so when you send a voice note to the server.

## Install

You need a Debian or Ubuntu server, Node.js 24, git, and SSH access to the private repository through a deploy key.

1. Give the server read access to the repository. On the server:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/barebone_deploy -N ''
   cat ~/.ssh/barebone_deploy.pub
   ```

   Add the printed key on GitHub under the repository's Settings → Deploy keys (read access is enough). Then tell SSH to use it:

   ```sh
   cat >> ~/.ssh/config <<'EOF'
   Host github.com
     IdentityFile ~/.ssh/barebone_deploy
     IdentitiesOnly yes
   EOF
   ```

2. Get the code, build the command, and link it:

   ```sh
   git clone git@github.com:AtheerAPeter/barebone.git ~/barebone
   cd ~/barebone
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
   npm run build:cli
   sudo npm link
   ```

   `npm link` puts `barebone` on your PATH. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` skips the Electron download, which the server does not need.

3. Install Chromium and the system libraries it needs (this runs `apt-get`, so it asks for sudo):

   ```sh
   npx playwright-core install --with-deps chromium
   ```

   To use a Chromium you installed another way, set `BAREBONE_CHROMIUM` to its path.

4. Install at least one agent and sign it in, as you would on the Mac: `opencode`, `cline`, `codex`, Claude Code (`claude`) or Command Code (`cmd`).

5. Make a bot with [@BotFather](https://t.me/BotFather) and copy its token. Then:

   ```sh
   barebone setup
   ```

   It asks for the bot token, the project folders on the server, and the agent new chats start with. Run it again any time to change them; Enter keeps what is set.

6. Start it and pair your phone:

   ```sh
   barebone start
   ```

   It prints a `https://t.me/…?start=…` link. Open it on your phone and press Start. The bot answers only the Telegram account that paired. Send `/new` to start a chat in a project, or `/projects` to pick one.

## Keep it running

Run Barebone as a systemd service so it starts at boot and restarts if it stops. Stop the `barebone start` you ran by hand first (Ctrl+C), then:

```sh
barebone service | sudo tee /etc/systemd/system/barebone.service
sudo systemctl daemon-reload
sudo systemctl enable --now barebone
```

`barebone service` prints a unit that runs `barebone start` as the user you run it as. Run it as that user, not with sudo. Read the logs, including the pairing link, with:

```sh
journalctl -u barebone -f
```

Run Barebone as a normal user, not root. As root, Chromium has to run without its sandbox.

## Update

```sh
cd ~/barebone
git pull
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build:cli
sudo systemctl restart barebone
```

## Where things are

Barebone keeps its data in `~/.local/share/barebone`: projects, chats, the bot's settings and the browser's profile. Set `BAREBONE_HOME` to keep it elsewhere; `barebone service` carries that into the unit. Files agents download go to `~/Downloads`.
