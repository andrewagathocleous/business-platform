# Backup and restore

**For the live laptop (R0), backup and restore are implemented:** `infra/backup/laptop-backup.sh`, `laptop-restore.sh` and `backup-setup.sh`, with the nightly launchd agent. The steps are in [laptop-host.md](laptop-host.md) sections 8 and 9. A backup and restore of a live-style stack with fictional data was drilled on the development Mac on 2026-10-24: both databases and a stored file matched, and the restore took 15 seconds. The drill with real data happens on the laptop before go-live. The rest of this document is the original Phase 1 design for a server, kept for "Moving to a server".

Proposed targets, not measured: **RPO 24 h** and **RTO 8 h**.

## What must be backed up

The production stack is `infra/compose/compose.prod.yml`. One Postgres cluster holds two databases.

<!-- prettier-ignore -->
| Item | Where it lives | Why it is required |
| --- | --- | --- |
| Database `business_platform` | Postgres service, volume `bp_postgres` | Companies, orders, invoices, audit, jobs |
| Database `n8n` | Same cluster, role `n8n` | n8n's own data |
| Document bytes | Volume `bp_storage`, mounted at `/var/lib/business-platform/storage` | Stored PDFs. The database row is not the file |
| n8n encryption key | `N8N_ENCRYPTION_KEY` in `n8n.env` | n8n cannot read its credential store without it |
| App master keys | `APP_MASTER_KEYS` and `APP_MASTER_KEY_ACTIVE` in `api.env` | The vault ciphertext in Postgres is useless without them |
| Env files | `/opt/business-platform/env/*.env` | The stack does not start without them |

Take `business_platform` and `n8n` as encrypted off-site `pg_dump` output. Store the dump encryption key apart from the dumps.

Store `APP_MASTER_KEYS` **separately** from the backups those keys protect. A copy that sits inside the database dump, or inside the same archive as that dump, lets whoever takes the dump open the vault. ADR-0007 says the master key lives outside the database and outside database backups. The env-file copy is one place. A second copy of `APP_MASTER_KEYS` belongs in a different store from the dumps.

`N8N_ENCRYPTION_KEY` is the same kind of secret for n8n. Keep it with the env-file backup, not only inside `bp_n8n`.

The compose file also has `bp_mock_print` (simulated print PDFs), `bp_n8n` (`/home/node/.n8n`), `bp_caddy_data` and `bp_caddy_config`. A move of the VPS has to include them or accept a new Caddy issuance and an empty n8n home directory. They are not a substitute for the two database dumps or for `bp_storage`.

Postgres has no published port. A dump runs from inside the server, as a database role that can read the database, and the file leaves the host only over an encrypted channel. Do not put dumps, keys or env files in git.

## Proposed RPO and RTO

<!-- prettier-ignore -->
| Target | Value | Meaning |
| --- | --- | --- |
| RPO | 24 h | A dump at least once a day. Up to a day of new rows can be lost |
| RTO | 8 h | A practiced restore on a clean machine finishes within eight hours |

These numbers are the Phase 1 proposal. No job runs them, and no drill has timed them.

## What a restore drill looks like

**Planned (Phase 5), not implemented.** The steps below are the drill to record once the backups exist. Do not treat them as a script that is in the repo.

1. Use a clean VPS, or a scratch machine that is not the live host. Do not restore over the only copy of the volumes.
2. Install the same image tags the dump was taken from. Migrations are forward-only, so the tag and the dump have to match. See [vps-deployment.md](vps-deployment.md).
3. Restore `/opt/business-platform/env` as root, directory mode `0700`, files mode `0600`. Confirm `APP_MASTER_KEYS` and `N8N_ENCRYPTION_KEY` are the values from the separate store, not a regenerated `openssl rand`.
4. Start Postgres only, load the `business_platform` dump and the `n8n` dump, and stop again before the app writes.
5. Restore `bp_storage` so stored-file rows still point at bytes.
6. Start the full stack with `sudo env BP_ENV_DIR=/opt/business-platform/env BP_IMAGE_TAG=<tag> docker compose -f infra/compose/compose.prod.yml up -d --wait`. The env files are root-owned, and `sudo` clears the shell environment, so the non-secret variables are on the command. Membership of the `docker` group is root-equivalent; the deployment runbook does not use it. See [vps-deployment.md](vps-deployment.md).
7. Check `GET /api/health/ready`, one known company row, one stored file download, and that n8n answers on the SSH tunnel.
8. Write down the start time, the finish time, and anything that failed. Compare the duration with the 8 h RTO.

The fictional seed is not a restore. `pnpm db:seed` loads demo companies and is not part of `compose.prod.yml`.

## Planned (Phase 5), not implemented

From the Phase 1 plan and the Phase 5 list in [docs/security/asvs-checklist.md](../security/asvs-checklist.md):

- Scheduled encrypted off-site `pg_dump` of `business_platform` and of `n8n`, at least every 24 h.
- A copy of `bp_storage` on the same schedule.
- A backup of the env files, with `APP_MASTER_KEYS` also stored separately from the dumps.
- A backup of `N8N_ENCRYPTION_KEY` that is not only the n8n volume.
- A restore drill on a clean VPS, with the results recorded.
- An agreed place for the dump encryption key, outside the dumps and outside this repository.

Until that exists, the VPS has no backup.
