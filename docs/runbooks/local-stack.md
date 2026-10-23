# Local production-like stack

Runs the production compose file on this Mac without touching the dev project
`business-platform` or its volumes. The compose project is `business-platform-local`.
Published ports are `127.0.0.1:8443` (Caddy) and `127.0.0.1:15678` (n8n).

The Colima VM has 4 GiB of RAM. Stop the dev stack before starting this one.
`pnpm dev:infra:down` removes the dev containers and keeps their volumes.

Do not build or pull images when `df -g /System/Volumes/Data` shows less than 15 GB free.

## Start

From the repository root, with Node 24.22.0:

```sh
pnpm setup:env --local-stack
```

Prints `Wrote .env.local-stack with random local secrets` the first time, or
`.env.local-stack already exists; leaving it unchanged`. It does not print the secrets
and it does not read `.env`.

```sh
df -g /System/Volumes/Data
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack build
```

Builds `bp-api`, `bp-migrate`, `bp-tools` and `bp-web` for `BP_IMAGE_TAG=local`.
`docker image ls` then lists those tags. `bp-tools` is only for the demo profile.

```sh
pnpm dev:infra:down
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack up -d --wait
```

`--wait` returns when api, worker, caddy, postgres and n8n are healthy and migrate has exited 0.
The worker is healthy when `/tmp/bp-worker-heartbeat` is newer than 60 seconds. The loop touches that file when a tick starts, after reclaim finishes, after each successful claim, and when that tick finishes. A claim that never settles does not refresh it, and no touch happens once shutdown has begun.

```sh
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack --profile demo run --rm seed
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack --profile demo run --rm import-fixtures
```

`import-fixtures` does not start `seed`; run `seed` first. Seed is idempotent, so running it
again is harmless.

Seed prints the fictional companies. Import prints `prestashop order #P-1001` for company A,
then the company B fixture line. Neither command prints a service token.

```sh
pnpm milestone:verify --phase=initial
```

Prints a PASS/FAIL table and exits 0 when every row is PASS. Each initial run imports a new
Shopify order, external id `MS-<timestamp>`, through the automation import contract with company
A's service token. The gift message is Greek text with line breaks. Row 7 compares the SHA-256
of the UTF-8 bytes that were sent with the bytes stored. Row 9 requires the create response to be a
new `queued` packing slip for this run's order, with a queue-job id, and then polls that job until
a terminal success status. `already_printed` fails that row. The print switch is restored to the
state it had before the run. Cleanup reads the persisted switch and, when that differs, writes the
prior state back. The cleanup row reports that read-back. Row 10 requires
`print_job.requested` for that print job and this order, and `print_job.done_reported` for that
same print job. The OIDC row
says it is covered by test `completes an OIDC login and records whether amr includes mfa`. Ids
are written to `var/milestone-state.json`. Every run copies the Caddy root from the running
container to `var/local-stack/caddy-root.crt`, overwriting the file. The service token is
written to `var/milestone-service-token.json` mode 0600 and is not printed. A local API response
and the SPA must not send HSTS.

```sh
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack restart
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack up -d --wait
pnpm milestone:verify --phase=after-restart
```

The second verify logs in again and checks the client, the draft totals, the gift-message
bytes, `ready`, the print job and the audit events.

## Ports

```sh
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack ps
lsof -nP -iTCP -sTCP:LISTEN | grep -E '8443|15678'
```

The listeners are `127.0.0.1:8443` and `127.0.0.1:15678` only.

## CSP

`pnpm milestone:csp` and `pnpm test:e2e` need Chromium. `pnpm milestone:verify` does not. Install it once from the repository root:

```sh
pnpm exec playwright install chromium
pnpm milestone:csp
```

`pnpm milestone:csp` runs after `pnpm milestone:verify --phase=initial`. It reads
`var/milestone-state.json`, logs in as `admin.a@example.test`, and opens orders, order `#1001`,
invoices, and company A's milestone draft invoice. It waits until orders show a data row, the
order shows the gift message or the status block, and invoices show a row or the empty state.
The draft invoice's five totals must equal the stored totals, and a product or tax-code option
must be present. It then waits until no `/api/` request is in flight, plus a short settle.
Console errors, page errors and `securitypolicyviolation` events are delivered to the Node
process as they happen, so a later navigation does not drop them. Any collected item fails the
check. The only console error allowed is the SPA's pre-login `GET /api/me` 401 on the login
page; any other console error, page error or CSP violation fails the check. `GET /api/health/ready`
and each SPA document must not send HSTS.

Playwright 1.64 has no per-context or per-launch CA option. `clientCertificates` is client
authentication, not a server trust store. The check does not install the Caddy CA. Scoped
trust, and nothing else:

- OpenSSL verifies the leaf against only `var/local-stack/caddy-root.crt`, with
  `-verify_return_error` and `-verify_hostname localhost`, and fails closed.
- Chromium is launched with `--ignore-certificate-errors-spki-list` for that leaf.
- The browser context aborts every request whose origin is not `https://localhost:8443`.

`ignoreHTTPSErrors` stays false. Production Caddy still sets HSTS. This local check does not.

Copy the CA first if the milestone script has not already:

```sh
mkdir -p var/local-stack
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack cp caddy:/data/caddy/pki/authorities/local/root.crt var/local-stack/caddy-root.crt
```

## Stop

```sh
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack down
pnpm dev:infra
```

`down` has no `-v`. Dev volumes are still there. `pnpm dev:infra` starts the dev stack again.

## Restart

```sh
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack restart
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack up -d --wait
```

## Reset

This is the only `down -v`, and only for this project:

```sh
docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack down -v
rm -f var/local-stack/caddy-root.crt
```

That deletes the local stack's volumes. It does not delete the dev project's volumes.
The next start creates a new Caddy CA. Delete the exported root here so a later check
does not keep trusting the old one. `pnpm milestone:verify` copies the root from the
running container on every run. Start again from `up` and the demo profile.
