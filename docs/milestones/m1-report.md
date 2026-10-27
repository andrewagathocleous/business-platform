# Milestone 1 report

Milestone 1 acceptance (`docs/plan/phase-1.md`, items 1–12) was demonstrated on the local
production-like stack on 2026-10-22, between 20:55 and 21:03 UTC. Every item passed.

**Test level: local stack with mock providers.** Shopify is the mock import contract with fictional
fixtures, printing is the mock PrintNode provider, and staff sign-in is dev login. The OIDC code path
is covered only by an integration test against a mock OIDC provider. Nothing here is sandbox-tested or
live-tested, and no real store, printer, mailbox or identity provider was contacted.

## What was run

|             |                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code        | `develop` at `eb4ed0e`, plus the uncommitted Step E fix rounds 3, 4 and 5 (see [Defects found by this run](#defects-found-by-this-run))                                                |
| Host        | macOS 15.7.3, Colima 0.10.3 (aarch64, 4 CPU, 4 GiB), Docker Engine 29.5.2, Docker CLI 29.9.1, Compose 5.6.0, Node 24.22.0                                                              |
| Stack       | `docker compose -p business-platform-local -f infra/compose/compose.prod.yml -f infra/compose/compose.local.yml --env-file .env.local-stack`, following `docs/runbooks/local-stack.md` |
| Start state | `down -v` first: empty Postgres, storage, n8n and Caddy volumes                                                                                                                        |

Images, built from that tree with `docker compose ... build` (the classic builder; `buildx` is not
installed on this Mac):

| Image                                                                   | Id                     | Size    |
| ----------------------------------------------------------------------- | ---------------------- | ------- |
| `bp-api:local` (api and worker)                                         | `sha256:d9bbf8bee375…` | 746 MB  |
| `bp-migrate:local`                                                      | `sha256:cf76d0750001…` | 618 MB  |
| `bp-web:local` (Caddy and the SPA)                                      | `sha256:bb3cb6cc65e5…` | 94.5 MB |
| `bp-tools:local` (local demo profile only, never in `compose.prod.yml`) | `sha256:dee0c0f7788c…` | 2.63 GB |

## Acceptance

| #   | Item                                                   | Evidence                                                                                                                                                                                                                       | Result |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | Authorised login                                       | `1 dev login` on the stack. OIDC: integration test `completes an OIDC login and records whether amr includes mfa` (mock provider)                                                                                              | PASS   |
| 2   | Two isolated companies                                 | `2 companies`: admin.a sees only company A, admin.b only company B                                                                                                                                                             | PASS   |
| 3   | Company-scoped roles                                   | `3 roles`: admin.a lists invoices, fulfil.a gets 403                                                                                                                                                                           | PASS   |
| 4   | Client registration                                    | `4 client`                                                                                                                                                                                                                     | PASS   |
| 5   | Draft invoice with backend totals and a PDF            | `5 invoice`: total `20.23` (subtotal 20.00, discount 3.00, net 17.00, tax 3.23), PDF served. The CSP check also opened this draft in the browser and required the same five totals                                             | PASS   |
| 6   | Mock order through the real automation import contract | `6 order import`: order `MS-1792702650851`, posted with company A's service token                                                                                                                                              | PASS   |
| 7   | Gift message byte-for-byte (Greek, line breaks)        | `7 gift message`: SHA-256 of the UTF-8 bytes sent equals the bytes stored, `c72b7df2…62b85d1e`. The same hash after restart                                                                                                    | PASS   |
| 8   | Transition to `ready`                                  | `8 ready`                                                                                                                                                                                                                      | PASS   |
| 9   | Simulated print processed by the worker                | `9 print`: new `queued` packing slip, polled to `done_reported` through the mock provider. `9 print switch restored`: unchanged `on`                                                                                           | PASS   |
| 10  | Audit history                                          | `10 audit`: `print_job.requested` and `print_job.done_reported` for that print job, plus the other company actions. Login audit: integration test `logs in through the development picker and lists only authorised companies` | PASS   |
| 11  | Restart and persistence                                | Full `docker compose restart`, then `--phase=after-restart`: client, draft totals, order, gift-message bytes, `ready`, print job and audit events all present                                                                  | PASS   |
| 12  | Unauthorised access denied                             | 11 automated rows below, plus the integration suites                                                                                                                                                                           | PASS   |

Item 12, checked on the stack:

| Check                                                                    | Expected               | Got           |
| ------------------------------------------------------------------------ | ---------------------- | ------------- |
| admin.b reads A's order, invoice, invoice PDF, file and print job        | 404 each               | 404 each      |
| fulfil.a lists invoices                                                  | 403                    | 403           |
| fulfil.a reads A's PrestaShop order (`#P-1001`, outside its store scope) | 404                    | 404           |
| A's service token reads B's connection                                   | 404                    | 404           |
| A's service token uses B's company route                                 | 404                    | 404           |
| Suspended user                                                           | denied                 | 404           |
| Logged-out session cookie replayed on `GET /api/me`                      | 401 after a 204 logout | 204, then 401 |

The same rules are covered against real Postgres by `pnpm test:integration` (167 tests on the final
code: db 13, api 154), including the route sweep in `isolation.integration.test.ts`. Every company
route that takes an object id is called with another company's id, and a new route that is neither
swept nor exempted fails the test.

## Output

### Start, seed and fixture import

```
$ docker compose ... up -d --wait
 Container business-platform-local-api-1 Healthy
 Container business-platform-local-caddy-1 Healthy
 Container business-platform-local-migrate-1 Exited
 Container business-platform-local-n8n-1 Healthy
 Container business-platform-local-n8n-runner-1 Healthy
 Container business-platform-local-postgres-1 Healthy
 Container business-platform-local-worker-1 Healthy
up exit 0

SERVICE      STATE     STATUS                      PORTS
api          running   Up 11 seconds (healthy)     3000/tcp
caddy        running   Up 5 seconds (healthy)      80/tcp, 2019/tcp, 443/udp, 127.0.0.1:8443->443/tcp
migrate      exited    Exited (0) 11 seconds ago
n8n          running   Up 17 seconds (healthy)     127.0.0.1:15678->5678/tcp
n8n-runner   running   Up 17 seconds               5680/tcp
postgres     running   Up 22 seconds (healthy)     5432/tcp
worker       running   Up 11 seconds (healthy)     3000/tcp

$ docker compose ... --profile demo run --rm seed
$ pnpm --filter @bp/db seed
$ tsx --conditions=bp-source src/seed/run.ts
Seed completed
seed exit 0

$ docker compose ... --profile demo run --rm import-fixtures
$ tsx ... apps/api/src/demo-import-fixtures.ts --company A --with-prestashop-order
prestashop order #P-1001
company A (Demo Company A Ltd (fictional))
events 5: accepted 5, duplicate 0
worker processed 2
orders 0 -> 3
  #1001 v2 new paid
  #1003 v1 review_required paid review=unsupported_glyphs
  #P-1001 v1 new paid
$ tsx ... apps/api/src/demo-import-fixtures.ts --company B
company B (Demo Company B Ltd (fictional))
events 1: accepted 1, duplicate 0
worker processed 1
orders 0 -> 1
  #2001 v1 new paid
import exit 0
```

The worker container claimed one of company A's import jobs while the script was draining the queue,
so the script listed orders before `#1002` committed. A database read straight after showed all four
company A orders (`#1001`, `#1002`, `#1003`, `#P-1001`), company B's `#2001`, and six
`inbox.process` jobs, all `succeeded`. The summary line is a reporting race, not lost data.

### Initial phase

```
$ pnpm milestone:verify --phase=initial        (2026-10-22T20:57:27Z)
item                          result  detail
1 oidc                        PASS    covered by test `completes an OIDC login and records whether amr includes mfa`
13 no HSTS                    PASS    api health has no HSTS
1 dev login                   PASS    dev login admin.a@example.test
2 companies                   PASS    admin.a sees only company A; admin.b sees only company B
3 roles                       PASS    admin.a can list invoices; fulfil.a is 403
4 client                      PASS    client created
5 invoice                     PASS    draft total 20.23; pdf ok
6 order import                PASS    MS-1792702650851 imported
7 gift message                PASS    c72b7df26d2b3a0ee80be430cfffae8158b48b4bb446d6bca3591a5062b85d1e
8 ready                       PASS    ready
9 print                       PASS    done_reported
9 print switch restored       PASS    unchanged on
10 audit                      PASS    company actions audited; login audit covered by test `logs in through the development picker and lists only authorised companies`
12 admin.b order              PASS    404
12 admin.b invoice            PASS    404
12 admin.b pdf                PASS    404
12 admin.b file               PASS    404
12 admin.b print job          PASS    404
12 fulfil.a invoices          PASS    403
12 fulfil.a prestashop order  PASS    404
12 service token connection   PASS    404
12 service token company      PASS    404
12 suspended user             PASS    404
12 logout                     PASS    204
verify exit 0
```

### Restart and after-restart phase

```
$ docker compose ... restart                   (2026-10-22T20:58:43Z)
restart exit 0
$ docker compose ... up -d --wait
up exit 0
SERVICE      STATE     STATUS
api          running   Up 21 seconds (healthy)
caddy        running   Up 21 seconds (healthy)
migrate      exited    Exited (0) 5 seconds ago
n8n          running   Up 11 seconds (healthy)
n8n-runner   running   Up 16 seconds
postgres     running   Up 21 seconds (healthy)
worker       running   Up 21 seconds (healthy)

$ pnpm milestone:verify --phase=after-restart  (2026-10-22T20:59:05Z)
item               result  detail
13 no HSTS         PASS    api health has no HSTS
11 login           PASS    dev login admin.a@example.test
11 client          PASS    client still exists
11 invoice totals  PASS    total 20.23
11 order           PASS    order still exists
11 gift message    PASS    c72b7df26d2b3a0ee80be430cfffae8158b48b4bb446d6bca3591a5062b85d1e
11 ready           PASS    ready
11 print job       PASS    done_reported
11 audit           PASS    audit events still exist
verify exit 0
```

### CSP and headers in the browser

`pnpm milestone:csp` (Chromium, leaf certificate verified with OpenSSL against only the exported
Caddy root, every request outside `https://localhost:8443` aborted) logs in as admin.a, then opens
orders, order `#1001`, invoices and the milestone draft invoice:

```
$ pnpm milestone:csp                           (2026-10-22T21:02:40Z)
csp check passed
expected pre-login 401 on /api/me: 1
headers: nosniff, referrer-policy, permissions-policy, csp; no HSTS; no Server
csp exit 0
```

The first run, at 20:57:44Z, failed on one console error: Chromium logs the SPA's startup
`GET /api/me` 401 on the login page as `Failed to load resource`. That probe is how the SPA learns no
session exists. Fix round 5 allows exactly that message: before sign-in, at exactly
`https://localhost:8443/api/me`, with status 401. Any other console error, page error or CSP violation
still fails. There were no CSP violations in either run.

### Exposure

```
$ docker compose ... ps --format '{{.Service}} {{.Publishers}}'
api [3000/tcp -> :0]
caddy [80/tcp -> :0 443/udp -> :0 443/tcp -> 127.0.0.1:8443 2019/tcp -> :0]
n8n [5678/tcp -> 127.0.0.1:15678]
n8n-runner [5680/tcp -> :0]
postgres [5432/tcp -> :0]
worker [3000/tcp -> :0]

$ lsof -nP -iTCP -sTCP:LISTEN   (ports 8443, 15678, 3000, 5432, 5678, 80, 443)
ssh 127.0.0.1:15678 (LISTEN)
ssh 127.0.0.1:8443 (LISTEN)
```

Only Caddy (`127.0.0.1:8443`) and the n8n editor (`127.0.0.1:15678`) are published, both on loopback.
Postgres, the api, the worker and the n8n runner publish nothing. In `compose.prod.yml` Caddy
publishes 80 and 443. That file was not run on its own here, because it shares the dev stack's
project name.

### Image secret scan

Each image's filesystem was exported (`docker create` and `docker export`) and checked three ways:

1. **Known values.** Every secret value in `.env.local-stack` and `.env` (25 values, from variables
   whose names contain `SECRET`, `KEY`, `TOKEN`, `PASSWORD`, `CREDENTIAL` or `PRIVATE`, plus URL
   passwords) was searched for as bytes in every file. Only variable names are printed.
2. **Forbidden files.** Any `.env*` other than `.env.example`, `*.pem`, `*.key`, `*.crt`, `*.p12`,
   SSH keys, service-token files, `.npmrc`, or a `var/` directory under `/app` or `/src`, outside the OS
   trust store.
3. **gitleaks 8.18.4**, `detect --no-git --redact`, run inside its container on the streamed
   filesystem. A planted canary (a fake AWS key and a fake GitHub token) was caught first, to prove the
   scanner saw files.

| Image                   | Files   | Known values found | Forbidden files                                                                   | gitleaks                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | ------- | ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bp-api`                | 15,417  | 0 of 25            | npm's empty built-in `.npmrc`                                                     | 1 false positive: `const int kApiTaggedSize = kApiInt32Size;` in Node's `v8-internal.h`                                                                                                                                                                                                                                                                             |
| `bp-web`                | 262     | 0 of 25            | none                                                                              | 0                                                                                                                                                                                                                                                                                                                                                                   |
| `bp-migrate`            | 13,287  | 0 of 25            | npm's empty built-in `.npmrc`                                                     | 2 false positives: the same `v8-internal.h` line, and npm's `key` documentation example `-----BEGIN PRIVATE KEY-----\nXXXX\nXXXX\n-----END PRIVATE KEY-----` in a Node compile cache under `/tmp`                                                                                                                                                                   |
| `bp-tools` (local only) | 126,975 | 0 of 25            | npm's built-in `.npmrc`, and the repo's `/src/.npmrc` (`engine-strict=true` only) | 1,294 hits, almost all in third-party package files: the pnpm content store, pnpm's registry metadata cache and the generated Prisma client. The two hits in this repo's own files are false positives: a fictional UUID at `tools/milestone/contract.test.ts:187` and Prisma's base64 schema graph in `class.ts`. The third-party hits were not triaged one by one |

No secret of this deployment is in any image. `bp-tools` holds the whole build toolchain and is used
only by the local demo profile. `compose.prod.yml` never references it, and it must not be pushed to a
registry. The first scan attempt used `gitleaks dir`, which 8.18.4 does not have, and a bind mount
from outside `$HOME`, which Colima does not share. It reported zero because it scanned nothing. The
results above are from the corrected, canary-checked run.

## Defects found by this run

The local stack had never been started before this run. It found four defects, fixed in rounds 4 and
5 before the clean run above:

| Defect                                                                                                                                                                                                    | Fix                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `demo-import-fixtures --with-prestashop-order` failed in Prisma (`Unknown argument companyId`): the order line's relation is `(companyId, orderId)`, so a nested create takes `companyId` from the parent | Removed it from the nested create. The insert moved to `apps/api/src/demo-prestashop-order.ts`, with an integration test that runs it twice against real Postgres |
| `seed` was OOM-killed at its 256 MiB local limit (exit 137)                                                                                                                                               | 512 MiB in `compose.local.yml`                                                                                                                                    |
| `import-fixtures` started `seed` again as a dependency, so the runbook's two steps seeded twice                                                                                                           | The dependency is removed, and `tools/check-compose-config.mjs` fails if it comes back                                                                            |
| `pnpm milestone:csp` failed on the SPA's expected pre-login `GET /api/me` 401                                                                                                                             | Round 5, above                                                                                                                                                    |

Fix round 3, from the previous review, also landed in this tree: the worker no longer touches its
heartbeat file once shutdown begins; the CSP check opens the milestone draft and requires its totals,
and waits only on visible elements; and `.dockerignore` matching supports character classes and
Unicode like Go `filepath.Match`.

Not fixed, recorded in `docs/STATUS.md`:

- With the classic builder, `docker compose build` can fail with `image "bp-api:local" already exists`,
  because `api` and `worker` build the same tag in parallel. The image itself builds. Building one
  service at a time, or installing `buildx`, avoids it.
- The fixture import's order summary can miss an order that the worker container is still committing
  (see above).

## What Milestone 1 does not prove

- No live provider: Shopify, PrestaShop, PrintNode, Microsoft Entra ID and couriers are mocks or absent.
  Phase 2 and Phase 3 replace them.
- No invoice issuance: drafts only. There is no issue endpoint (Phase 3).
- No production deployment: the VPS runbook, backups and restore were not executed. A fresh production
  database has no platform owner (P1-F), and the break-glass recovery runbook named by ADR-0004 does not
  exist (P1-G). Both block a real deployment.
- Performance and capacity on the target VPS size were not measured.
