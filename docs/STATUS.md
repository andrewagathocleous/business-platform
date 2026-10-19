# Implementation status

Last updated: 2026-10-19 (Phase 1 step A review fixes applied, not yet committed).

Test levels:
- **unit**: domain logic in isolation.
- **integration**: real Postgres as `bp_app`.
- **e2e**: browser.
- **mock-tested**: against a mock provider.
- **sandbox-tested**: against the provider's official test environment.
- **live-tested**: against a real account.

## Current phase

Phase 1, step A is implemented in the worktree, including the review fixes. The planner has not committed it. Steps B–E are not started.

## Done

| Item | Evidence |
|---|---|
| Branches `develop`, `deploy_uat`, `deploy_prod` created from `main` and pushed | `git branch -a` |
| Phase 0 docs: architecture, ADRs 0001–0007, permission matrix, threat model, ASVS tracker, rounding rules, source-of-truth matrix, provider constraints (n8n verified 2026-10-19), workflow catalogue, backlog, Phase 1 plan | `docs/` |
| Local toolchain: Node 24.22.0 (nvm), Colima + Docker 29.5.2 + Compose | `.nvmrc` |
| Nx 23.3.0 / pnpm 12.14.0 workspace, ESLint flat config, Prettier, TypeScript 6.0.3 | `pnpm install` produced `pnpm-lock.yaml` (uncommitted) |
| `apps/api` Nest 12.1.3 project that builds. `main.ts` and `main.worker.ts` are marked stubs and exit 1 | `pnpm build`; `pnpm dev:api` and `pnpm dev:worker` exit 1 |
| `packages/domain` money, order state machine, permission catalogue, role templates, `can` / `canGrant` / `grantsForAssignment`, duplicate normalisation, business dates | unit tests |
| `packages/db` Prisma 7.10.1 schema, `TenantDb`, RLS migration, composite same-company foreign keys, idempotent fictional seed | `pnpm db:migrate` (in sync), `pnpm db:seed` twice after a dev reset |
| Dev Postgres 18.6 and n8n 2.43.7 with an external runner, loopback ports only | compose `ps` below |
| CI workflow, including a dist smoke check, full git history for gitleaks, and Postgres bound to `127.0.0.1:5432` | `.github/workflows/ci.yml` (not executed here) |

### Commands verified locally (2026-10-19, after the review fixes)

Node 24.22.0 via nvm. Dev containers were left running. `pnpm install` was already up to date.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date. |
| `pnpm lint` | pass (domain, db, api, documents, integrations). |
| `pnpm typecheck` | pass (same five projects). |
| `pnpm test` | pass. domain 35, n8n-workflows 17, api 1. 53 tests, 8 files. |
| `pnpm build` | pass (api, domain, db, documents, integrations). |
| `node tools/smoke-dist.mjs` and `node -e "require('./packages/db/dist/index.js'); require('./packages/domain/dist/index.js')"` | pass. Both built entry points load. |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 12 tests on `business_platform_test`. The statements under test run as `bp_app`. `bp_owner` sets one invoice to `issued` and reads with no company context. The race test watches `pg_stat_activity` as the local `postgres` role and does not write. |
| `pnpm --filter @bp/db exec prisma migrate reset --force` on `business_platform` | pass. Migrations reapplied. Prisma has no seed hook, so this step did not insert rows. |
| `pnpm db:seed` then `pnpm db:seed` | pass both times. Each printed `Seed completed`. `company` then held only the 2 fictional seeded companies. |
| `pnpm db:migrate` | pass. `Already in sync, no schema change or pending migration was found.` |
| `pnpm setup:env` | pass on the earlier run. Created `.env` once (mode 0600, gitignored). A second run printed `.env already exists; leaving it unchanged` and exited 0. |
| `pnpm dev:infra` equivalent: `docker compose --env-file .env -f infra/compose/compose.dev.yml up -d --wait` | pass on the earlier run. postgres, n8n and n8n-runner healthy. |
| `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:5678/` | `200` on the earlier run |
| `pnpm dev:api`, `pnpm dev:worker` | exit 1 with the stub message. They do not listen. |

`docker compose -f infra/compose/compose.dev.yml ps` published ports:

- `127.0.0.1:5432->5432/tcp` (postgres)
- `127.0.0.1:5678->5678/tcp` (n8n)
- n8n-runner publishes no host port (`5680/tcp` is container-only)

n8n log: `n8n Task Broker ready on 0.0.0.0, port 5679` then `Registered runner "launcher-javascript" (0292942052730cc0)` and `Registered runner "launcher-python" (7019d910d32cbaab)`. Runner log: `[launcher:js] Waiting for launcher's task offer to be accepted...`

Unit coverage includes rounding examples E1–E12, the permission-matrix markdown sync, scope semantics (store-scoped FS and CA, company-wide BASE), state-machine guards, `canGrant` rule 1, the Asia/Nicosia DST instant `2026-10-25T00:30:00Z`, and duplicate normalisation that does not rewrite stored text.

Integration coverage: `bp_app` is not superuser and not `BYPASSRLS`; every RLS table returns 0 rows with no company context (including for `bp_owner`); company A cannot see company B; a cross-company insert fails; `UPDATE`/`DELETE` on `audit_event` fail and the append-only trigger exists; an issued invoice cannot be updated or deleted, and its lines and tax summary cannot be inserted, updated, moved or deleted; a line update blocks while a draft→issued update is uncommitted and then fails; an `invoice_line`, `invoice_tax_summary` or `sales_order_line` cannot reference another company's parent; composite same-company foreign keys and `(company_id, id)` unique indexes are present; `auth_flow.browser_binding_hash` and `sales_order.attention_reasons` are not null; `n8n` cannot `CONNECT` to the test database; every `company_id` table has RLS enabled and forced except `automation_switch`, `invitation`, `job`, `membership`, `role` and `service_identity`.

An earlier integration run had inserted `RLS Company A/B` rows into the dev database `business_platform`. The dev reset removed them. Integration tests and `tools/prepare-test-db.mjs` / `tools/reset-test-db.mjs` now refuse to run unless both `DATABASE_URL` and `DATABASE_URL_OWNER` name a database ending in `_test`.

## In progress

| Item | Notes |
|---|---|
| P1-A | review fixes applied in the worktree, awaiting commit |

## Mocked or blocked

| Capability | State | Blocked by |
|---|---|---|
| Staff login via Entra | not started (Step B). Dev identities are seeded only. | U2 (tenant access) |
| Store sync | schema and mock connection rows only. No import. | U3, U4 |
| Printing | mock printer rows only. No provider. | U6 |
| Invoice issuance | schema, series and immutability trigger only. Seed does not issue invoices. | U1 (accountant validation) |
| HTTP API and web UI | stubs / reserved project only | Steps B and D |
| n8n workflows | export/import/sanitize scripts only. `workflows/n8n/exports` is empty. | Step C |

## Known risks

- Angular 22 pins TypeScript 6.0.x. TypeScript 7 is not used.
- Prisma's npm `latest` tag is 8.0.0-rc.23. This repo pins 7.10.1. `prisma generate` prints an upgrade notice; do not follow it.
- The machine's default Node is 16. Always `nvm use` (`.nvmrc`).
- A later `prisma migrate dev` that changes the schema must be created with `--create-only` and reviewed. Custom partial indexes, RLS, grants and triggers live only in `20261018234900_rls`. After the review fixes and a dev reset, `prisma migrate dev` reported the schema already in sync. A generated migration that drops those objects must not be applied. `packages/db/prisma/manual/rls.sql` matches that migration; keep the two files the same.
- `gitleaks/gitleaks-action@v2` is in CI with `actions/checkout` `fetch-depth: 0`. It was not run locally. On a private repository the action can require a license. `pnpm audit --prod --audit-level high` is `continue-on-error` and was not run locally.
- Vitest 5 warns that `vitest.config.ts` is ESM loaded as CommonJS. The tests pass.
- pnpm 12 will not install dependency build scripts unless `allowBuilds` lists them. CI uses `pnpm install --frozen-lockfile` and needs that list.

## Deviations

- pnpm 12 ignores the `pnpm` key in `package.json`. Build approval and the Nest peer exception live in `pnpm-workspace.yaml` (`allowBuilds`, `peerDependencyRules`).
- `@nx/nest@23.3.0` optionally peers Nest `<12`. Nest stays 12.1.3. The API project is built with `tsc`.
- Step D/C/B packages are not installed: Angular, PrimeNG, Playwright, pdfmake, openid-client, nestjs-zod, `@nx/angular`, `@nx/vite`.
- `apps/web` is a `project.json` reservation (`type:app`, `web`). `packages/documents` and `packages/integrations` export a package-id constant until Step C.
- `dev`, `dev:web`, `test:e2e` and `openapi:export` exit 1. The API stubs exit 1 when executed.
- Compose commands pass `--env-file .env`. Interpolation does not see a repo-root `.env` when the compose file is in `infra/compose`.
- `moduleResolution` is `bundler` (emit stays CommonJS). TypeScript 6 deprecates `node`/`node10`, and that resolver cannot load `@bp/domain`'s `exports` entry.
- `canGrant` implements escalation rule 1 only. Rules 2–4 need the actor, the platform-owner flag and membership counts (Step B).
- Exclusive-mode `lineGross` equals `lineNet`. Inclusive mode still sums line subtotals and discounts into the document subtotal and discount total.
- The delivery-method guard uses error code `delivery_method_not_allowed`.
- Unspecified statuses are text. The seed uses `active`. Gift `line_height` is `1.200`. `job.max_attempts` defaults to 1.
- `fulfil.a` is FS scoped to store `Nutbox Demo Shopify` plus company-wide BASE. `suspended.a` and `fulfil.b` are company-wide FS.
- Company B's store is `Olive Grove Demo Shopify`, location `Demo Shop – Larnaca`, brand `Olive Grove (demo)`.
- Organisation clients have a `reception.<company>@example.test` contact. Individual emails are fictional `.test` addresses. Stored display names are not rewritten.
- Packing-slip mapping is A4 and gift-message mapping is A6. The flaky printer status is `unknown`.
- Switch keys other than global `outbound.all=true` and Company A `printing=true` are explicit `false` rows (`email.send`, `store.write`, `marketing.send`, `social.publish`, `shipment.book`, `invoice.issue_real`).
- Demo stores set `delivery_method_map` to `{local: courier_cy, international: post_international, collection: collection}`.
- `membership_role` uniqueness is an expression index on `COALESCE(scope_id, nil uuid)`, with a check that company scope has a null `scope_id`.
- Draft invoices may have null `series_id`, `number` and `number_seq`.
- Raw use of the Prisma client on RLS tables is called out in `packages/db/src/client.ts` and `rls-tables.ts` rather than a custom ESLint rule. The no-context integration test uses that client on purpose.
- The integration test also asserts that `bp_owner` with no company context sees 0 brand rows, so FORCE RLS applies to the table owner.

## Next step

Step B: API config, security, auth, authorisation and audit. Step A review fixes are in the worktree. The next action is to commit them on `develop`.
