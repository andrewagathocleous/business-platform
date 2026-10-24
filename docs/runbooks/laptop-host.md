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

## 8. Backups (once, then every night)

1. Install `age`: `brew install age`.
2. Choose the backup folder: a cloud-synced folder that is not on this laptop only, for example a folder in iCloud Drive or Google Drive. Then run:

   ```sh
   ~/business-platform/current/infra/backup/backup-setup.sh "<the backup folder>"
   ```

   It writes `~/business-platform/backup.conf` with the folder and the **public** key, and shows the **secret** key once. Put the secret key in your password manager straight away, then clear the terminal (Cmd-K). Without it no backup can be restored.
3. Run `install-launchd.sh` again (step 7). It now also loads the nightly backup at 03:00; if the laptop sleeps then, it runs on wake.
4. Run one backup by hand and check it: `~/business-platform/current/infra/backup/laptop-backup.sh`.

Each backup is `<folder>/business-platform/<UTC time>/`. It holds both databases, the stored files and n8n's files (without n8n's config, which holds its key), each encrypted with `age` as it is written, plus `RELEASE` and `MANIFEST.sha256`. The 14 newest are kept, plus the first of each of the 6 newest months. The log is `~/Library/Logs/business-platform-backup.log`; a failure also shows a macOS notification. The env files and master keys are **not** in the backup: they live in your password manager (step 4). Every deploy backs up first and stops if the backup fails.

**Once a month:** copy the backup folder to the external drive.

## 9. Restore drill (before going live, then every few months)

Restore the newest backup into a scratch copy. Only Postgres, migrate and the API run there: no worker, n8n or Caddy, so it cannot print, send or sync anything.

```sh
~/business-platform/current/infra/backup/laptop-restore.sh "<folder>/business-platform/<UTC time>"
```

It copies the backup to a private folder, checks the manifest, asks for the secret key (hidden), proves the key opens every file, restores, **turns every company automation switch off** (audited; every outbound action, such as printing, needs its company switch), runs migrate, waits for the API, and prints row counts and the time taken. You can also pipe the key from your password manager's command-line tool instead of typing it. Compare the counts with `lc exec -T postgres psql -X -U postgres -d business_platform -c "select count(*) from sales_order"` on the live stack. Record the time and the counts, not the data, in `docs/releases/r0-report.md`. Then delete the scratch copy with the `down -v` command it prints.

**Disaster recovery** (a new laptop), in this order, so no empty stack is created first:
1. Steps 1 and 2 above, and `brew install age`.
2. Copy the newest release bundle to the laptop and run `./deploy-laptop.sh --unpack-only bp-<tag>.tar`. It loads the images without starting anything, and stops to ask for env files.
3. Run `~/business-platform/releases/<tag>/tools/release/laptop-env.sh`. Then, in `api.env` and `n8n.env`, replace `APP_MASTER_KEYS` and `N8N_ENCRYPTION_KEY` with the **old** values from your password manager, and fill in the Entra values. Run `./deploy-laptop.sh --unpack-only bp-<tag>.tar` again.
4. Restore into the live project: `~/business-platform/current/infra/backup/laptop-restore.sh "<backup>" --project business-platform-live`.
5. Steps 5 and 7, then section 8 (a new backup key pair is fine).
6. Check the queued print jobs (Admin, Automation), then turn the company switches back on there. The global `outbound.all` switch is left as it was in the backup.

While a restore of the live stack runs, `~/business-platform/state/restore-in-progress` exists, and the stack will not start (not at login, not by a deploy) until a restore finishes. If a restore was interrupted, run it again with `--replace`; it skips backing up the partial data.

**Replacing the live data on the same laptop** (undoing a bad deploy): add `--replace --project business-platform-live`. It proves the key first, backs up the current data, asks you to type the project name, and replaces only the databases, stored files and n8n data. Caddy's certificate authority stays, so the browser keeps trusting it.

## 10. Health alerts

`install-launchd.sh` (step 7) also loads a check that runs every 5 minutes while you are logged in. It calls `https://localhost:8443/api/health/ready`:
- after 2 failures in a row (10 minutes) you get a macOS notification, then one every hour while it stays down, and one when it answers again;
- once a day, it warns when less than 20 % of the disk is free.

The log is `~/Library/Logs/business-platform-health.log`. When it fires, run `lc ps`, then `lc logs --tail 200 api`. A failed backup posts its own notification (section 8).

Allow notifications for "Script Editor" in System Settings, Notifications, the first time macOS asks: launchd scripts post through it.

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
