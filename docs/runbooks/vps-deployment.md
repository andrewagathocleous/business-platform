# VPS deployment

**Draft.** This has not been run on a real server. Nothing below was live-tested. It describes `infra/compose/compose.prod.yml`, the Dockerfiles, and `.env.example`.

The compose project name is `business-platform`, the same name as the dev stack. On the Mac, use [local-stack.md](local-stack.md) and project `business-platform-local`. Do not start `compose.prod.yml` on its own on a machine that already uses the dev project name: the volume names would collide.

## Server

A provider-neutral Ubuntu LTS VPS with about 8 GB RAM. Memory and CPU in `compose.prod.yml` are ceilings. The comment table at the top of that file is:

<!-- prettier-ignore -->
| Service | Memory | CPUs |
| --- | --- | --- |
| caddy | 128m | 0.25 |
| api | 768m | 1.00 |
| worker | 768m | 1.00 |
| migrate | 512m | 0.50 |
| postgres | 1536m | 1.50 |
| n8n | 1536m | 1.00 |
| n8n-runner | 384m | 0.50 |
| total | 5632m | 5.75 |

Postgres is `postgres:18.6-alpine`. n8n is `n8nio/n8n:2.43.7` and `n8nio/runners:2.43.7`. Timezone settings in the n8n service are `Asia/Nicosia`.

## DNS

Create an A record and an AAAA record for the app domain. The domain is `APP_DOMAIN` in `caddy.env`. The placeholder in `.env.example` is `app.example.test`. Point the records at the VPS address. Use a documentation address such as `203.0.113.10` in notes; do not write a real address into the repo.

## SSH

Use key-only login. Disable password login. Disable root login. Deploy as a non-root user, for example `deploy`.

Membership of the `docker` group is root-equivalent: the Docker socket can start a container that mounts the host filesystem and runs as root. This runbook leaves `deploy` out of that group. Compose runs with `sudo`, so the privilege is on that command, and the env files stay root-owned (`0700` on the directory, `0600` on each file). `sudo` clears the environment, so each command passes the non-secret variables itself:

```sh
sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=<tag> docker compose -f infra/compose/compose.prod.yml up -d --wait
```

`<tag>` is the image tag loaded on that host. The same `sudo env` prefix is on every Compose command below.

## Firewall

Allow TCP 22, 80 and 443. Limit port 22 to known source addresses when you can. Also allow UDP 443 so HTTP/3 can work. Caddy publishes `80:80`, `443:443` and `443:443/udp`.

**Docker and ufw.** Published container ports bypass `ufw`, because Docker writes its own iptables rules. A `ufw deny` on 5432 does not close a port Docker has published. That is why Postgres has no published ports, the API and the worker publish none, and n8n is published only as `127.0.0.1:5678:5678`. Only Caddy publishes ports on the public interfaces.

From another machine, check that only 22, 80 and 443 answer. Example, with the placeholder domain:

```sh
nmap -Pn -p 22,80,443,5432,5678 app.example.test
```

22, 80 and 443 should answer. 5432 and 5678 should not. UDP 443 is a separate check (`nmap -sU -p 443`) and may show as open or filtered until a client speaks HTTP/3. This check has not been run.

## Env files

Create the directory and the files as root. Mode `0700` on the directory and `0600` on each file. They stay outside the git checkout.

```sh
unset HISTFILE
umask 077
install -d -m 0700 -o root -g root /opt/business-platform/env
```

`unset HISTFILE` keeps the secret values out of shell history for that shell. Generate each secret into a root-owned file, then put the value into the env file with an editor. Do not pass the secret as an `echo` or `export` argument, and do not commit the files.

```sh
openssl rand -hex 32 > /opt/business-platform/env/one-secret
openssl rand -base64 32 > /opt/business-platform/env/one-master-key
```

`openssl rand -base64 32` is 32 bytes. `APP_MASTER_KEYS` is a JSON map of key id to that base64 value, for example `{"k1":"replace-me"}`. The API refuses a master key that is not 32 bytes (`apps/api/src/config/env.test.ts`, `rejects a master key that is not 32 bytes`). Delete the scratch files after the env files are written. Do not print them.

`compose.prod.yml` reads `${BP_ENV_DIR}`. The file does not substitute a default: the interpolation is `${BP_ENV_DIR:?BP_ENV_DIR is required}`. `/opt/business-platform/env` is the path this runbook uses. It is not a Compose default. Pass it on the `sudo env` command in [SSH](#ssh), because `sudo` does not keep a variable exported in the deploy user's shell.

Which variables go in which file is the comment block at the bottom of `.env.example`. Placeholders there are `replace-me`, `app.example.test` and `ops@example.test`.

<!-- prettier-ignore -->
| File | Variables |
| --- | --- |
| `postgres.env` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `BP_OWNER_PASSWORD`, `BP_APP_PASSWORD`, `N8N_DB_PASSWORD` |
| `migrate.env` | `DATABASE_URL_OWNER` (`bp_owner` at host `postgres`, database `business_platform`) |
| `api.env` | `APP_ENV=production`, `DATABASE_URL` (`bp_app`), `CSRF_SECRET`, `APP_MASTER_KEYS`, `APP_MASTER_KEY_ACTIVE`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `STORAGE_ROOT`, `MOCK_PRINT_ROOT`, `AUTH_DEV_LOGIN_ENABLED=false`, `SESSION_COOKIE_SECURE=true`, `AUTH_REQUIRE_MFA_FOR_PRIVILEGED=true`, `HOST=0.0.0.0`, `PORT=3000`, `TRUST_PROXY_HOPS=0` |
| `n8n.env` | `DB_POSTGRESDB_PASSWORD` (the same value as `N8N_DB_PASSWORD`), `N8N_ENCRYPTION_KEY`, `N8N_RUNNERS_AUTH_TOKEN` |
| `n8n-runner.env` | `N8N_RUNNERS_AUTH_TOKEN` only, the same value as in `n8n.env` |
| `caddy.env` | `APP_DOMAIN`, `ACME_EMAIL` |

Do not set `BP_OWNER_CREATEDB`. Compose sets `BP_OWNER_CREATEDB=off`. Do not set `N8N_SECURE_COOKIE=false`. Compose also sets `AUTH_DEV_LOGIN_ENABLED=false` and `SESSION_COOKIE_SECURE=true` on the API and the worker, and `TRUST_PROXY_HOPS=1` on the API. Caddy is that one hop. The Caddyfile does not set `trusted_proxies`, so Caddy ignores a client-supplied `X-Forwarded-For`. `uat` and `production` refuse to start with dev login on or with insecure cookies. The API sends `Strict-Transport-Security` only when `APP_ENV` is `uat` or `production`. The runner loads `n8n-runner.env` only. Do not put the database password or `N8N_ENCRYPTION_KEY` in that file.

`STORAGE_ROOT` in the example is `/var/lib/business-platform/storage`, which is the `bp_storage` volume. `MOCK_PRINT_ROOT` is the mock print volume. Phase 1 still uses the mock printer.

## First deploy

Phase 1 has no image registry and no CD. `.github/workflows/ci.yml` does not build or push images.

`compose.prod.yml` does not build. It runs tags that must already exist:

<!-- prettier-ignore -->
| Image | Dockerfile |
| --- | --- |
| `bp-api:${BP_IMAGE_TAG}` | `infra/docker/api.Dockerfile`, target `runtime` |
| `bp-migrate:${BP_IMAGE_TAG}` | `infra/docker/api.Dockerfile`, target `migrate` |
| `bp-web:${BP_IMAGE_TAG}` | `infra/docker/web.Dockerfile` (Caddy `caddy:2.11.7-alpine` plus the static build) |

Postgres and the two n8n images are the public tags in the compose file. `bp-tools` is referenced only by `compose.local.yml`. Do not use it on the VPS.

Build the three tags on a machine with enough free disk, tag them, and load them into the VPS Docker engine (a registry you operate, or `docker save` / `docker load`). The images in this repository were not built: free disk on the build machine was below the 15 GB gate. See [docs/STATUS.md](../STATUS.md).

On the VPS, from a checkout of the compose file and the mounted init scripts (`infra/postgres/`):

```sh
sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml up -d --wait
```

`--wait` returns when the healthchecks pass and the one-shot migrate container has exited 0. Migrate runs `prisma migrate deploy` as `bp_owner`. The API and the worker wait for `service_completed_successfully`. Migrate's restart policy is `"no"`.

Afterwards:

```sh
sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml ps
```

Expect Caddy, API, worker, Postgres, n8n and n8n-runner up, and migrate exited 0. Published ports should be Caddy on 80 and 443, and n8n only on `127.0.0.1:5678`.

```sh
curl --fail --silent https://app.example.test/api/health/live
curl --fail --silent https://app.example.test/api/health/ready
```

Both are public (`apps/api/src/health/health.controller.ts`). A ready body is `{ "status": "ok" }`. `runId` is added only when `APP_ENV` is `test` or `development` and `E2E_RUN_ID` is set, so a production response does not include it.

## Blocked before first real deploy

`compose.prod.yml` does not seed and does not enable dev login. The only code that sets a platform owner is `packages/db/src/seed/run.ts`, and that seed is fictional demo data. A fresh production database has the schema and no staff user. Entra login of an unknown identity is denied. Nothing creates the first production platform owner. That bootstrap is not implemented. Do not point the VPS at the fictional seed as if it were production data.

ADR-0004 names a break-glass recovery runbook. That runbook does not exist and is not implemented. There is no break-glass account.

**What this deploy does not do.** It does not seed, does not import fixtures, and does not enable dev login.

`POST /api/platform/companies` (platform owner only) creates a company with the seven company switches off. `outbound.all` is a separate platform-owner call and is not created with the company. The worker holds a print job when either switch is missing or off (`switchesOn` in `apps/api/src/printing/print.processor.ts`).

## Deploy and rollback by tag

Set the tag and run the same up:

```sh
sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml up -d --wait
```

Migrate applies any new Prisma migrations. They are forward-only.

Rolling the tag backwards to an image that does not understand the migrated schema needs a database restore, or a migration that the older image can still run. Shipping the previous tag alone does not undo a migration. Backup and restore are design only: [backup-restore.md](backup-restore.md).

## Certificates

Caddy obtains and renews certificates for `{$APP_DOMAIN}` and uses `{$ACME_EMAIL}` (`infra/caddy/Caddyfile`). The production site adds HSTS. Keep the `bp_caddy_data` volume. Caddy stores certificate data there (`/data` in the container). `bp_caddy_config` is the other Caddy volume. Deleting `bp_caddy_data` forces a new issuance.

The local stack uses `tls internal` and a different Caddyfile (`infra/caddy/Caddyfile.local`). That file is not the production site.

## n8n editor

n8n has no public route. It listens on `127.0.0.1:5678` inside the compose network mapping. From your machine:

```sh
ssh -L 5678:127.0.0.1:5678 deploy@app.example.test
```

Then open http://localhost:5678. Open that name, not `http://127.0.0.1:5678`. Browsers treat `localhost` as a secure context, so n8n's Secure cookie can be stored over this plain-HTTP tunnel. `127.0.0.1` is not a secure context.

`compose.prod.yml` does not set `N8N_SECURE_COOKIE`. n8n's default is true, and the service sets `N8N_PROTOCOL=http`. The local override sets `N8N_SECURE_COOKIE=false` only in `compose.local.yml`, because that editor is plain HTTP on `127.0.0.1:15678`. That line is not in the production file. This tunnel was not live-tested.

## Logs

```sh
sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml logs
```

Every service uses the `json-file` driver with `max-size` `10m` and `max-file` `5` (the `x-logging` anchor in `compose.prod.yml`).

## Moving to another VPS

Backup and restore are not implemented. Follow [backup-restore.md](backup-restore.md) once that work exists. Until then, treat a move as a manual copy and record what you did.

1. Stop the writers and leave Postgres running. Do not delete volumes until the copy exists.

   ```sh
   sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml stop caddy api worker n8n n8n-runner
   ```

2. Dump `business_platform` and `n8n` while Postgres is still running. The dump runs from inside the server, as a role that can read those databases. See [backup-restore.md](backup-restore.md).
3. Stop Postgres:

   ```sh
   sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml stop postgres
   ```

4. Copy the volumes, and copy `/opt/business-platform/env` to the new host (root, directory `0700`, files `0600`). The design also keeps `APP_MASTER_KEYS` and `N8N_ENCRYPTION_KEY` recoverable. Volumes in the compose file: `bp_postgres`, `bp_storage`, `bp_mock_print`, `bp_n8n`, `bp_caddy_data`, `bp_caddy_config`.
5. Change the A and AAAA records to the new host.
6. Start with the same `BP_IMAGE_TAG`:

   ```sh
   sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=replace-with-tag docker compose -f infra/compose/compose.prod.yml up -d --wait
   ```

7. Verify health on the app domain, and from outside the host check that only 22, 80 and 443 answer.

## Pre-production gates still open

The Phase 5 list in [docs/security/asvs-checklist.md](../security/asvs-checklist.md) is still open: item-level ASVS evidence, a threat-model review, dependency and image scans, an exposure test from the internet, a restore drill, and an optional penetration test. This draft does not close any of those.
