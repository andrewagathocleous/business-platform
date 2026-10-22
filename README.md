# business-platform

Staff application for fictional demo companies: clients, invoice drafts, orders, documents and mock printing. The API, worker and Angular app run against PostgreSQL, with n8n for later orchestration. See [docs/architecture.md](docs/architecture.md) for the shape of the system and [docs/STATUS.md](docs/STATUS.md) for what is implemented and how it was tested.

Shopify and printing in Phase 1 are mocks. The print provider is labelled `Simulated — no physical printing`.

## Prerequisites

- Node 24.22.0 from `.nvmrc`. Run `nvm use` after `source ~/.nvm/nvm.sh`. The machine default is older and will not work.
- pnpm 12.14.0 through corepack (`packageManager` in `package.json`).
- Docker through Colima, for `infra/compose/compose.dev.yml`.

## First-time setup

From the repository root:

```sh
source ~/.nvm/nvm.sh
nvm use
pnpm install
pnpm exec playwright install chromium
pnpm setup:env
pnpm dev:infra
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`pnpm exec playwright install chromium` installs the browser for `pnpm test:e2e` and `pnpm milestone:csp`. The other commands in this setup do not need it.

`pnpm setup:env` copies `.env.example` to gitignored `.env` and replaces each `generate` value with a random local secret. The first write uses mode `0600`. An existing `.env` keeps its current keys. Missing keys from the example are appended. It does not print the secrets.

`pnpm dev:infra` starts Postgres on `127.0.0.1:5432` and n8n on `127.0.0.1:5678` (compose project `business-platform`). `pnpm db:migrate` is `prisma migrate dev` and needs that database. `pnpm db:seed` loads two fictional companies in `Asia/Nicosia` with currency `EUR`.

`pnpm dev` starts the API, the worker and the web server together (`tools/dev-stack.mjs`).

<!-- prettier-ignore -->
| URL | What |
| --- | --- |
| http://127.0.0.1:4200 | Angular app (`pnpm dev:web` forces port 4200) |
| http://127.0.0.1:3000 | API (`HOST` defaults to `127.0.0.1`, `PORT` to 3000) |
| http://127.0.0.1:3000/api/docs | Swagger UI, only when `APP_ENV` is `development` or `test` |
| http://127.0.0.1:5678 | n8n editor on the dev stack |

The web server proxies `/api` to `WEB_API_ORIGIN`, which defaults to `http://localhost:3000`.

Open http://127.0.0.1:4200/login. Dev login is a picker of fictional `.test` accounts. There is no password. It works only when `APP_ENV` is `development` or `test` and `AUTH_DEV_LOGIN_ENABLED=true`. The shell and the order screens are English and Greek. Client, invoice and admin strings fall back to English.

The fixture import posts to the API, so run it in a second terminal after `pnpm dev` is listening:

```sh
pnpm demo:import-fixtures --company A
pnpm demo:import-fixtures --company B
```

`--company` is required (`A` or `B`). The script logs in as that company's admin, posts the mock Shopify fixtures, and drains the job queue in-process. It writes a service token to `var/demo-service-identities.json` (mode `0600`) and does not print the token. Repeat imports count as duplicates.

`--with-prestashop-order` is only valid with `--company A`. The inbox rejects a non-Shopify provider, so that flag inserts one fictional PrestaShop order (`#P-1001`) through the tenant-context database helper. The default import does not.

Seed accounts (all `@example.test`, no passwords):

<!-- prettier-ignore -->
| Email | Role |
| --- | --- |
| `owner@example.test` | Platform owner, no company membership |
| `admin.a@example.test` | Company administrator, Demo Company A Ltd (fictional) |
| `ops.a@example.test` | Operations manager, company A |
| `fulfil.a@example.test` | Fulfilment on the Nutbox Demo Shopify store, plus the staff baseline |
| `finance.a@example.test` | Finance, company A |
| `marketing.a@example.test` | Marketing, company A |
| `support.a@example.test` | Customer support, company A |
| `multi@example.test` | Finance in company B and read-only auditor in company A |
| `admin.b@example.test` | Company administrator, Demo Company B Ltd (fictional) |
| `fulfil.b@example.test` | Fulfilment, company B |
| `suspended.a@example.test` | Suspended fulfilment membership in company A |

Company A is Nutbox (demo data) in Nicosia. Company B is Olive Grove (demo data) in Larnaca. The seed turns on the global `outbound.all` switch and company A's `printing` switch. Company B's `printing` switch is off. Printing stays on the mock provider.

## Commands

Every script in the root `package.json`:

<!-- prettier-ignore -->
| Script | What it does |
| --- | --- |
| `pnpm dev:infra` | Starts Postgres and n8n from `infra/compose/compose.dev.yml`, reading `.env` |
| `pnpm dev:infra:down` | Stops that compose project and keeps its volumes |
| `pnpm db:migrate` | `prisma migrate dev` in `@bp/db` (creates a shadow database; the dev init grants `CREATEDB`) |
| `pnpm db:deploy` | `prisma migrate deploy` in `@bp/db` |
| `pnpm db:reset:test` | Drops and recreates only `business_platform_test` (`tools/reset-test-db.mjs`) |
| `pnpm db:seed` | Runs `packages/db/src/seed/run.ts` as `bp_owner` |
| `pnpm dev` | Starts `dev:api`, `dev:worker` and `dev:web` (`tools/dev-stack.mjs`) |
| `pnpm dev:api` | API through `tsx` (`apps/api/src/main.ts`) |
| `pnpm dev:worker` | Worker through `tsx` (`apps/api/src/main.worker.ts`) |
| `pnpm demo:import-fixtures` | Posts mock Shopify fixtures to a running API; requires `--company A` or `--company B` |
| `pnpm dev:web` | Angular dev server on port 4200 |
| `pnpm lint` | `nx run-many -t lint` (the web target also runs `tools/check-web-safety.mjs`) |
| `pnpm typecheck` | `nx run-many -t typecheck` |
| `pnpm test` | Unit tests: `nx run-many -t test` |
| `pnpm test:integration` | Integration tests against `business_platform_test` (`tools/test-integration.mjs`) |
| `pnpm test:e2e` | Playwright (`tools/e2e.mjs`) |
| `pnpm build` | `nx run-many -t build` |
| `postinstall` | `prisma generate` in `@bp/db` (runs after `pnpm install`) |
| `pnpm setup:env` | Writes `.env`, or `.env.local-stack` when passed `--local-stack` |
| `pnpm milestone:verify` | Milestone HTTP checks against `https://localhost:8443` (`tools/milestone/verify.ts`) |
| `pnpm milestone:csp` | CSP browser check for the local stack (`tools/milestone/csp-check.ts`) |
| `pnpm openapi:export` | Writes `docs/api/openapi.json` |

The milestone commands need the local production-like stack in [docs/runbooks/local-stack.md](docs/runbooks/local-stack.md). That stack has not been started; see [docs/STATUS.md](docs/STATUS.md).

## Tests

`pnpm test` does not need Postgres. It runs the `test` target of `domain`, `documents`, `integrations`, `db`, `api`, `web`, `tools` and `n8n-workflows`: money and tax, PDF layout, the Shopify mapper, the mock print provider, the web components, and the n8n sanitiser.

`pnpm test:integration` needs `pnpm dev:infra`. `tools/test-integration.mjs` points `DATABASE_URL` at `business_platform_test`, refuses any other database name, prepares that database, then runs `db:test-integration` and `api:test-integration`. Those tests cover RLS, auth, tenancy, commerce, orders, documents, printing and the vault against real Postgres. They do not use the seeded `business_platform` database.

`pnpm test:e2e` is Playwright 1.64.1 through `tools/e2e.mjs`. It needs the Chromium from `pnpm exec playwright install chromium` in the setup above. `pnpm milestone:csp` needs that same browser. Before the e2e harness loads env or touches a database it refuses to start when `127.0.0.1`, `::1` or `localhost` already accepts a connection on port 3100 or 4300. It resets and seeds `business_platform_test`, starts the API on port 3100, the worker with storage under `var/e2e/`, and the web server on port 4300, imports the company A fixtures, then runs `apps/web-e2e`. It does not listen on 4200, 5432 or 5678. Playwright is not in CI. Specs: `shell.spec.ts`, `orders.spec.ts`, `d3.spec.ts`.

After `pnpm build`:

- `node tools/check-bundle.mjs` scans the built web files for `bps_`, `APP_MASTER`, database URLs, `CSRF_SECRET`, `OIDC_CLIENT_SECRET`, and for any `.env` value of at least 8 characters whose name looks like a secret. CI runs it. On failure it prints the variable name and the file, not the value.
- `node tools/smoke-dist.mjs` loads the built packages, renders a draft PDF, a packing slip and a gift message, maps one Shopify order, submits one mock print, and starts the built API and worker against `DATABASE_URL_TEST`. It needs `.env` and the dev Postgres.
- `node tools/check-compose-config.mjs` runs `docker compose config --quiet` for `compose.prod.yml` and for the local override. It pulls nothing and starts nothing.

Latest counts are in [docs/STATUS.md](docs/STATUS.md).

## Repository layout

<!-- prettier-ignore -->
| Path | What it is |
| --- | --- |
| `apps/api` | NestJS HTTP API and worker |
| `apps/web` | Angular staff application (PrimeNG) |
| `apps/web-e2e` | Playwright specs |
| `packages/domain` | Money, tax, order state machine, permissions, shared zod contracts |
| `packages/db` | Prisma schema, migrations, RLS, seed |
| `packages/documents` | Invoice, packing-slip and gift-message PDFs |
| `packages/integrations` | Mock print provider, Shopify order mapper, local file storage |
| `infra/compose` | `compose.dev.yml`, `compose.prod.yml`, `compose.local.yml` |
| `infra/caddy` | Caddy site (`Caddyfile`, `Caddyfile.local`, `app.caddy`) |
| `infra/docker` | `api.Dockerfile` and `web.Dockerfile` |
| `infra/postgres` | Role SQL and the dev init script |
| `tools` | Dev, test, env, bundle, smoke, compose and milestone scripts |
| `workflows/n8n` | Sanitiser, import and export scripts; `exports/` is empty |
| `.github/workflows` | CI (`ci.yml`): lint, unit tests, integration tests, build, bundle check, smoke, gitleaks |
| `docs` | Architecture, plan, security, finance, integrations, runbooks |

## Docs

- [docs/STATUS.md](docs/STATUS.md) — what works, how it was tested, and what is next
- [docs/BACKLOG.md](docs/BACKLOG.md) — backlog by phase
- [docs/architecture.md](docs/architecture.md) — modules, data flow, credentials
- [docs/plan/phase-1.md](docs/plan/phase-1.md) — Phase 1 plan and Milestone 1 acceptance
- [docs/history/phase-1-step-c-log.md](docs/history/phase-1-step-c-log.md) — Step C run log
- [docs/source-of-truth-matrix.md](docs/source-of-truth-matrix.md) — which system owns each kind of data
- [docs/finance/rounding.md](docs/finance/rounding.md) — money and tax rounding
- [docs/security/threat-model.md](docs/security/threat-model.md) — threat model
- [docs/security/permission-matrix.md](docs/security/permission-matrix.md) — role templates and permissions
- [docs/security/asvs-checklist.md](docs/security/asvs-checklist.md) — OWASP ASVS chapter tracker
- [docs/integrations/provider-constraints.md](docs/integrations/provider-constraints.md) — provider checks, including n8n
- [docs/integrations/printnode.md](docs/integrations/printnode.md) — mock printing now, PrintNode in Phase 2
- [docs/integrations/shopify.md](docs/integrations/shopify.md) — mock Shopify import now, live API in Phase 2
- [docs/workflows/catalogue.md](docs/workflows/catalogue.md) — planned n8n workflows
- [docs/runbooks/local-stack.md](docs/runbooks/local-stack.md) — production-like stack on this Mac
- [docs/runbooks/vps-deployment.md](docs/runbooks/vps-deployment.md) — draft VPS deployment (not run on a server)
- [docs/runbooks/backup-restore.md](docs/runbooks/backup-restore.md) — backup design (not implemented)
- [docs/api/openapi.json](docs/api/openapi.json) — exported OpenAPI document
- [docs/adr/0001-modular-monolith-nx-stack.md](docs/adr/0001-modular-monolith-nx-stack.md) — Nx, Angular, NestJS, Postgres
- [docs/adr/0002-n8n-community-orchestration-boundary.md](docs/adr/0002-n8n-community-orchestration-boundary.md) — n8n orchestrates, the app owns business state
- [docs/adr/0003-tenant-isolation-rls.md](docs/adr/0003-tenant-isolation-rls.md) — membership checks and RLS
- [docs/adr/0004-authentication-entra-oidc-sessions.md](docs/adr/0004-authentication-entra-oidc-sessions.md) — Entra OIDC and server-side sessions
- [docs/adr/0005-postgres-jobs-inbox-outbox.md](docs/adr/0005-postgres-jobs-inbox-outbox.md) — jobs, inbox and outbox in Postgres
- [docs/adr/0006-money-and-pdf.md](docs/adr/0006-money-and-pdf.md) — decimal money and server-side PDFs
- [docs/adr/0007-credentials-and-outbound-safety.md](docs/adr/0007-credentials-and-outbound-safety.md) — vault, service tokens and switches
