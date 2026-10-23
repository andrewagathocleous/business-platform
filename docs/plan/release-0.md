# Release 0 plan: go-live base

Owner: planner (Claude Code). Implementer: Cursor CLI. Reviewer: Codex CLI.
Written 2026-10-23, revised the same day after the user chose to start on a laptop. Every later release ships onto this base. Release 1 code can be built at the same time; it goes live only after R0.

**Goal.** The platform runs with real data on a dedicated laptop, for the owner's own use. The owner signs in with their Microsoft 365 account. The real company, its brands, locations and stores exist. An encrypted backup leaves the laptop every day, and one restore has been drilled. Every outbound switch is off. No feature is switched on yet.

**Not in R0.** No connector, no real printing, no invoice issuance, no fictional seed and no dev login on the live laptop. No server, domain or public address: that is "Moving to a server" at the end of this plan.

## Where it runs (user, 2026-10-23)

- **Live host:** a separate M4 MacBook Air with 32 GB RAM and a 256 GB SSD, used only through its own browser at `https://localhost:8443`. It is not the development Mac, so the live stack never shares Docker, volumes or memory with development and tests.
- **Shop printer:** the HP LaserJet M209dw is driven by a Windows desktop PC at the shop. The PrintNode client goes on that PC in R1. The laptop reaches PrintNode over the internet, so the laptop does not have to be at the shop.
- **Sign-in:** the business uses Microsoft 365, so staff sign-in uses the existing Entra OIDC code.
- **Nothing on the internet connects to the laptop.** R1 only makes outbound calls (PrestaShop, PrintNode). Published ports stay on `127.0.0.1`.

What this means while the laptop hosts the platform:

- It works only while the laptop is on and awake. A sleeping laptop loses no orders: the PrestaShop reader catches up from its checkpoint when it wakes.
- Only the laptop's own browser reaches it. Staff on other devices, and Shopify webhooks (R3), need the move to a server.
- After a restart, FileVault asks for the password before anything starts. The stack starts after the owner logs in.

## What the user provides

| #         | Item                                                                                                                                  | Needed for | Notes                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| L1        | The MacBook Air: FileVault on, macOS firewall on, admin rights, and power settings that keep it awake on the charger                  | R0-E       |                                                                           |
| L2        | A backup destination off the laptop: a cloud-synced folder (iCloud Drive or Google Drive), plus an external drive for a monthly copy  | R0-C       |                                                                           |
| L3        | A password manager for the backup key and the master keys                                                                             | R0-C       | They never go in the repo or in chat                                      |
| U2        | Microsoft 365 admin rights to register the app (Global Administrator or Application Administrator), and the owner's Microsoft account | R0-A, R0-G | A second, emergency admin account is recommended (see R0-F), not blocking |
| U1 (part) | The real legal name, VAT number and address, typed into the platform by the owner                                                     | R0-B       | Never written into the repo, the plan or chat                             |

## R0-A. First platform owner (P1-F)

Today only the fictional seed sets `user_account.is_platform_owner`. A fresh production database has no staff user, and an Entra login of an unknown identity is denied.

Design. The **CLI sets the owner flag**; the API never does. The API only links an Entra identity to an account the CLI created, through a one-time link.

- **Migration:** add a platform-level table `platform_owner_enrolment` with columns `id`, `user_id`, `token_hash` (SHA-256), `expires_at`, `consumed_at` and `created_at`. It is not company-scoped. Grants: `bp_app` may `SELECT` it and `UPDATE consumed_at`. Only `bp_owner` inserts.
- **CLI** `apps/api/src/cli/owner.ts`. It runs in the `migrate` image with `DATABASE_URL_OWNER`, through `docker compose … run --rm migrate node … owner <command>`.
  - `owner enrol --email <address> --name <display name>`:
    - Creates the user account with `is_platform_owner = true`, or sets the flag on an existing account with no Entra identity yet.
    - Revokes that user's open enrolments.
    - Inserts a new enrolment that expires in 30 minutes.
    - Prints the one-time URL once: `https://<APP_DOMAIN>:<port>/api/auth/oidc/start?enrolment=<token>`. Only the hash is stored.
    - Refuses an account that already has an Entra identity unless `--relink` is given. Re-linking removes the old Entra identity and revokes every session of that user.
  - `owner list`: owners, their email, Entra link status and last login. No secrets.
  - `owner revoke-sessions --email <address>` and `owner disable --email <address>`. `owner disable` refuses to disable the last active owner.
  - Every command writes an audit event with actor type `system`, actor `cli`, outcome and correlation id.
- **OIDC start** accepts `enrolment=` the same way it accepts `invitation=` today, and stores only the token hash in the auth flow.
- **OIDC callback** with an enrolment, in one transaction:
  1. Lock the enrolment row. It must exist, be unconsumed and unexpired.
  2. The claims' email must match the account email under the same rule invitations use (`invitationEmailMatches`; see R0-G for Entra).
  3. The Entra identity `(provider, issuer, subject)` must not belong to another user.
  4. Create `user_identity`, set `consumed_at`, start the session, and audit `platform.owner_enrolled`.
  5. Any failure is the existing 403 "not provisioned" response, with a denial audit naming the reason.
- **Tests (integration, real Postgres):**
  - Happy path.
  - Expired link, reused link, wrong email and unverified email.
  - An identity already linked to someone else.
  - Two concurrent callbacks with one link: exactly one succeeds.
  - `bp_app` cannot insert an enrolment.
  - `--relink` revokes sessions.
  - `owner disable` keeps the last owner.
  - The token is never logged.

## R0-B. Company setup (API and screens)

Today `POST /api/platform/companies` creates a company. Nothing creates brands, locations or stores, and nothing edits company details.

- `PATCH /c/:companyId/company` (`company.manage`, `expectedVersion`): legal name, trading name, registration number, VAT number, tax office, address, timezone, currency, locales, payment terms. Audited.
  - The migration adds a `version` column to `company` if there is none.
  - Read access stays `GET /context`. Add the fields there if they are missing.
- Brands: `GET/POST /c/:companyId/brands`, and `PATCH /c/:companyId/brands/:id` for rename and archive. Permissions: `store.view` and `store.manage`.
- Locations: the same routes under `/locations`. `GET /locations` already exists and keeps its shape. Permissions: `company.manage` to write.
- Stores: the same routes under `/stores`, with platform (`shopify`, `prestashop`, `manual`), brand, location, name, domain and invoice authority. `store.view` to read, `store.manage` to write. Platform is fixed after creation.
- Every write is audited. The isolation sweep covers every new route: another company's id gives 404.
- Web admin: a "Company" screen (details) and a "Stores" screen (brands, locations, stores), behind the same permissions. English and Greek keys follow the existing admin pattern.

Implemented:

- `store.view` is scopable by store. `GET /stores` and `GET /stores/:id` then show only the granted stores. `store.manage` and `GET /brands` stay company-wide.
- `GET /locations` keeps `id` and `name` and also returns `address`, `timezone` and `archivedAt`.
- Active brand names are unique per company, case-insensitively, with a transaction advisory lock. The migration does not add a partial unique index.
- A version conflict is HTTP 409 `error.code` `conflict` and message `version_conflict`. `name_taken` and `location_in_use` use those strings as `error.code`.
- Fulfilment staff with `company.view` see Company read-only. `/admin` opens that page. Members and Stores stay forbidden.
- New admin keys are in `en.json` only. `missingHandler.useFallbackTranslation` is on, so a missing Greek key renders the English string.
- `registrationNumber`, `vatNumber` and `taxOffice` accept `null` on company PATCH, which clears them. A string that is empty after trimming the ends is rejected. Those three columns are stored as NULL. `tradingName` is optional on the PATCH, but when sent it is a non-empty trimmed string of at most 200 characters. `null` and a blank string are rejected. `trading_name` stays NOT NULL and is never stored as an empty string. Location PATCH `timezone: null` means the company default. The company address is replaced as a whole, so omitting `line2` or `postcode` clears them. Store `domain` can be cleared.
- A company PATCH whose values equal the current ones returns 200 with the same version and no audit row. A stale `expectedVersion` is still 409. "Exactly one success" applies to concurrent patches that change something.
- `defaultCurrency` must be a code `Intl.supportedValuesOf('currency')` includes, and `currencyMinorDigits` must be 2. `currencyMinorDigits` itself is unchanged.
- Timezones use `isIanaTimeZone` in `@bp/domain` (company, location and PrestaShop settings). Empty text, untrimmed text and values that start with `+` or `-` are rejected.
- `GET /stores` and `GET /stores/:id` include `brand: { id, name }` and `location: { id, name }`. The stores screen loads `/brands` only for company-wide `store.view`. Without that grant it hides Brands and still lists the granted stores. A 403 on one section stays in that section. After a brand rename, archive or restore, or a location edit, archive or restore, the screen reloads the stores list and that section.
- The company form is bound to the company it loaded. Changing company clears it until the new details load, and save writes only to that company. Inputs stay disabled while the PATCH is in flight. Trading name is required, and Save stays disabled while it is empty. A successful save reloads the shared company context only while that company is still the latest context load. The reload does not cancel a load for another company.

## R0-C. Backups (P5-01, laptop version)

R1 can re-read every order from PrestaShop, so until R2 a lost laptop costs print history, notes and assignments. From R2 the platform holds the only copy of issued invoices, so backups must already be proven by then.

- Script `infra/backup/laptop-backup.sh`, run every day at 03:00 by a launchd agent, and also on demand. It:
  - takes `pg_dump -Fc` of `business_platform` and `n8n` through `docker compose exec postgres`;
  - takes a tar of the `bp_storage` volume;
  - encrypts each file with `age` to a public key; the private key is only in the password manager;
  - writes them to `<backup folder>/business-platform/<UTC timestamp>/` with a SHA-256 manifest;
  - keeps 14 daily and 6 monthly copies;
  - writes the result, with no secrets, to `~/Library/Logs/business-platform-backup.log`, and posts a macOS notification on failure.
- The backup folder is a cloud-synced folder (iCloud Drive or Google Drive). Once a month, copy it to the external drive (runbook checklist).
- **Master keys stay apart from the backups.** `APP_MASTER_KEYS`, `N8N_ENCRYPTION_KEY` and the env files are **not** in the backup folder. The owner copies them into the password manager once at set-up and again after every rotation.
- **Time Machine is not a database backup.** It copies the Colima VM disk while Postgres is running. Exclude `~/.colima` from Time Machine, so a half-written copy is never mistaken for a backup.
- **Before every deploy**, `tools/release/deploy-laptop.sh` (R0-E) runs a backup first and stops if it fails.
- `infra/backup/laptop-restore.sh <backup dir>` decrypts with the private key (asked for on the terminal, never in an argument), verifies the manifest, and restores into a **fresh** Compose project. It refuses to restore over a project that has data unless `--replace` is given.
- **Tests:**
  - shellcheck on both scripts;
  - a local test that backs up the local stack, restores it into a new project, and runs `pnpm milestone:verify --phase=after-restart` against it;
  - a tampered file failing the manifest check.
- **Restore drill before go-live:** on the live laptop, restore the first real backup into a scratch Compose project (Postgres, migrate and API only). Time it, check readiness, row counts and one stored file, then delete the scratch project and its volumes. Record the time and the counts, not the data, in `docs/releases/r0-report.md`. Real data never goes to the development Mac.

## R0-D. Health checks on the laptop

- A launchd agent checks `https://localhost:8443/api/health/ready` every 5 minutes while the owner is logged in, and posts a macOS notification after 2 failures in a row.
- The backup posts a notification on failure (R0-C). The same check warns when free disk falls under 20 % of the SSD.
- Document both in `docs/runbooks/laptop-host.md`.

## R0-E. Laptop set-up and first deploy

New runbook `docs/runbooks/laptop-host.md`. New compose overlay `infra/compose/compose.laptop.yml`:

- Project name `business-platform-live`. Its volumes never collide with `business-platform` (dev) or `business-platform-local` (demo).
- `compose.prod.yml` plus the overlay. **`APP_ENV=production` and dev login off**, so the API refuses to start with dev login on.
- No `seed` and no `import-fixtures` service, and no `build:`: images come by tag.
- Caddy uses `Caddyfile.local` (`tls internal`) on `127.0.0.1:8443`. n8n is on `127.0.0.1:15678`. Nothing listens on another interface.
- Memory ceilings from `compose.prod.yml` add up to 5.6 GB. A Colima VM of 4 CPU and 12 GB, with a 60 GB disk, also leaves room for the restore drill's scratch project.
- `tools/check-compose-config.mjs` gets the overlay. It fails if any port is not on `127.0.0.1`, if dev login or a seed service appears, or if `APP_ENV` is not `production`.

Set-up on the laptop:

1. Install Homebrew, Colima, the Docker CLI and the Compose plugin. Run Colima as a login service (`brew services start colima`).
2. Trust Caddy's local root certificate in the login keychain, following the scoped steps in `docs/runbooks/local-stack.md`.
3. Create the env files under `~/business-platform/env`, with mode `0700` on the directory and `0600` on each file, using `pnpm setup:env` adapted for the laptop. Secrets are generated on the laptop. Copy the master keys to the password manager.
4. Entra values: issuer `https://login.microsoftonline.com/<tenant id>/v2.0`, client id, and client secret. The redirect URI is `https://localhost:8443/api/auth/oidc/callback`; Entra allows `localhost` redirect URIs.
5. Add a launchd agent that runs `up -d --wait` at login, so the stack starts after a reboot once the owner has logged in.

Deploying a version:

- Images are built on the development Mac. It is Apple silicon like the M4, so no cross-build is needed. Build one service at a time, as STATUS says, and tag with the git short SHA.
- `tools/release/export-images.sh <tag>` writes one `docker save` file plus its SHA-256. Copy it to the laptop (AirDrop, USB or `scp`).
- `tools/release/deploy-laptop.sh <file>`:
  1. Checks the SHA-256 and runs `docker load`.
  2. Runs a backup (R0-C).
  3. Runs `migrate`, then `up -d --wait`.
  4. Checks `/api/health/ready`.
  5. Prints the running tag.

  It never prints env values.

- **First run:** `owner enrol` (R0-A). The owner opens the link, signs in with Microsoft, and creates the company (R0-B) with real details typed in the app.
- `outbound.all` and every company switch stay off.

## R0-F. Recovery runbook (P1-G)

Write `docs/runbooks/break-glass.md` for the laptop:

- **Owner's Microsoft account lost or locked:** on the laptop, `owner enrol --relink` for a working Microsoft account.
- **Compromised session:** `owner revoke-sessions`.
- **Laptop lost, stolen or dead:** set up a new laptop with R0-E, restore the latest backup with R0-C, re-enter the master keys from the password manager. Rotate the PrestaShop and PrintNode keys and the Entra client secret, because the old laptop held them encrypted on disk.
- **Microsoft 365 locked for every admin:** this is why a second, emergency admin account is recommended. It is a cloud-only account with a long password and a hardware key or authenticator, kept offline, and used only in an emergency, as Microsoft recommends. Without it, recovery goes through Microsoft support.

Each case has exact commands and the audit events to check afterwards. Rehearse the first case once on the laptop and record it in the R0 report.

## R0-G. Real Entra sign-in (R0-01)

The OIDC code is mock-tested only, and two claims it relies on are unverified with Entra (U2):

- `email_verified`: invitation and enrolment matching need it to be exactly `true`.
- `amr` containing `mfa`: privileged permissions are withheld without it.

Steps:

1. Register the app in the user's tenant: single tenant, a web redirect URI `https://localhost:8443/api/auth/oidc/callback`, a client secret in the API env file, and the optional claims needed.
2. Sign in once with the owner account. Record which of `email`, `email_verified`, `preferred_username`, `amr`, `tid` and `oid` actually arrive. Record claim names only, never values or tokens.
3. If `email_verified` or `amr` does not arrive, **stop and decide with the user**. Options:
   - match on the tenant id plus the account's `oid`, recorded at enrolment;
   - require MFA through Conditional Access or Security Defaults and treat the tenant as the MFA authority.

   Record the decision in ADR-0004 before changing code.

4. Confirm that a second account with no enrolment or invitation is denied.

## R0 acceptance

Recorded in `docs/releases/r0-report.md` with real command output (no secrets, no customer data):

1. The owner signs in with Microsoft on the laptop. An account with no enrolment or invitation is denied.
2. The real company, brand, location and store records exist, entered by the owner in the app.
3. `lsof -nP -iTCP -sTCP:LISTEN` on the laptop shows the stack only on `127.0.0.1`. FileVault and the macOS firewall are on.
4. A backup ran from launchd and landed in the synced folder. Restoring it into a scratch project on the laptop passed the readiness check, and the row counts match. The time is recorded.
5. The failure notifications for health and backup each fired once in a test.
6. `outbound.all` and every company switch are off.
7. `pnpm audit --prod` is reviewed, and the image secret scan from the M1 report passes on the deployed tag.
8. The re-link recovery was rehearsed.

## Moving to a server (later)

Needed when staff use the platform from their own devices, when Shopify webhooks arrive (R3), or when the owner wants it independent of the laptop. Whichever comes first.

| #   | Item                                                                    | Notes                                    |
| --- | ----------------------------------------------------------------------- | ---------------------------------------- |
| U8a | VPS: Ubuntu LTS, EU region, about 8 GB RAM, 4 vCPU, 80 GB disk or more  | Any provider                             |
| U8b | The app's domain or subdomain, and DNS access                           | For example `app.<your domain>`          |
| U8c | Backups to an S3-compatible bucket at a different provider from the VPS | So one provider problem cannot take both |

Work:

- Provision the server: `deploy` user, key-only SSH, `ufw` allowing 22, 80, 443 and UDP 443, unattended upgrades.
- `docs/runbooks/vps-deployment.md` for real. Add a production redirect URI in Entra.
- Restore the laptop's latest backup onto the server.
- External uptime monitoring and an exposure test with `nmap`.
- Switch the laptop off as a host.
