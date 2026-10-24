# Live laptop host

How the platform runs for real on the dedicated M4 MacBook Air (Release 0, step R0-E). The laptop is the only client: you open `https://localhost:8443` in its own browser. Nothing on the internet connects to it; it only makes outbound calls (PrestaShop, PrintNode, Microsoft).

| Thing | Where |
| --- | --- |
| Compose project | `business-platform-live` (`compose.prod.yml` plus `compose.laptop.yml`) |
| Releases | `~/business-platform/releases/<tag>/`, with `~/business-platform/current` pointing at the running one |
| Secrets | `~/business-platform/env/*.env`, directory `0700`, files `0600`, never in a backup or in git |
| Address | `https://localhost:8443`, n8n editor on `http://127.0.0.1:15678` |
| Stack log (login agent) | `~/Library/Logs/business-platform-stack.log` |

Every command below that starts with `lc` means `~/business-platform/current/tools/release/laptop-compose.sh`. You can add `alias lc=~/business-platform/current/tools/release/laptop-compose.sh` to `~/.zshrc`.

## 1. Prepare the laptop (once)

1. FileVault on, macOS firewall on, an admin account, and Energy settings that keep it awake on the charger (L1).
2. Install Homebrew, then the container tools:

   ```sh
   brew install colima docker docker-compose
   mkdir -p ~/.docker/cli-plugins
   ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
   docker compose version
   colima start --cpu 4 --memory 12 --disk 60
   brew services start colima
   ```

   The symlink lets `docker compose` find Homebrew's Compose plugin; `docker compose version` must print a version. `brew services` starts Colima again at every login.
3. Keep Time Machine away from the database: `tmutil addexclusion -p ~/.colima`. Time Machine copies the VM disk while Postgres is writing, which is not a backup. The real backup is R0-C.

## 2. Register the app in Microsoft Entra (once)

Follow R0-G in `docs/plan/release-0.md`: a single-tenant app, the web redirect URI `https://localhost:8443/api/auth/oidc/callback`, and a client secret. Keep these three values ready:
- the issuer `https://login.microsoftonline.com/<tenant id>/v2.0`;
- the client id;
- the client secret.

Also copy your own user's **Object ID** (Entra admin center, Users, your user) for the owner link in step 6.

## 3. Build and export a release (development Mac)

```sh
tools/release/build-images.sh            # builds bp-api, bp-migrate, bp-web at HEAD's short SHA
tools/release/export-images.sh <tag>     # writes var/releases/bp-<tag>.tar, .sha256 and deploy-laptop.sh
```

Both refuse uncommitted changes or a tag that is not HEAD. Copy the three files to the laptop (AirDrop, USB or `scp`).

## 4. First deploy (laptop)

```sh
./deploy-laptop.sh bp-<tag>.tar
```

The first run unpacks the release, then stops because there are no env files yet. Create them:

```sh
~/business-platform/releases/<tag>/tools/release/laptop-env.sh
```

It writes fresh random secrets and prints none of them. Then:
1. Open `~/business-platform/env/api.env` in a text editor, and replace the three `replace-me` values with the Entra values from step 2. The API refuses to start in production with a placeholder.
2. Copy `APP_MASTER_KEYS` (from `api.env`) and `N8N_ENCRYPTION_KEY` (from `n8n.env`) into your password manager (L3). Without them, a restored backup cannot open the stored keys.
3. Run `./deploy-laptop.sh bp-<tag>.tar` again.

The deploy checks the file's SHA-256, loads the images, migrates, starts the stack, checks `/api/health/ready`, and points `current` at the release. On later deploys it backs up first and stops if the backup fails (R0-C).

## 5. Trust the local certificate (once)

Caddy signs `localhost` with its own local authority. Make this Mac trust it, for your login keychain only:

```sh
lc cp caddy:/data/caddy/pki/authorities/local/root.crt ~/Downloads/bp-local-root.crt
security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/Downloads/bp-local-root.crt
rm ~/Downloads/bp-local-root.crt
```

Quit and reopen the browser, then open `https://localhost:8443`.

## 6. First owner

```sh
lc --profile ops run --rm owner-cli enrol --email you@your-domain --name "Your Name" \
  --origin https://localhost:8443 --entra-oid <your Object ID>
```

Open the printed link on this laptop and sign in with Microsoft. Details are in `first-owner.md`. Then create the company, brand, shop location and store in the app (R0-B).

## 7. Start the stack at login (once)

```sh
~/business-platform/current/tools/release/install-launchd.sh
```

After a restart, FileVault asks for the password; once you log in, Colima starts and the agent runs `up -d --wait`. Its output goes to `~/Library/Logs/business-platform-stack.log`.

## Everyday

| Task | Command |
| --- | --- |
| Status | `lc ps` |
| Logs of one service | `lc logs --tail 200 api` |
| Stop everything (data kept) | `lc down` (never `down -v`, which deletes the data) |
| Start again | `lc up -d --wait` |
| Check only loopback listens | `lsof -nP -iTCP -sTCP:LISTEN` shows the stack on `127.0.0.1` only |

**Going back a version.** Run `deploy-laptop.sh` with the previous bundle. Migrations only move forward. If the new version changed the database and the old one cannot run on it, restore the backup taken just before the deploy (R0-C).

**Switches.** `outbound.all` and every company switch stay off until a release's live checks say otherwise.
