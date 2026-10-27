# Implementation status

Last updated: 2026-10-21 (fix round 6, uncommitted on `develop`).

Test levels:

- **unit**: domain logic in isolation.
- **integration**: real Postgres as `bp_app`, plus HTTP tests that boot the Nest app against that database.
- **e2e**: browser.
- **mock-tested**: against a mock provider.
- **sandbox-tested**: against the provider's official test environment.
- **live-tested**: against a real account.

## Current phase

Phase 1 step A is commit `ca7d578`. Step B is commit `271bd1d`. Step C is in the worktree and is not committed: C-1, C-2a, the review-fix rounds, C-2b1, fix rounds 3 and 4, C-2b2 (mock printing), and fix rounds 5 and 6. Step D (the web app) has not been started.

## Done

| Item | Evidence |
|---|---|
| Branches `develop`, `deploy_uat`, `deploy_prod` created from `main` and pushed | `git branch -a` |
| Phase 0 docs: architecture, ADRs 0001–0007, permission matrix, threat model, ASVS tracker, rounding rules, source-of-truth matrix, provider constraints (n8n verified 2026-10-19), workflow catalogue, backlog, Phase 1 plan | `docs/` |
| Local toolchain: Node 24.22.0 (nvm), Colima + Docker 29.5.2 + Compose | `.nvmrc` |
| Nx 23.3.0 / pnpm 12.14.0 workspace, ESLint flat config, Prettier, TypeScript 6.0.3 | `pnpm install` |
| Step A: Prisma 7.10.1 schema, `TenantDb`, RLS, composite foreign keys, fictional seed | commit `ca7d578` |
| B-1 API skeleton: config validation, pino, correlation id, helmet, exception filter, health, OpenAPI, throttling, worker context | `pnpm dev:api`, `pnpm dev:worker`, `pnpm openapi:export` |
| Deny-by-default guard, `@Public()` / `@RequirePermission()` / `@Authenticated()` / `@PlatformOwner()`, route self-check, `AuditService` | API unit and HTTP integration tests |
| B-2 staff authentication: sessions, CSRF, dev login, OIDC against `oauth2-mock-server`, logout, `GET /api/me` | `apps/api/src/identity`, auth integration tests |
| B-3 company access, permission checks, MFA withholding, service identities, tenancy and platform endpoints | `apps/api/src/tenancy`, `platform`, `automation`, `authz`; tenancy integration tests |
| B-1 follow-ups: a handler with permission metadata is never public, throttle defaults 300/20/120, optional `HOST` | route-policy and guard tests, throttle integration test, `.env.example` |
| Step A follow-ups A1–A4: composite `print_job` queue FK, test-database guard, ACL on existing test DBs, n8n sanitiser | migration `20261020180003_job_company_queue_fk`, tools tests, n8n tests, RLS integration test |
| C-1 clients, catalogue, draft invoices and PDF, credential vault | `apps/api/src/clients`, `catalog`, `invoices`, `vault`; `packages/documents`; migration `20261020212057_service_identity_expires_at_not_null` |
| C-2b1 documents, storage and the switches API | `packages/documents` packing slip and gift message; `packages/integrations/src/storage`; `apps/api/src/documents`, `storage`, `automation/company-automation.*`. No new migration |
| C-2b2 mock printing | `packages/integrations/src/printing`; `apps/api/src/printing`; external job mode in `job-runner.ts`. No new migration. Mock-tested, not sandbox or live |
| Fix round 5 | Job completion fence, n8n sanitiser fail-closed, gift-message fit and CRLF, storage descriptor close, `STORAGE_ROOT` from the repository root. No new migration. See "Fix round 5" |
| Fix round 6 | Print invariant: one provider call per print job, never after a successful cancel, and every provider outcome is audited, including a late one. Lock order is `print_job` then `job`. No new migration. See "Fix round 6" |

### What B-3 added

Company routes under `/api/c/:companyId` load an active membership (a suspended or removed membership, or a disabled user, is not a member). A non-member gets 404 and an audited denial. Grants come from `@bp/domain` `grantsForAssignment` with BASE semantics. When `AUTH_REQUIRE_MFA_FOR_PRIVILEGED=true` and the session has `mfa_satisfied=false`, `applyMfaPolicy` strips `member.invite`, `member.manage`, `member.sessions.revoke`, `role.manage`, `company.bank.manage`, `automation.manage`, `service_identity.manage`, `store.manage`, `integration.manage`, and platform-owner capabilities, while the context is built. `GET /api/me` applies the same policy before the owner flag, so a non-MFA owner session lists only its active memberships.

Permission checks run for every `@RequirePermission` route. A company-level miss is 403. A store outside the caller's grants is 404. `permittedScopeFilter` and `resolvePermission` are the helpers Step C will use. No store-scoped list endpoint exists yet.

Automation routes are controllers marked `@AutomationRoute()`. The guard and the automation throttler use that metadata. Boot fails when a controller under `/api/automation` lacks the marker, or a marked controller sits outside that prefix. Those routes accept only `Authorization: Bearer bps_<id>.<secret>`. A session cookie, with or without `X-XSRF-TOKEN`, is 401. The hash is compared in constant time. Status, expiry and company match are checked. `last_used_at` moves at most once a minute. `GET /api/automation/v1/c/:companyId/ping` requires `store.events.ingest` so the tests have a target. It does not ingest events. Express routing is case-sensitive, so `/API/auth/...` does not match `/api/auth/...` and does not consume the auth limiter.

Endpoints, with state changes and denials audited:

- `GET /api/c/:companyId/context` (`company.view`): company summary, grants, every company switch and its enabled flag, `mfaStepUpRequired`, withheld permissions
- `GET /api/c/:companyId/members`, `GET /api/c/:companyId/members/:membershipId`, `GET /api/c/:companyId/roles` (`member.view`)
- `POST /api/c/:companyId/invitations` (`member.invite` plus `canGrant`). The link is returned once. No email is sent. TTL is 7 days.
- `PATCH /api/c/:companyId/members/:membershipId` (`member.manage`): roles and status, escalation rules 1–6. The transaction starts with `SELECT … FROM company WHERE id = $1 FOR UPDATE`. A status change then locks `user_account` with `SELECT … FOR UPDATE` before the write. Suspending revokes that user's sessions only when they have no other active membership. The user lock is what makes two companies suspending the same person see a consistent count.
- `POST /api/c/:companyId/members/:membershipId/revoke-sessions` (`member.sessions.revoke`)
- `GET /api/c/:companyId/audit-events` (`audit.view`): object type/id, action, actor, outcome, date range, paginated
- `GET`, `POST` and `DELETE /api/c/:companyId/service-identities[/:id]` (`service_identity.manage`). The token is returned once. Only the SHA-256 of the secret is stored. `expiresAt` defaults to 90 days, must be in the future, and must be at most 365 days ahead. `null`, a past timestamp and a later timestamp are 400. A revoke that loses the conditional update records `authorization.denied` and returns 404.
- Platform owner: `GET /api/platform/companies`, `POST /api/platform/companies` (role templates, example tax codes, seven company switches false), `PUT /api/platform/switches/outbound.all`

`canGrant` in `@bp/domain` now covers escalation rules 2–4 as well as rule 1. Rule 1 still applies on its own when no escalation subject is passed, which is how invitations are checked.

### Review fixes

- Platform-owner `GET /api/me` applies the MFA policy before the owner company list.
- Invitation acceptance, under the company lock, re-checks that the inviter is still an active member, still holds `member.invite`, and can still grant every stored role. Email linking is refused when the account already has an Entra identity or is a platform owner.
- Membership status changes lock the user row after the company row.
- Request logs replace `invitation`, `code`, `state`, `session_state`, `id_token`, `token` and `access_token` query values with `[Redacted]`, and redact the `location` response header.
- The n8n sanitiser inspects expression bodies and rejects URL userinfo.
- Audit `objectId` and `actorId` filters that are not UUIDs return 400. Malformed path ids stay 404 with an audit event.
- `@bp/db` and `@bp/domain` resolve source through the `bp-source` export condition for dev, test and typecheck, and `dist` for plain Node. `tools/smoke-dist.mjs` starts the built API and worker. CI runs that smoke after the integration tests, with `DATABASE_URL_TEST`.
- OpenAPI path parameters `companyId`, `membershipId` and `id` are declared. `pnpm openapi:export` regenerated `docs/api/openapi.json`.

### Commands verified locally (2026-10-20, Step B review fixes)

Node 24.22.0 via nvm. Dev Postgres was already running. No new dependency and no new migration. `pnpm test` in the sequence below used the Nx cache for 2 of 4 projects and did not print counts. An immediate uncached re-run printed the counts in the table.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. domain 39, n8n-workflows 25, api 37, tools 7. 108 tests, 18 files |
| `pnpm build` | pass. 5 tasks. `api` depends on `db` and `domain` through Nx `implicitDependencies` and `dependsOn: ["^build"]` |
| `node tools/smoke-dist.mjs` | pass. Loads both package dists, `GET /api/health/ready` returned 200, the worker logged `worker ready`, and both processes exited 0 after SIGTERM |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 69 tests on `business_platform_test`: db 13, api 56. Verbose list below |
| `pnpm openapi:export` | pass. Company, membership, service-identity and automation operations declare their path parameters |
| `pnpm dev:api`, then HTTP as `admin.a@example.test` and `admin.b@example.test` | context 200 (Demo Company A, `member.manage` present, MFA step-up false, 7 switches), members 200 (8 members, includes admin.a), audit-events 200 (0 company-scoped rows on the dev database). admin.b on company A members is 404 `not_found`. Cookies were redacted in the server log. The server was then stopped |

Integration tests, verbose:

- db row level security (13): connects as `bp_app` without bypassrls; no rows without company context; current company only, including the table owner; cross-company insert rejected; audit update and delete rejected; issued invoice, lines and tax summary immutable; in-flight issue blocks a line update; cross-company child and print-job queue references rejected; company-scoped parent references stay in the company; browser binding required and attention reasons non-null; n8n cannot connect; FORCE RLS on every `company_id` table except the documented exemptions
- authentication (25): dev login and company lists; previous cookie revoked on the next login; revoked session 401 plus audit; CSRF missing and wrong token 403 plus audit, then logout 204; unknown email 401 plus failure audit; bearer token on a staff route 401; idle expiry and the one-minute `last_seen_at` touch; absolute expiry after idle was refreshed; OIDC happy path with and without `mfa` in `amr`; wrong state; wrong nonce; replayed callback; different cookie jar and missing `bp_oidc_flow`; unprovisioned identity; open redirects; invitation email match; `preferred_username` match; email mismatch; one of two concurrent accepts; suspended inviter, missing `member.invite`, and a grant the inviter can no longer make are each 403 plus an audit reason and leave the invitation open; a different Entra identity and a platform-owner email are refused; an account with no Entra identity can be linked
- HTTP API (10): live and ready; invalid correlation id replaced; error shape without a stack; oversized body; raw body; cookie and authorization redaction; invitation and OIDC query redaction; 401 plus `authorization.denied`; audit detail redaction; dev login and OIDC 404 when disabled
- auth rate limit (1): four `GET /API/auth/dev/users` responses are 404 and do not consume the limiter; the third `GET /api/auth/dev/users` is 429 when the limit is 2
- authorisation and tenancy (18): company context, members and audit events; admin.b on company A is 404 plus `not_a_member`; a guessed membership id under the other company is 404 plus `membership_not_found`; a session without `member.view` is 403 plus `permission_missing`; fulfil.a is store-scoped FS plus company-wide BASE, and `resolvePermission` returns `not_found` for a store outside that scope; suspending multi@example.test in A is immediate while company B still works and the session stays; revoke-sessions then 401; an operations manager cannot invite; self role change and self suspend are `self_modification`; a platform-owner flag in the body is 400; a missing store is 404 `scope_not_found`; an invitation link is returned once and only its hash is stored; CSRF on that post is 403; a company admin cannot suspend a platform owner; a caller who holds `member.invite` but not the target role's permissions gets `grant_not_allowed`; a role change is audited and restored; only the platform owner can suspend the last `member.manage` holder, which also revokes that user's sessions; service tokens (create, hash-only storage, ping, `last_used_at` once a minute, permission 403, cross-company 404, staff-route 401, ordinary permission the creator lacks, expiry 401, revoke 401); a staff cookie on the ping route is 401 with and without `X-XSRF-TOKEN`; platform list and create are owner-only (non-owner 404); `outbound.all` is updated and restored; ten mutual suspensions with `Promise.all` each leave exactly one success and at least one active member; ten concurrent suspensions of multi@example.test in A and B leave no open session; omitted service-token expiry is about 90 days, and null, past and 366-day values are 400; two parallel revokes return 204 and 404 and the 404 is audited; malformed audit uuid filters are 400 and malformed path ids are 404 plus an audit event
- privileged MFA withholding (2): with `AUTH_REQUIRE_MFA_FOR_PRIVILEGED=true`, the owner without MFA gets an empty company list from `GET /api/me` while support.a still sees a company; the owner is 403 `mfa_required` on `/api/platform/companies`; support.a is given company admin during an open dev-login session and cannot use `member.manage` until an OIDC login with `amr: ['mfa']`

B-1 checks that were not repeated on this tree: the production refusal of `AUTH_DEV_LOGIN_ENABLED=true`, and `pnpm dev:worker`. Step A checks that were not repeated: `pnpm db:seed` on the dev database, compose `ps`, and the n8n HTTP check. The dev database was already seeded. The dev audit list for company A was empty because login events are not company-scoped. The integration tests assert the company audit rows.

## In progress

C-1, C-2a, the review-fix rounds, C-2b1, fix rounds 3 and 4, C-2b2, and fix rounds 5 and 6 are in the worktree and are not committed. The command log for this run is under "Fix round 6". The final Step C review has not been done.

## Mocked or blocked

| Capability | State | Blocked by |
|---|---|---|
| Staff login via Entra | OIDC code path is mock-tested with `oauth2-mock-server`. Not sandbox-tested or live-tested. Entra v2 `amr` / `acrs` is still to verify (U2). `mfa` is matched case-sensitively | U2 (tenant access) |
| Sessions, CSRF, dev login | implemented. Dev login is enabled for `APP_ENV=development`. The local cookie name is `bp_session` because `SESSION_COOKIE_SECURE=false`. Dev-login sessions have `mfa_satisfied=false` | — |
| Privileged-permission MFA withholding | applied while the request context is built, and again before `GET /api/me` uses the owner flag. Covered with the flag forced on. The development default remains off | U2 for the real claim shape |
| Company context and permission checks | implemented and integration-tested. Every `@RequirePermission` route is evaluated | — |
| Service identities | implemented. `POST /api/automation/v1/c/:companyId/store-connections/:connectionId/events` ingests mock store events with `store.events.ingest` | live store credentials (U3, U4) |
| Store sync | mock Shopify import through the inbox and `inbox.process`. API version on the fixtures is `unverified; check in Phase 2`. No live Shopify calls | U3, U4 |
| Printing | mock provider, submit, and `print.submit` / `print.refresh_status`. Mock-tested. Not sandbox-tested or live-tested | U6 |
| Invoice issuance | Draft create, edit, preview and on-demand PDF are implemented. There is no issue endpoint. Seed does not issue invoices | U1 (accountant validation) |
| Web UI | reserved project only | Step D |
| n8n workflows | export/import/sanitize scripts only. `workflows/n8n/exports` is empty | Step C |
| Worker job loop | `main.worker.ts` starts the loop. Each claim stores its own lease token. SIGTERM stops claiming, waits up to 25s, then finalises what is still running. Registered handlers include `inbox.process`, `print.submit` and `print.refresh_status`. The `pdf` handler is not registered | — |

## Known risks

- Angular 22 pins TypeScript 6.0.x. TypeScript 7 is not used.
- Prisma's npm `latest` tag is 8.0.0-rc.23. This repo pins 7.10.1. `prisma generate` prints an upgrade notice; do not follow it.
- The machine's default Node is 16. Always `nvm use` (`.nvmrc`).
- A later `prisma migrate dev` that changes the schema must be created with `--create-only` and reviewed. Custom partial indexes, RLS, grants and triggers live only in `20261018234900_rls`. `packages/db/prisma/manual/rls.sql` matches that migration. The B-1 migration only replaces the `print_job` queue foreign key and adds `job (company_id, id)` uniqueness. The B-2 migration only adds `user_identity.entra_oid`. `user_identity` stays RLS-exempt. B-3 did not change the schema. C-1 adds `20261020212057_service_identity_expires_at_not_null`, which is only `ALTER TABLE service_identity ALTER COLUMN expires_at SET NOT NULL`. It does not touch RLS, grants or triggers. The review pass adds `20261021011909_user_identity_one_entra`: a partial unique index `user_identity_one_entra_key` on `user_identity (user_id) WHERE provider = 'entra'`. Prisma cannot model that predicate, so it is not in `schema.prisma`. Fix round 4 adds `20261021115614_gift_message_template_one_default`: a partial unique index `gift_message_template_one_default_key` on `gift_message_template (company_id) WHERE is_default`. Prisma cannot model that predicate either, so it is not in `schema.prisma`. That migration does not touch RLS, grants or triggers. A later `migrate dev` must not drop either index.
- `gitleaks/gitleaks-action@v2` is in CI with `actions/checkout` `fetch-depth: 0`. It was not run locally. On a private repository the action can require a license. `pnpm audit --prod --audit-level high` is `continue-on-error` and was not run locally.
- Vitest 5 warns that `vitest.config.ts` is ESM loaded as CommonJS. The tests pass.
- pnpm 12 will not install dependency build scripts unless `allowBuilds` lists them. `@scarf/scarf` (pulled in by Swagger) is set to `false`. CI uses `pnpm install --frozen-lockfile` and needs that list.
- `pnpm dev:api` and `pnpm dev:worker` run under `tsx`, which does not emit `design:paramtypes`. Every Nest constructor parameter in `apps/api` needs an explicit `@Inject(...)`.
- Postgres applies the `audit_event` SELECT policy to `INSERT ... RETURNING`. A platform audit row is written only after `app.platform_scope=on` in that transaction. A denial that names a company sets `app.company_id` in the denial's own transaction.
- `GET /api/c/:companyId/orders` is filtered by store and by location. A location grant sees the stores at that location. A store or location outside the caller's grants is an audited 404 on the order and on a secondary permission. Other company lists are still company-wide.
- Service tokens are company-wide; per-connection binding is a Phase 2 hardening item.
- Local storage has no `openat`. `put` creates the parent, checks its real path, opens with `O_EXCL | O_NOFOLLOW`, then checks the descriptor against `lstat` and checks the parent again. `get` and `exists` open with `O_NOFOLLOW` and stream from that descriptor. An attacker who can already write inside `STORAGE_ROOT` is out of scope. The root must be owned by the app user with mode `0700`. Directories this code creates are mode `0700` and files are mode `0600`. An existing root is not chmod'd.

## Deviations

- pnpm 12 ignores the `pnpm` key in `package.json`. Build approval and the Nest peer exception live in `pnpm-workspace.yaml` (`allowBuilds`, `peerDependencyRules`). `@scarf/scarf` install scripts are not run.
- `@nx/nest@23.3.0` optionally peers Nest `<12`. Nest stays 12.1.3. The API project is built with `tsc`.
- `openid-client` 6.8.8 and devDependency `oauth2-mock-server` 9.3.0 are installed. nestjs-zod, Angular, PrimeNG, Playwright, pdfmake, `@nx/angular` and `@nx/vite` are not. They belong to C or D.
- `apps/web` is a `project.json` reservation (`type:app`, `web`). `packages/integrations` still exports a package-id constant. `packages/documents` renders invoice drafts as of C-1.
- `dev`, `dev:web` and `test:e2e` still exit 1. `dev:api`, `dev:worker` and `openapi:export` run.
- The plan's B1 sentence says the worker runs the job loop. The loop is Step C, so the worker only validates config, logs, and exits 0 on SIGTERM or SIGINT. A timer holds the event loop open because a signal listener alone does not.
- Throttle limits are optional env vars, defaulting to 300, 20 and 120 requests per 60 seconds for the default key, `/api/auth/*` and automation controllers. They are skipped when `APP_ENV=test` unless `THROTTLE_ENABLED_IN_TEST=true`. That flag is test-only and is not in `.env.example`. The auth matcher is the case-sensitive prefix `/api/auth`. The automation matcher is `@AutomationRoute()`, not a URL prefix.
- Swagger UI needs inline scripts. `/api/docs` and `/api/docs/*` in development and test allow `'unsafe-inline'` scripts and styles. Every other response uses `default-src 'none'`.
- `HOST` defaults to `127.0.0.1`. A container in Step E can set `0.0.0.0`. Values with whitespace, a slash or `://` are rejected.
- The `print_job (company_id, queue_job_id)` foreign key is `ON DELETE RESTRICT`. The old single-column foreign key was `ON DELETE SET NULL`. Setting the composite pair to null would also clear `company_id`. RESTRICT matches the other composite foreign keys.
- Express 5.2.1 does not ship types. `@types/express` 5.0.6 is a direct dev dependency.
- `moduleResolution` is `bundler` (emit stays CommonJS). TypeScript 6 deprecates `node`/`node10`, and that resolver cannot load `@bp/domain`'s `exports` entry.
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
- Compose commands pass `--env-file .env`. Interpolation does not see a repo-root `.env` when the compose file is in `infra/compose`.

## Deviations added in B-2

- `user_identity.entra_oid` was added. Step A stored Entra `tid` as `tenant_id` and did not store `oid`. The column is not named `oid` because that is a PostgreSQL type. Identities are still looked up by `(provider, issuer, subject)`.
- The invitation token is `GET /api/auth/oidc/start?redirect=&invitation=`. The plan's start URL showed only `redirect`. Only the SHA-256 hex of the token is stored.
- Invitation role JSON is `{ roleKey, scopeType, scopeId }`. Company scope uses a null `scopeId`. B-3 reuses this shape.
- `email` matches an invitation only when `email_verified` is exactly `true`. `preferred_username` matches without that flag. `amr` includes MFA only for the exact string `mfa`.
- Dev login and the OIDC start and callback routes are public, so they do not require the CSRF header. Logout does. The `XSRF-TOKEN` cookie is not HttpOnly, `SameSite=Strict`, `Path=/`, `Secure` follows `SESSION_COOKIE_SECURE`, and its max-age is the 7-day absolute session lifetime.
- Acceptance takes `SELECT … FROM company WHERE id = $1 FOR UPDATE`, re-reads the invitation, and re-checks the inviter's active membership, `member.invite`, and `canGrant` for each stored role. It does not apply the last-admin rule. A suspended or removed membership is not reactivated.
- `@Authenticated()` means a staff session and no company permission. A handler that declares a permission is never public. Boot fails when one handler resolves as both public and a permission.
- Session idle and absolute expiry use an injectable clock. `auth_flow` expiry uses database `now()`, so tests must not move that clock into the past during an OIDC flow.
- A callback whose browser binding does not match does not consume the flow. A bad nonce or token exchange consumes it, then fails.
- Protocol failures return 400 `Sign-in could not be completed`. An unprovisioned identity and an invitation email mismatch return 403 `account not provisioned`. The mismatch is distinguished by audit `details.reason` `invitation_email_mismatch`.
- Unknown and disabled dev-login emails both return 401 `Authentication failed`. The audit `reason` differs.
- Login revokes only the previous session cookie presented on that request. The stored session secret is the SHA-256 hex of the cookie string.
- A platform owner sees every company with `status = active` only when the MFA policy still treats the session as an owner. When privileged MFA is required and the session has no MFA, `GET /api/me` lists only that user's active memberships. The seed owner has none, so the list is empty. A member sees companies where their membership is `active`. `user.isPlatformOwner` on that response stays the account flag.
- `/api/auth/providers` is Step D and was not added.
- `allowInsecureRequests` is used only when `APP_ENV` is `development` or `test`, so the HTTP mock issuer can be discovered. Production discovery does not use it.

## Deviations added in B-3

- The company check is `CompanyAccessService`, called by `AuthorizationGuard` after authentication. It is not a second Nest guard named `CompanyContextGuard`. A second global guard would sit beside the existing deny-by-default guard.
- `@PlatformOwner()` is a route class, not a permission. The route self-check accepts it with `@Public()`, `@Authenticated()` and `@RequirePermission()`.
- `GET /api/c/:companyId/members/:membershipId` is extra. The acceptance test requests that URL, and a framework 404 would not write an audit event.
- `GET /api/c/:companyId/context` requires `company.view`. Seed staff who should open the company have it through BASE or their role. A platform owner with MFA satisfied receives every non-automation permission, company-wide, without a membership.
- Context returns every company switch with its `enabled` flag, including the ones that are off. The global `outbound.all` row is not in that list.
- Invitation TTL is 7 days. The plan does not set one.
- `mailbox` and `integration_account` assignments return 400 `scope_not_supported`. Those tables do not exist yet. A missing store or location is 404 `scope_not_found` and is audited.
- A non-owner on a platform route gets 404 `not_platform_owner`. An owner whose required MFA is missing gets 403 `mfa_required`. The plan does not choose the two statuses.
- Successful GET handlers are not written to `audit_event`. State changes and authorisation denials are. A read of the audit list does not append a row.
- The company administrator holds every ordinary permission, so "admin.a cannot create a token for an ordinary permission they lack" cannot be shown with admin.a. The negative case is a membership that holds `service_identity.manage` and `company.view` and not `order.view`. admin.a is tested creating `store.events.ingest`.
- An ordinary permission on a service identity must be held company-wide. The token is not store-scoped. Automation-only permissions are grantable by any holder of `service_identity.manage`.
- Removal does not revoke sessions. Suspension revokes them only when the user has no other active membership, counted after the company lock and then the user-row lock. `member.sessions.revoke` revokes all of that user's sessions.
- Invitation creation does not take the company row lock. Invitation acceptance (B-2) and membership role or status changes do.
- Automation routes authenticate only with `Authorization: Bearer bps_…`. A session cookie and no valid bearer token is 401 `automation_requires_bearer`, whether or not `X-XSRF-TOKEN` is present. Bearer tokens stay rejected on staff routes.
- `GET /api/automation/v1/c/:companyId/ping` is a test target. It returns `{ ok: true }` and does not ingest events.
- Self-suspension of the last `member.manage` holder is refused as `self_modification` (rule 2) before rule 4. Rule 4 is unit-tested. The integration test shows the platform owner can suspend that last holder, and that two admins suspending each other leave one active admin.

## Deviations added with the Step B review fixes

- `@bp/db` and `@bp/domain` publish `bp-source` before `default`. `packages/integrations` still exports `./src/index.ts` only. C-1 gives `packages/documents` the same `bp-source` / `types` / `default` shape, and the API imports it.
- Dev, test, seed and `openapi:export` pass `tsx --conditions=bp-source`. Vitest `resolve.conditions` is `bp-source`, `module`, `node`, and `development|production`. `tsconfig.base.json` sets `customConditions` to `bp-source`. Plain `node` uses `dist`.
- Nest's default shutdown hook re-raises SIGTERM, which a parent sees as a signal death. `enableShutdownHooks(undefined, { useProcessExit: true })` makes the HTTP process exit 0 after cleanup.
- Express copies case sensitivity when its router is created. Nest creates that router inside the adapter constructor, so `caseSensitiveAdapter()` sets the flag before `new ExpressAdapter`. Setting it later in `configureHttp` does not change routes already compiled. A path that misses the case-sensitive `/api` prefix is Express's HTML 404 (`Cannot GET /API/...`), not the JSON error body. A miss under `/api` still uses the JSON filter.
- `service_identity.expires_at` was left nullable in this review. C-1 reverses that. Migration `20261020212057_service_identity_expires_at_not_null` sets the column NOT NULL. The bearer check treats a missing expiry as expired. Dev and the test database had no null rows before the migration.
- The service-identity delete path parameter is `:id`, matching the OpenAPI name. The URL shape is unchanged.

## What C-1 added

Company routes, all through `TenantDb`, with money as decimal strings and totals from `calculateDocumentTotals`:

- `GET/POST /api/c/:companyId/clients`, `GET/PATCH /api/c/:companyId/clients/:id` (`client.view` / `client.manage`). Nested contacts and addresses. `expectedVersion` mismatch is 409. Archive replaces delete. Display names, notes and addresses are stored as sent.
- `POST /api/c/:companyId/clients/duplicate-check` (`client.manage`). Matches normalised name, email or VAT inside the company only.
- `GET /api/c/:companyId/tax-codes` (`catalog.view`). `GET/POST /api/c/:companyId/products`, `PATCH /api/c/:companyId/products/:id` (`catalog.view` / `catalog.manage`).
- `POST /api/c/:companyId/invoices/preview-totals` and `POST` / `PATCH /api/c/:companyId/invoices/:id` (`invoice.draft`). Drafts only. The server loads tax rates, snapshots them onto the lines, and stores the totals and `invoice_tax_summary`. Client totals are ignored. Language is the client default, then the company default. Omitted due date is the issue date, or today's business date in the company timezone, plus the client or company payment terms. Explicit null stays null.
- `GET /api/c/:companyId/invoices` and `GET /api/c/:companyId/invoices/:id` (`invoice.view`). Filters: status, client, issue-date range, text.
- `GET /api/c/:companyId/invoices/:id/pdf` (`invoice.view`). `packages/documents` renders with pdfmake and Noto Sans (OFL, `packages/documents/assets/fonts/OFL.txt`). Labels follow the document language. Seller from the company, client from the client, lines, tax summary, totals, and the diagonal draft watermark. Drafts are rendered on demand and not stored. Headers: `Content-Disposition: inline; filename="draft-<id>.pdf"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- `CredentialVault` in `apps/api/src/vault`. AES-256-GCM, AAD `companyId|provider|credentialId`. No route calls it. `service_identity.expires_at` is NOT NULL and a missing expiry fails closed.

There is no issue endpoint, and C3–C6 are not stubbed.

### Commands verified locally (2026-10-21, Step C-1)

Node 24.22.0 via nvm. Dev Postgres was already running and seeded. pdfmake 0.3.12 and pdfjs-dist 6.4.299 (tests only). TypeScript stayed 6.0.x and Prisma stayed 7.10.1.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. domain 39, n8n-workflows 25, api 43, tools 7. 114 tests |
| `pnpm build` | pass. 5 tasks. `api` depends on `db`, `domain` and `documents` |
| `node tools/smoke-dist.mjs` | pass. Loads the three package dists, renders a 25260-byte draft PDF from `@bp/documents` dist, `GET /api/health/ready` returned 200, the worker logged `worker ready`, and both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 75 tests on `business_platform_test`: db 13, api 62. Verbose list below |
| `pnpm openapi:export` | pass. Client, catalogue and invoice operations are in `docs/api/openapi.json` |
| `pnpm dev:api` as `admin.a@example.test` | Draft for seeded Demo Gifts Ltd (fictional), STD19 and RED5. Totals: subtotal 25.00, net 25.00, tax 4.05 (RED5 0.25, STD19 3.80), total 29.05, due 2026-03-31. PDF saved under `var/` (gitignored): PDF 1.3, A4, pdfmake, 22591 bytes, the three response headers above. The server was then stopped. `node apps/api/dist/main.js` served that same PDF (22591 bytes, `%PDF-`) and was stopped |

Integration tests, verbose:

- db row level security (13): unchanged from Step B
- authorisation and tenancy (18) and privileged MFA withholding (2): unchanged from Step B
- clients, catalogue and invoice drafts (4): create, edit, archive, duplicate-check and a concurrent version conflict; tax codes and products, including a JSON number rejected with 400; E1–E9 through the API, fake totals ignored, preview stores nothing, Greek and English draft PDFs extracted with pdfjs-dist; admin.b gets 404 on company A's client, product, invoice, PDF and tax code, lists stay inside the company, fulfil.a gets 403 on the invoice list and one invoice, support.a gets 403 on client create. Each denial asserts the status and the audit event, and the mutations carry a correlation id
- authentication (25), HTTP API (10), auth rate limit (1): unchanged from Step B
- credential vault (2): round trip, tampered ciphertext fails, the other company cannot decrypt, rotation from k1 to k2, plaintext absent from the logger spy and from audit details

The dev PDF was not committed. `var/` is gitignored.

## Next step

After C-1 this was C-2. C-2a and C-2b1 have since landed; what remains is under "Left for C-2b2". The original C-2b scope was packing slips and gift-message documents, storage, printing endpoints and handlers (`print.submit` concurrency 2, `pdf` concurrency 2), and the switches API. Do not stub them. Outbound actions must read the switches at execution time. New Nest providers need `@Inject`. Platform audit writes set `app.platform_scope`. A denial that names a company sets `app.company_id`.

## Deviations added in C-1

- `GET /tax-codes` requires `catalog.view`, not `tax.manage`. The plan names `tax.manage` and defines no tax-code write. Assigning a code is part of `catalog.manage`, and ops.a has that without `tax.manage`. Everyone with `tax.manage` also has `catalog.view`.
- `CredentialVault.encrypt` takes `{ companyId, provider, label, plaintext, createdById }` because `integration_credential.created_by` is NOT NULL. `decrypt(companyId, id)` takes the company so RLS and the AAD both apply. `rotate(companyId, id)` re-seals under the active master key. The plan's signatures are `encrypt(companyId, provider, label, plaintext)` and `decrypt(id)`.
- The stored tax summary is one row per tax code. That is how `calculateDocumentTotals` groups. The plan says "per rate". Two codes that share a rate stay separate, matching worked example E12.
- Create accepts `documentType` `quote` or `invoice`. `credit_note` stays out of this phase.
- Products have no `version` column, so `PATCH /products/:id` has no `expectedVersion`. There is no `GET /products/:id`. The plan's `GET/POST/PATCH /products` is the list, create and patch. Isolation for a product id uses the patch.
- `POST /clients/duplicate-check` requires `client.manage`. Successful GETs are not audited, as in Step B. A version conflict is audited as outcome `failure` on `client.update` or `invoice.update` with reason `version_conflict`. A missing company object is `authorization.denied` and 404.
- The draft PDF draws the required sentence as pdfmake's diagonal watermark and again as a horizontal line, so `pdfjs-dist` extracts the Greek when the rotated drawing is split into glyphs. Both strings are the plan sentence, including the en dashes.
- Vite 8 externalises workspace packages, so Node would load `packages/documents/dist` during tests. The API Vitest configs alias `@bp/documents` to its TypeScript source. `tools/smoke-dist.mjs` loads the built package and renders a PDF from it.
- The invoice PDF is rendered after the tenant transaction commits. The draft bytes are not stored.

## What C-2a added

Job runner (`apps/api/src/automation/jobs/job-runner.ts`), started from `main.worker.ts`. The HTTP process does not start the loop. Claim uses `FOR UPDATE SKIP LOCKED` under `pg_advisory_xact_lock`. Lease is 60s, heartbeat 20s. `inbox.process` concurrency is 4 and the handler is retryable. The lease token, completion fence and shutdown behaviour in the next sentences were replaced by "C-2a review fixes". Handlers run inside `TenantDb` with the job's company. `drainOnce()` runs the due queue for tests and `pnpm demo:import-fixtures`.

Mock Shopify import:

- `packages/integrations/src/shopify`: `mapShopifyOrder`, the status map, and the six fixtures under `packages/integrations/shopify/fixtures`, including the Greek gift message and the `unverified; check in Phase 2` marker.
- `POST /api/automation/v1/c/:companyId/store-connections/:connectionId/events` (`@AutomationRoute()`, `store.events.ingest`). The inbox row and the `inbox.process` job commit in one transaction. A duplicate event id increments `duplicate_count` and returns 202 `{ inboxId, status: 'duplicate' }`.
- `inbox.process` takes the per-object advisory lock, inserts with `ON CONFLICT DO NOTHING`, then re-reads under a row lock. Updates require a strictly newer `source_updated_at`. Stale events leave the order untouched. Source fields only. Create-time `review_required` reasons are `unknown_payment`, `unknown_delivery`, `unsupported_glyphs` and `cancelled_at_source`. A later event cannot drop `cancelled_at_source`. A gift-message change after a submitted gift print sets `review_required` on a non-terminal order. Terminal orders keep `fulfilment_status` and append `attention_reasons`. Duplicate, stale and failed inbox outcomes are audited in the same transaction as the inbox write.
- `pnpm demo:import-fixtures --company A|B` stores the service token in `var/demo-service-identities.json` (mode 0600) and does not print it.

Orders API, company routes, money as decimal strings:

- `GET /api/c/:companyId/orders` (`order.view`, `orderListScope`). Filters `q`, `fulfilmentStatus`, `paymentStatus`, `storeId`, `assigned`, `from`, `to`. Sort allowlist, page, pageSize max 100.
- `GET /api/c/:companyId/orders/:id` (`order.view`). Exact gift message, `allowedTransitions` for this user, latest print job per document type (all null until C-2b).
- `POST /api/c/:companyId/orders/:id/transitions` (`order.transition`; cancel also needs `order.cancel`). Domain state machine. 409 on version conflict, 422 on an illegal move.
- `POST .../notes` (`order.edit`). Body stored exactly. Does not bump `version`.
- `POST .../assign` (`order.assign`, or `order.claim` for assigning yourself). Someone else, or clearing the assignee, needs `order.assign`. Both are checked against the order's store and location.
- `GET .../activity` (`order.view`). Import, transitions and notes, newest first.

Seed already contains fictional Nutbox Demo PrestaShop. No second store was added. The isolation test inserts one order on that connection.

### Commands verified locally (2026-10-21, Step C-2a)

Node 24.22.0 via nvm. Dev Postgres was already running and seeded. fontkit 2.0.4. pdfmake stayed 0.3.12, pdfjs-dist 6.4.299 (tests only). TypeScript stayed 6.0.x and Prisma stayed 7.10.1. No new migration.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks (`--skip-nx-cache`) |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. documents 1, tools 7, domain 39, integrations 5, n8n-workflows 25, api 47. 124 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Four dists loaded, draft PDF 25260 bytes, Shopify order mapped, `GET /api/health/ready` 200, worker logged `job loop started` and `worker ready`, SIGTERM, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 90 tests on `business_platform_test`: db 13, api 77. Verbose list below |
| `pnpm openapi:export` | pass. Order routes and the automation events route are in `docs/api/openapi.json` |
| `pnpm dev:api`, then `pnpm demo:import-fixtures --company A` then `--company B`, then both again | pass. First A: accepted 5, duplicate 0, processed 5, orders 0 → 3 (`#1001` v2 new paid, `#1002` v1 new pending, `#1003` v1 review_required paid `unsupported_glyphs`). First B: accepted 1, processed 1, orders 0 → 1 (`#2001` v1 new paid). Second A: accepted 0, duplicate 5, processed 0, orders 3 → 3. Second B: duplicate 1, orders 1 → 1. Token file mode 0600. The token was not printed. The API was then stopped |
| `pnpm dev:api` as `fulfil.a@example.test` | `GET /orders` returned 3, all `Nutbox Demo Shopify`: `#1003`, `#1002`, `#1001`. `#1001` moved new → preparing (v3) → ready (v4), both HTTP 200 |

Integration tests, verbose. Prior files are unchanged in count: db row level security (13), authorisation and tenancy (18), privileged MFA withholding (2), clients, catalogue and invoice drafts (4), authentication (25), credential vault (2), HTTP API (10), auth rate limit (1).

- job runner (5): concurrent claims never share a job; a non-retryable expired lease becomes `uncertain` without a second attempt; a retryable expired lease is requeued with backoff; a retryable handler error backs off; SIGTERM releases the lease
- orders import and API (10): one import, a duplicate, and the gift message bytes; a newer update and a stale one; company, store and service-identity isolation, including fulfil.a 404 on the PrestaShop order and 403 on `/invoices`; filters, sort and page; paid new → preparing → ready, unsettled ready 422, stale version 409; two concurrent transitions and one winner; note, claim, assign and activity; create/T2/T3 in every arrival order; enqueue failure rolls the inbox back; terminal orders keep their status and append attention reasons. Each denial asserts the HTTP status and the audit event

Import and the orders API are integration-tested against Postgres. The demo and the fulfil.a transition were exercised on the seeded dev database through the real API. Shopify itself was not called.

## Deviations added in C-2a

- `GET /orders` uses a scope resolver (`orderListScope`) so a store-scoped caller is not rejected before the list filter. A caller with no `order.view` gets 403. A `storeId` outside the caller's grants returns an empty page. Detail, notes, transitions, assign and activity use `orderResourceScope`: a missing id or a store outside the grants is 404 `out_of_scope`.
- `POST /orders/:id/assign` was first guarded only by `order.claim`. C-2a review fixes accept `order.assign` or `order.claim` on the same scopes. Assigning someone else, or clearing the assignee, still needs `order.assign`. An assignee who cannot `order.view` that store and location is 422 `assignee_not_allowed`.
- `inbox.process` jobs set `max_attempts` to 5. Attempts increment on claim. Reclaim does not increment again. SIGTERM behaviour is in "C-2a review fixes": an unstarted claim restores the attempt, a started retryable job keeps the attempt and backs off, and a started non-retryable job becomes `uncertain`.
- Due checks and the live-lease count used `clock_timestamp()`. Retry, heartbeat and release still used the host clock, and `drainOnce` stopped after three 15ms retries. The review pass moved every scheduling write onto the database clock. See "Review fixes after C-2a".
- `print.submit` and `pdf` are not registered. Their concurrency of 2 is applied when C-2b registers those handlers. `inbox.process` is 4.
- HTTP 409 keeps Nest's `error.code` `conflict`. The audit reason is `version_conflict`. HTTP 422 `error.code` is the domain code (`transition_not_allowed`, `terminal_status`, `payment_not_settled`, `delivery_method_not_allowed`, `assignee_not_allowed`).
- `new → ready` is `transition_not_allowed`. `payment_not_settled` applies to `preparing → ready` when payment is not settled.
- The first import of an order with `cancelledAt` now sets `review_required` and `cancelled_at_source`, including when the cancellation is processed before the create. A gift-message change after print is still applied on a later event.
- Unsupported glyphs are detected in `packages/documents` with fontkit 2.0.4 and Noto Sans. Whitespace is skipped. Gift-message and packing-slip rendering stay in C-2b.
- Store-sourced order totals are the Shopify `shopMoney.amount` strings parsed through `packages/domain/money`. `calculateDocumentTotals` is for invoices.
- The demo reads the mock Shopify connection id with `TenantDb`, because there is no store-connection list route. `pnpm demo:import-fixtures` passes `--tsconfig apps/api/tsconfig.json` so tsx enables Nest parameter decorators when the script is started from the repo root.
- Express 5's query parser is set to `extended`, so repeated `fulfilmentStatus[]` values arrive as an array.
- API Vitest aliases `@bp/db` to `packages/db/src/index.ts` and does not externalise it. Vite otherwise loads the workspace package through Node. A `packages/db/dist` from before `Prisma` was re-exported left `Prisma.sql` undefined under Vitest. The alias keeps the tests on the TypeScript source. `tools/smoke-dist.mjs` loads `packages/db/dist`, which now re-exports `Prisma`.
- `packages/documents` and `packages/integrations` lint `src` only, matching domain and api. Their `vitest.config.ts` files sit outside `rootDir`.
- Advisory locks go through `$executeRaw`. `pg_advisory_xact_lock` returns void, and `$queryRaw` cannot deserialise that column.
- `InboxService.hooks.afterInboxInsert` and `InboxProcessor.hooks` are test seams around enqueue and the per-object lock. Production leaves them null.
- The update fixtures change the shipping-address phone. The order-level phone stays `+35799001009`. The import test compares `recipient.phone`.

## Review fixes after C-2a

This run does not start C-2b. It fixes the Step B re-review, the C-1 review, and the planner's C-2a findings. `service_identity.expires_at` was already `NOT NULL` (`20261020212057_service_identity_expires_at_not_null`) and a missing expiry is `service_token_expired`. That was confirmed and not changed. No route or schema changed, so `pnpm openapi:export` was not run.

Migration `20261021011909_user_identity_one_entra` was created with `prisma migrate dev --create-only`. Prisma emitted a non-unique index on `user_id`. That SQL was replaced, before it was applied, with:

```sql
CREATE UNIQUE INDEX "user_identity_one_entra_key"
  ON "user_identity" ("user_id")
  WHERE "provider" = 'entra';
```

It does not drop RLS, grants or triggers. `prisma migrate deploy` applied it to the dev database `business_platform`. `pnpm db:reset:test` applied it to `business_platform_test`.

### P-1, the fresh-database flake

After a reset, `clock_timestamp()` was 52 ms ahead of the host. Claim's due check already used `clock_timestamp()`. Heartbeat, retry backoff, lease release and `reclaimExpired` wrote `run_after` and `locked_until` from the host clock, and inbox enqueue used SQL `now()`. `drainOnce` then stopped after three 15 ms retries (45 ms), which is shorter than that skew, so a job scheduled from the host could still be in the future on the database clock and become claimable in the next test. That matches the observed counts: the T3 test drained 0, and the next two tests drained the leftover jobs. `reclaimExpired` also selected every running job and marked an unregistered type `uncertain`.

The runner now takes `run_after`, `locked_until` and backoff from `clock_timestamp()` and `make_interval`, including the inbox insert. Claim counts running jobs and then selects one due id under the advisory lock, instead of combining that count with `SKIP LOCKED` in one updatable CTE. `drainOnce` waits 15 ms when a registered job is already due, otherwise up to 300 ms when one is due within 300 ms, at most eight waits. Reclaim is limited to registered handler types. The orders file deletes that company's `inbox.process` jobs in `beforeEach`, so a missed drain cannot change the next assertion. The original 0-then-late failure was not reproduced after the fix. The T3 test drained 3 on the fresh database, and all six full-suite runs below passed.

### Commands verified locally (2026-10-21, review fixes)

Node 24.22.0 via nvm. Dev Postgres was already running. No new dependency. TypeScript stayed 6.0.x and Prisma stayed 7.10.1.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. domain 40, tools 7, integrations 5, documents 1, n8n-workflows 27, api 51. 131 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Four dists loaded, draft PDF 25399 bytes, Shopify order mapped, `GET /api/health/ready` 200, worker logged `job loop started`, SIGTERM, both processes exited 0 |
| `pnpm test:integration` three times, no reset | pass. Each run: db 13, api 84, 97 tests |
| `pnpm db:reset:test`, then `pnpm test:integration` three times | pass. Each run: db 13, api 84, 97 tests |

Integration files, verbose, from the first run after the reset. Prior files grew by the tests named in the findings: authorisation and tenancy is 19 (adds the suspend/login deadlock), clients, catalogue and invoice drafts is 6 (adds currency precision and the foreign contact/address 404), authentication is 27 (adds the concurrent Entra link and the owner invitation), job runner is 7 (adds the 80 ms drain and the database-clock backoff). Unchanged counts: db row level security 13, privileged MFA withholding 2, orders import and API 10, credential vault 2, HTTP API 10, auth rate limit 1.

## Deviations added with the review fixes

- The partial unique index is not in `schema.prisma`. Prisma's `--create-only` SQL was a plain index on `user_id`. It was replaced with the partial unique index before apply. A later `migrate dev` must not drop `user_identity_one_entra_key`.
- The userinfo check is case-insensitive, so `HTTPS://user:secret@host` is rejected as well as `https://`.
- Before the bearer and high-entropy scans, exact `$env` / `$credentials` references are removed and `:` and `/` become spaces. The existing entropy pattern treats `/` as a token character, so `https://graph.microsoft.com/v1.0/me/messages` would otherwise fail.
- Invitation acceptance treats an active platform owner as holding `platformOwnerGrants()` without a membership. It does not apply the MFA withholding policy. There is no session on that check.
- Login, rotation, logout and session revoke lock `user_account` with `FOR NO KEY UPDATE` before writing `user_session`. Suspension still uses `FOR UPDATE` after the company lock.
- OIDC tests that attach an Entra identity to a seeded user delete that user's existing Entra row first. The non-MFA half of the OIDC login test uses a new user, because `admin.a` already holds the MFA identity and the new index allows only one Entra row per user.
- `@bp/domain` was not aliased in the API Vitest config, so a stale `packages/domain/dist` made invoice create return 500. C-2a review fixes alias `@bp/db`, `@bp/domain`, `@bp/documents` and `@bp/integrations` to source in both API Vitest configs, and alias `@bp/domain` in the integrations Vitest config. `tools/smoke-dist.mjs` still loads the built packages.

## C-2a review fixes

This run does not start C-2b. No migration and no new dependency. `pnpm openapi:export` rewrote the assign summary in `docs/api/openapi.json`.

Each claim stores `locked_by` as `<workerId>:<uuidv7>`. Heartbeats, completion, failure, backoff and release match that token and `status = 'running'`. The handler's `TenantDb` transaction is limited to the job's `timeout_ms` and commits only after `UPDATE … SET status = 'succeeded' WHERE id AND locked_by AND status = 'running' AND locked_until > clock_timestamp()`. Zero rows throws `LeaseLost` and the business writes roll back. A heartbeat that updates 0 rows, or that keeps failing until the lease is past, aborts the handler. `run_after`, `locked_until`, backoff and `finished_at` use `clock_timestamp()` and `make_interval`. SIGTERM stops new claims and waits up to `shutdownGraceMs` (default 25s, a field on the runner). After that, a started non-retryable job is `uncertain` and audited, a started retryable job is released with backoff and keeps its attempt, a started retryable job that has used `max_attempts` is `failed` and audited, and a claim whose handler never started is released with the attempt restored. Claims skip `attempts >= max_attempts`. An expired lease that another worker reclaims is still `uncertain` when the handler is non-retryable or the attempt count is already at the cap, and queued with backoff otherwise. `drainOnce` keeps going while a registered job is due or becomes due within 300ms, until `drainDeadlineMs` (default 5s).

Service tokens stay company-wide. Per-connection binding is listed under Known risks and was not implemented.

### Commands verified locally (2026-10-21, C-2a review fixes)

Node 24.22.0 via nvm. Dev Postgres was already running. TypeScript stayed 6.0.x and Prisma stayed 7.10.1.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks, including a second run after the integrations Vitest alias |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. domain 40, tools 7, integrations 5, documents 1, n8n-workflows 27, api 52. 132 tests |
| `pnpm build` | pass. 5 tasks. Repeated after the dists were removed for P-4 |
| `node tools/smoke-dist.mjs` | pass, before and after the final build. Four dists loaded, draft PDF 25399 bytes, Shopify order mapped, `GET /api/health/ready` 200, worker logged `job loop started`, SIGTERM, both processes exited 0 |
| `pnpm openapi:export` | pass. Assign summary now states `order.assign` or `order.claim` |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 111 tests on `business_platform_test`: db 13, api 98. Verbose list below |
| P-3, 10 consecutive `pnpm test:integration` | pass. Every run: db 13, api 98, 111 tests. Runs 1–3 followed one reset. Runs 7, 8 and 10 each followed their own reset. Run 9 followed the P-4 dist removal |
| P-4, `rm -rf packages/*/dist`, then `pnpm test --skip-nx-cache` and `pnpm test:integration` | pass. Unit 132 (the first `pnpm test` was an Nx cache hit and was re-run). Integration run 9: db 13, api 98 |

Integration files, verbose, from the first run after `pnpm db:reset:test`. Unchanged counts: db row level security 13, authorisation and tenancy 19, privileged MFA withholding 2, clients, catalogue and invoice drafts 6, authentication 27, credential vault 2, HTTP API 10, auth rate limit 1.

- job runner (15): concurrent claims never share a job; a non-retryable expired lease becomes `uncertain` without a second attempt; a retryable expired lease is requeued with backoff; a retryable handler error backs off; the first handler's writes roll back when a second worker reclaims the lease; an old attempt cannot complete a newer claim by the same worker; SIGTERM after the grace period marks a started non-retryable job `uncertain`, backs off a started retryable job, and restores an unstarted attempt; SIGTERM during attempt 5 of 5 does not produce attempt 6; three database-due jobs and one 80ms ahead of the database clock are drained; backoff uses the database clock; a 1s backoff does not run when the host clock is 2s behind; a handler that resolves after a 5ms timeout is retried when retryable and `uncertain` when not
- orders import and API (16): one import, a duplicate audit, and the gift message bytes; a newer update and a stale audit; company, store and service-identity isolation; filters, sort and page; paid new → preparing → ready, unsettled ready 422, stale version 409; two concurrent transitions and one winner; note, claim, assign and activity; create/T2/T3 in every arrival order; cancellation and create in either order keep `cancelled_at_source`; a failed import is audited; enqueue failure rolls the inbox back; terminal orders keep their status and append attention reasons; date filters outside 2000-01-01 to 2999-12-31 are 400; `order.assign` without `order.claim` can assign, clear and self-assign; a secondary permission outside the store is 404; a location-scoped fulfil user lists and transitions that location and gets 404 for another location. Each denial asserts the HTTP status and the audit event

## Deviations added with the C-2a review fixes

- `shutdownGraceMs` is a field on `JobRunner`, default 25s. It is not an environment variable. Tests set the field. No `.env.example` change.
- `packages/integrations/vitest.config.ts` also aliases `@bp/domain` to source. `pnpm test` runs that package, and Vite would otherwise resolve the missing dist. The finding named the two API configs; this is the same rule applied where the unit suite imports `@bp/domain`.
- Reclaim of an expired lease is unchanged: non-retryable, or already at `max_attempts`, becomes `uncertain` with `lease_expired` and is not audited as `job.failed`. The shutdown path is the one that marks an exhausted retryable job `failed`.
- When a heartbeat query fails and the follow-up read of the lease also fails, the runner compares `Date.now()` with the last `locked_until` it observed. That is only the database-down fallback. Scheduling writes stay on `clock_timestamp()`.

## What C-2b1 added

Documents, local storage, and the company switches API. Printing endpoints, print providers, and `print.*` handlers are left for C-2b2.

`packages/integrations/src/storage`: `StorageAdapter` (`put`, `get`, `exists`) and `LocalFsStorage`. Keys are server-generated: `companies/<companyId>/<kind>/<yyyy>/<mm>/<uuid>.pdf`. A key that would leave the root throws `StoragePathError`, including `..`, absolute paths, encoded separators, and a symlink inside the root that points outside. `STORAGE_ROOT` is optional and defaults to `var/storage` (resolved from the process directory). It is in `.env.example`. `pnpm setup:env` appended it to the existing `.env` and left the other values as they were.

`packages/documents`: `renderPackingSlip(order, company, lang)` is A4, with the order number, store, recipient, delivery method, items and quantities, and a gift-message flag. It has no prices. `renderGiftMessage(text, template)` uses the template page size in millimetres, steps the font from `font_size_pt` down to `min_font_size_pt` by 0.5 pt, and returns `{ pdf, fits, unsupportedChars }`. The text is drawn with its line breaks and spaces. The fontkit glyph check from C-2a reports unsupported characters. pdfkit 0.20.2 is a direct dependency of `@bp/documents` (the same version pdfmake already uses).

Staff routes, all under `/api/c/:companyId`:

- `GET /orders/:id/documents/packing-slip.pdf` and `GET /orders/:id/documents/gift-message.pdf?templateId=` (`document.download`, `orderResourceScope`). Rendered after the tenant read and not stored. `Content-Type: application/pdf`, `Content-Disposition: inline`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. A missing gift message is 404 `gift_message_missing`. A `templateId` that is not a uuid is 400.
- `GET /gift-message-templates` and `PATCH /gift-message-templates/:id` (`company.manage`). Measurements are decimal strings. A JSON number is 400. Setting `isDefault` clears the other default in the same transaction. The change is audited as `gift_message_template.updated`.
- `GET /files/:id`. The row is read under RLS first, then the bytes are streamed from storage. The client never sends a storage key. `invoice_pdf` requires `invoice.view` at company scope. A packing slip or gift message whose source is an order requires `document.download` on that order's store and location. `test_print` requires `document.download` at company scope, so fulfil.a (store-scoped `document.download`) receives 404 `out_of_scope` and a company admin receives 200.
- `GET /automation/switches` (`automation.view`) and `PUT /automation/switches/:key` (`automation.manage`). `reason` is required. A missing reason is 400 and is not audited. A successful change is audited as `automation_switch.updated` with the previous value, even when the value does not change. A company admin may change `printing`, `email.send`, `store.write`, `marketing.send`, `social.publish`, `shipment.book`, and `invoice.issue_real`. `outbound.all` stays on `PUT /api/platform/switches/outbound.all`. A company PUT of `outbound.all` or any other unknown key is 404 `switch_not_in_company` and is audited. Another company's URL is 404 `not_a_member`.
- `GET /automation/jobs?status=` (`automation.view`). The payload is omitted. `status` is `queued`, `running`, `succeeded`, `failed`, `held`, `uncertain`, or `cancelled`. Anything else is 400. `pageSize` defaults to 50 and is at most 100.

These switch and job routes are staff routes. They are not `@AutomationRoute()`.

### Commands verified locally (2026-10-21, C-2b1)

Node 24.22.0 via nvm. Dev Postgres was already running and seeded, with the company A fixtures already imported. pdfkit 0.20.2, pdfmake 0.3.12, fontkit 2.0.4, pdfjs-dist 6.4.299 (API tests only). TypeScript stayed 6.0.x and Prisma stayed 7.10.1. No new migration.

| Command | Result |
|---|---|
| `node tools/setup-env.mjs` | pass. Added 1 missing key (`STORAGE_ROOT`) to `.env` and left existing values unchanged |
| `pnpm install` | pass. Lockfile already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. domain 40, tools 7, integrations 8, documents 7, n8n-workflows 27, api 58. 147 tests. Counts are from `nx run-many -t test --skip-nx-cache` |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Four dists loaded. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7873 bytes at 148 × 105 mm, Shopify order mapped, `GET /api/health/ready` 200, worker logged `job loop started`, SIGTERM, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 116 tests on `business_platform_test`: db 13, api 103 |
| `pnpm test:integration` twice more, no reset | pass. Each run: db 13, api 103, 116 tests |
| `pnpm openapi:export` | pass. Packing slip, gift message, templates, files, switches and jobs are in `docs/api/openapi.json` |
| `pnpm dev:api` as `fulfil.a@example.test` | `#1001` packing slip 20673 bytes, `application/pdf`, `Cache-Control: no-store`, one page, order number, recipient, items and gift flag, none of the order prices. Gift message 7873 bytes, one page, 419.528 × 297.638 pt (148 × 105 mm), and the pdfjs text equals the stored Greek message, including the blank line and the trailing space. The API was then stopped |

Integration files, verbose, from the run after `pnpm db:reset:test`. Unchanged counts: db row level security 13, authorisation and tenancy 19, privileged MFA withholding 2, orders import and API 16, clients, catalogue and invoice drafts 6 (the invoice PDF assertion is still in this file), authentication 27, job runner 15, credential vault 2, HTTP API 10, auth rate limit 1.

- documents, files and company switches (5): fulfil.a downloads the packing slip and the gift message for an in-scope order (page size 148 × 105 mm, extracted text equals the stored Greek message, the slip has the order number, recipient, items and gift flag, and none of the prices); a bad `templateId` is 400 with no audit; fulfil.a gets 404 `out_of_scope` on the PrestaShop order's documents; a missing gift message is 404 `gift_message_missing`; admin.b gets 404 `not_a_member` on company A's documents, files, template patch, switches and jobs, and 404 `out_of_scope` or `template_not_found` when A's ids are used under company B; company B's template and job lists omit A's rows, and toggling A's `printing` leaves B's `printing` false; `GET /files/:id` for A's file under company B is 404 and the body is not the stored bytes; fulfil.a can download an in-scope packing-slip file, gets 403 `permission_missing` on an invoice PDF, and 404 `out_of_scope` on a test print; a template rename is audited and restored; a JSON number is 400; a switch PUT without `reason` is 400 and is not audited; `outbound.all` is 404 `switch_not_in_company`; fulfil.a gets 403 on the template patch and the switch PUT; `printing` and `email.send` changes are audited and restored, and company A `printing` ends enabled. Each denial asserts the HTTP status and the audit event

The 600-character message and the emoji `unsupportedChars` check are unit-tested in `packages/documents` and `apps/api/src/documents/render.test.ts`. Storage traversal (`..`, absolute keys, encoded separators, and a symlink that points outside the root) is unit-tested in `packages/integrations`. The invoice PDF path from C-1 still passes in the commerce integration file and in `tools/smoke-dist.mjs`.

## Left after C-2b2

Step D is the Angular app. Invoice issuance still has no issue endpoint. Shopify and printing are mock providers. The `pdf` queue handler is not registered: rendering happens on `POST /print-requests`. See "C-2b2".

## Deviations added in C-2b1

- Gift-message cards are drawn with pdfkit. pdfmake's text path drops empty lines, so a blank line in the stored message would not be drawn. pdfkit 0.20.2 was already the pdfmake dependency; it is now also a direct dependency of `@bp/documents`. Invoices and packing slips still use pdfmake.
- C-2b1 mapped one hidden U+0000 glyph to the whole gift message and every visible glyph to U+200B so that pdfjs extraction equalled the stored string. Fix round 3 removed that map. pdfkit's own ToUnicode stays in place. See "Fix round 3".
- `GET /files/:id` declares `document.download` with `anyOf: ['invoice.view']`, and the scope resolver sets `ResolvedResource.permission` from the file kind after the RLS read. Checking both permissions against one scope set would treat fulfil.a's invoice file as out of scope (404) because they hold `document.download` on a store. The kind-specific permission makes that invoice file 403 `permission_missing`.
- Gift-message template PATCH has no `expectedVersion`. `gift_message_template` has no version column. Fix round 4 adds the one-default partial unique index and serialises template writes per company. It still does not add a version column.
- Preview PDFs are not written to `stored_file`. `GET /files/:id` streams a row that already exists. A storage miss after the row was found was 404 and was not audited. Fix round 4 maps `ENOENT`, `ELOOP` and `ENOTDIR` from resolve, open and the stream to an audited 404. The body and the logs do not include the path.
- The company jobs list omits `payload`. `automation_switch` and `job` stay RLS-exempt, so company isolation for those two lists is the `companyId` filter plus the company URL. `stored_file` and `gift_message_template` go through `TenantDb`.
- `test_print` files are company-scoped `document.download`. fulfil.a receives 404 `out_of_scope` for one. A company admin, who holds `document.download` company-wide, receives 200.

## Fix round 3

Review of fix rounds 1 and 2. No migration, no route change, and `docs/api/openapi.json` was not regenerated. C-2b2 was not started.

The n8n sanitiser parses every `{{ … }}` span, and a whole `=…` value that n8n treats as code, with acorn 8.19.0 (the current npm version, pinned exactly as a devDependency of `@bp/n8n-workflows`). Sensitive object keys and assignments must be exactly a member expression on `$env` or `$credentials`. A computed key that is not static fails closed when its value contains a string. Bearer, basic, and high-entropy checks run on string literals and template quasis, not on identifiers. URL userinfo is checked after each `{{ … }}` span is replaced with `x`. `workflows/n8n/exports` still contains only `.gitkeep`, so there is no exported workflow JSON. The sanitiser test walks that tree and accepts every JSON file that has a `nodes` array. The unit fixtures are what pass today.

Account locks that do not change account keys use `FOR NO KEY UPDATE`: invitation acceptance, suspension, login (including replacement of the previous session), logout, and `member.sessions.revoke`. Company row locks stay `FOR UPDATE`. Session replacement is the previous-cookie path inside login.

The job claim returns `clock_timestamp() + timeout_ms`. Completion and failure updates also require `clock_timestamp() < deadline`, and the abort signal is checked again after that update, before the transaction callback returns. A missed deadline throws `LeaseLost` and the job stays `running` until the existing lease reclaim. Tracking maps are keyed by the claim token. Claim uses `pg_try_advisory_xact_lock`. The runner's own claim, reclaim, settlement, and requeue transactions set a local 5s `statement_timeout` and `lock_timeout`. `stop()` has an overall deadline of `shutdownGraceMs + 10s` and logs claims it could not settle. When a heartbeat renewal and the ownership read both fail, the handler is aborted once `leaseMs - heartbeatMs` has elapsed since the last successful renewal, measured with `performance.now()`. The claim records that timestamp as the lease start.

Cancel checks `order.cancel`, and assigning someone else checks `order.assign`, before the version and the transition. A location-scoped list asserts `total` against the returned page, and a user outside that location cannot be assigned (`422 assignee_not_allowed`).

`layoutGiftMessage` returns the lines and the font size that `renderGiftMessage` draws. pdfkit embeds each glyph as its own character and keeps its own ToUnicode map. Each drawn line is also marked with pdfkit's `markContent('Span', { actual })`, which writes `/ActualText`.

### Commands verified locally (2026-10-21, fix round 3)

Node 24.22.0 via nvm. Dev Postgres was already running. acorn 8.19.0. pdfkit 0.20.2, pdfmake 0.3.12, fontkit 2.0.4, pdfjs-dist 6.4.299 (tests only). TypeScript stayed 6.0.x and Prisma stayed 7.10.1. No new migration.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test --skip-nx-cache` | pass. domain 40, tools 7, integrations 8, documents 8, n8n-workflows 30, api 59. 152 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Four dists loaded. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7973 bytes, Shopify order mapped, `GET /api/health/ready` 200, worker logged `job loop started`, SIGTERM, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 121 tests on `business_platform_test`: db 13, api 108. Verbose list below |
| `pnpm test:integration` five times, runs 1 and 4 each immediately after `pnpm db:reset:test` | pass. Every run: db 13, api 108, 121 tests |
| `pnpm --filter @bp/n8n-workflows test` | pass. 30 tests. No exported workflow JSON under `workflows/n8n` |

Integration files, verbose, from the first run after `pnpm db:reset:test`. Counts that grew: authentication 28 (adds reciprocal invitation acceptance), job runner 19 (adds the deadline fence, the same-worker stop, the blocked claim lock, and the heartbeat budget). The secondary-scope and location-scope cases were added inside the existing orders tests, so orders stays 16. Unchanged counts: db row level security 13, authorisation and tenancy 19, privileged MFA withholding 2, clients, catalogue and invoice drafts 6, documents, files and company switches 5, credential vault 2, HTTP API 10, auth rate limit 1.

- db row level security (13): unchanged from Step B
- authorisation and tenancy (19): unchanged, including the mutual-suspension, two-company suspension, and suspend-plus-login deadlock tests
- privileged MFA withholding (2), clients, catalogue and invoice drafts (6), credential vault (2), HTTP API (10), auth rate limit (1): unchanged
- documents, files and company switches (5): the gift-message assertion is now per-line visible glyphs and a blank-line gap, as in "Deviations added in fix round 3"
- job runner (19): the previous 15, plus a fence that sleeps past the database deadline and leaves the job `running`, a same-worker reclaim whose second attempt is released with the attempt restored when `stop()` runs before it starts, `stop()` returning while another session holds the claim advisory lock, and a stubbed heartbeat that aborts from the monotonic budget
- orders import and API (16): the secondary-scope test now covers a stale `expectedVersion` and an invalid cancellation, both audited 404s, and the location-scope test asserts `total` and refuses an assignee from another location
- authentication (28): the previous 27, plus ten concurrent reciprocal invitation acceptances, all of which succeed

## Deviations added in fix round 3

- Plan item 4 ("text extraction equals the stored message, line breaks included") is checked as layout exactness plus per-line visible-glyph extraction. `layoutGiftMessage` returns lines equal to `text.split('\n')` for the short fixtures, including blank lines and trailing spaces. An overlong line's wrapped segments concatenate to the original line and stay within the template content width. pdfjs, with `verbosity` set to infos, groups glyphs by y. Those lines equal the stored lines with whitespace removed, in order. A blank line is a vertical gap of at least one line box. pdfjs emits no ToUnicode or CMap warning. PDF extractors do not preserve whitespace reliably, so the stored spaces are proven by the layout, not by the extracted string.
- Poppler `pdftotext` 26.03.0 is installed. On the rendered Greek card its stderr is empty (no ToUnicode, bfrange, or CMap warning) and the extracted characters are the stored Greek, not zero-width spaces. `pdftotext -layout` does not return those lines in source order. The acceptance order is the pdfjs y grouping.
- Gift wrapping keeps a 2pt inset inside the content box so a glyph does not clip the margin. The layout test's upper bound is the content box.
- `/ActualText` is optional metadata on each drawn line, through pdfkit `markContent`. It is not a custom CMap.
- A completion fence that misses its database deadline leaves the job `running`. Reclaim handles the expired lease. The regression asserts the status is not `succeeded`.
- `workflows/*` is a pnpm workspace glob so `@bp/n8n-workflows` can depend on acorn. The package was already an Nx project.

## Fix round 4

Review of C-2b1. C-2b2 was not started. Migration `20261021115614_gift_message_template_one_default` was created with `prisma migrate dev --create-only` and the generated non-unique index was replaced with `CREATE UNIQUE INDEX gift_message_template_one_default_key ON gift_message_template (company_id) WHERE is_default`. The SQL does not drop RLS, grants, triggers, or `user_identity_one_entra_key`. It is applied on the dev database and on `business_platform_test`.

`LocalFsStorage.put` creates each parent segment (mode `0700`), treats `EEXIST` as success only after `lstat` shows a real directory whose real path is still under the root, then opens the file with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` (mode `0600`). After the open it requires the descriptor and `lstat` to share `dev`/`ino`, and the parent real path to still be under the root. A mismatch closes the descriptor, unlinks the created inode when that unlink still names it, and throws `StoragePathError`. `get` and `exists` open with `O_RDONLY | O_NOFOLLOW`, run the same check, and `get` streams from the descriptor. A final-component symlink and an existing key are refused. `DocumentService.hooks.beforeTemplateSave` and `CompanyAutomationService.hooks.beforeSwitchWrite` are null in production. Tests set them.

`GET /files/:id` maps a missing, looping, or non-directory storage path to `CommerceError` 404 `not_found`, which is audited. The public error and a mid-stream failure do not carry the filesystem path. File kinds are explicit: `invoice_pdf` uses `invoice.view`, `packing_slip` and `gift_message` use `document.download` on the source order's store and location, and `test_print` uses company-scoped `document.download`. Any other kind, including the string `invoice`, and a packing slip or gift message with no resolvable order, is `found: false` (audited 404 `out_of_scope`).

Gift-message font candidates start at the exact max, step down by 0.5 pt inside the interval, and end at the exact min. Fit height is ascent + |descent| + (lines − 1) × lineHeight × fontSize. The drawing advance is the same baseline spacing, `lineHeight × fontSize`, so a block that fits stays on one page. Template measurements are checked against `numeric(6,2)` or `numeric(6,3)` and the ranges in the finding (page 20–500 mm, margins ≥ 0 and strictly below half the page, fonts 4–72 pt with min ≤ max, line height 0.8–3). A miss is 400 `invalid_measurement` or, when min exceeds max, `min_font_above_font`. Template writes take `pg_advisory_xact_lock` on `gift_message_template:<companyId>` before the read, clear other defaults in that transaction when `isDefault` is set, and update only the fields the request supplied. Company switch changes `SELECT … FOR UPDATE` the `(company_id, key)` row and `updateMany` includes `companyId`.

### Commands verified locally (2026-10-21, fix round 4)

Node 24.22.0 via nvm. Dev Postgres was already running. pdfkit 0.20.2, pdfmake 0.3.12, fontkit 2.0.4, pdfjs-dist 6.4.299 (tests only). TypeScript stayed 6.0.x and Prisma stayed 7.10.1.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test --skip-nx-cache` | pass. domain 40, tools 7, integrations 12, documents 10, n8n-workflows 30, api 62. 161 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Four dists loaded. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7970 bytes, Shopify order mapped, `GET /api/health/ready` 200, worker logged `job loop started`, SIGTERM, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 126 tests on `business_platform_test`: db 13, api 113. Verbose list below |
| `pnpm test:integration` twice more | pass. Each run: db 13, api 113, 126 tests |
| `pnpm openapi:export` | pass. `GET /files/{id}` summary names `invoice_pdf`, the order-scoped documents, and company-scoped `test_print` |

Integration files, verbose, from the run immediately after `pnpm db:reset:test`. The documents file grew from 5 to 10. Every other file kept the fix-round-3 count. Total 126 = db 13 + api 113.

- db row level security (13): unchanged from Step B
- authorisation and tenancy (19): unchanged
- privileged MFA withholding (2), clients, catalogue and invoice drafts (6), credential vault (2), HTTP API (10), auth rate limit (1): unchanged
- orders import and API (16): unchanged
- authentication (28): unchanged
- job runner (19): unchanged
- documents, files and company switches (10): the previous 5, plus an audited 404 when the stored bytes are deleted and the path is absent from the body and the logs; a packing slip with no source and a gift message whose order does not exist are each 404 `out_of_scope` with an audit event; template measurements outside the column and the allowed range are 400 and are not audited, and the inclusive boundaries are accepted; two concurrent default switches leave exactly one default; concurrent enable and disable of `shipment.book` produce audits whose before/after values chain

The integration log prints Node's pg deprecation, `Calling client.query() when the client is already executing a query`, during the orders and commerce files. The suite still passed. It was not traced with `--trace-deprecation`. C-2b2 serialises `client.query` on each pooled connection. The three integration runs after that change print no such warning.

## Deviations added in fix round 4

- The stored invoice kind is `invoice_pdf`. The string `invoice` is an unknown kind and returns `found: false`. There is no alias.
- Template mutations use `pg_advisory_xact_lock(hashtextextended('gift_message_template:' || companyId, 0))` rather than `SELECT … FROM company FOR NO KEY UPDATE`, so a template write does not block membership updates. The partial unique index is the backstop. It is not declared in `schema.prisma`.
- The old sum-of-margins check is gone. Each margin must be ≥ 0 and strictly less than half of its page axis. `min_font_above_font` remains when min exceeds max. Other bound failures are `invalid_measurement`. A 400 is not audited.
- Fontkit's descent is negative. The fit height uses `|descent|`. The drawing advance is `lineHeight × fontSize`, the same spacing the fit height uses between baselines. Leaving the old glyph-box advance in place made a 600-character message report `fits` and still occupy two pages.
- `platform.service.ts` `setOutboundAll` still updates `automation_switch` by `id` only. The preceding read is `companyId: null`. That update was not changed. Job-runner queries on `job` still match `id`, status, and `locked_by`, with no `company_id` predicate. Company lists and the inbox insert do include `companyId`.
- `LocalFsStorage` exposes `beforeOpen` for the parent-swap test. `DocumentService` and `CompanyAutomationService` expose the same kind of hook InboxService already uses. All three are unset in production.

## C-2b2

Mock printing. No new migration. Printing and Shopify are mock-tested. Neither has been sandbox-tested or live-tested. `provider` is `mock`, and API responses include `simulationLabel` "Simulated — no physical printing". `done_reported` stays that status. Its label is "Sent to printer (provider reported done — not confirmed)".

`packages/integrations/src/printing` has `PrintProvider` and `MockPrintProvider`. Online printers write the PDF. Offline printers throw `PrinterOffline`. The flaky printer throws `ProviderTimeout`. The next status read moves `submitted` to `done`, and the worker maps `done` to `done_reported`. Output is `<MOCK_PRINT_ROOT>/<companyId>/<printJobId>.pdf` plus a sidecar state file. A relative `MOCK_PRINT_ROOT` resolves from the repository root (`pnpm-workspace.yaml`). The default is `var/mock-print-output`, which `.gitignore` `var/` covers. `STORAGE_ROOT` stays process-cwd relative, as in C-2b1.

`POST /print-requests` renders now, stores the file, records `source_version`, and inserts the `print_job` and the `print.submit` queue job in one transaction. A duplicate first print is 409 `already_printed` with `printJobId`. A gift message with `fits=false` or non-empty `unsupportedChars` is 422 `gift_message_needs_review`. Copies are 1–5. Paper size comes from the mapping, or from the chosen printer when `printerId` is sent, and must be one of that printer's sizes. `print.reprint` needs a reason of at least 5 characters.

`print.submit` is an external handler (concurrency 2, not retryable, 30s). The runner does not wrap it in one transaction. The handler: (a) re-checks `outbound.all` and company `printing`, re-validates the requester and, for a released job, the releaser, then claims `queued → submitting` and audits, committing only while the queue lease is still held; (b) calls the provider outside any transaction; (c) records `submitted`, `failed`, or `uncertain` and audits it in a new transaction. A provider outcome is kept even when the queue-job fence at (c) fails. Step (c) does not change a print job that reclaim has already set to `uncertain`. `print.refresh_status` is also external (concurrency 2, retryable). The `pdf` handler is not registered.

If reclaim, shutdown, or timeout finds a `print.submit` job whose print row is still `queued`, the attempt is restored and the queue job is requeued, because the provider was not called. If the print row is `submitting`, both rows become `uncertain` in the same transaction and the print job does not return to `queued`. The comment at the top of `job-runner.ts` records the external-handler shutdown, timeout, and lease rules.

`POST /print-jobs/:id/confirm`, `/release`, and `/cancel`. Cancel is one conditional update from `queued`, `held`, or `uncertain`, and returns 409 once the job is `submitting` or later. `GET /print-jobs`, `GET /print-jobs/:id`, `GET /printers`, `POST /printers/discover`, `PUT /printer-mappings`. Order detail fills the latest print job per document type. Activity includes print-job audits.

Prisma 7 issues relation queries concurrently on one interactive-transaction client, and `@prisma/adapter-pg` then calls `client.query` while a query is in flight. `createPrismaClient` serialises `query` per pooled connection. Pipeline mode is not used. `PrismaPg` is constructed with `disposeExternalPool: true`.

### Commands verified locally (2026-10-21, C-2b2)

Node 24.22.0 via nvm. Dev Postgres was already running and seeded. pdfkit 0.20.2, pdfmake 0.3.12, fontkit 2.0.4, pdfjs-dist 6.4.299 (API tests only). TypeScript stayed 6.0.x and Prisma stayed 7.10.1. No new migration. `node tools/setup-env.mjs` added `MOCK_PRINT_ROOT` to `.env` and left existing values unchanged.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. domain 40, tools 7, integrations 14, documents 10, n8n-workflows 30, api 63. 164 tests. Counts are from `nx run-many -t test --skip-nx-cache` |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7970 bytes, Shopify order mapped, one `MockPrintProvider.submit` wrote 18209 bytes into a temp directory, `GET /api/health/ready` 200, worker logged `job loop started`, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 138 tests on `business_platform_test`: db 13, api 125. No `client.query` deprecation warning. The first attempt failed 5 orders tests because leftover queued `print.submit` jobs were drained by the orders file (`drain()` expected 1 and got 2). The printing file now cancels queued print jobs in `afterAll`. The reset run after that fix passed |
| `pnpm test:integration` twice more, no reset | pass. Each run: db 13, api 125, 138 tests. No `client.query` deprecation warning |
| `pnpm openapi:export` | pass. Print requests, print jobs, confirm, release, cancel, printers, discover, and printer mappings are in `docs/api/openapi.json` |
| `pnpm dev:api` and `pnpm dev:worker`, then curl as `fulfil.a@example.test` | `#1001` packing slip 20673 bytes and gift message 7970 bytes, both `application/pdf`, `Cache-Control: no-store`. Gift print to `mock-laserjet-online` reached `done_reported` with label "Sent to printer (provider reported done — not confirmed)" and `simulationLabel` "Simulated — no physical printing". `var/mock-print-output/<companyId>/<printJobId>.pdf` is 7970 bytes, mode `0600`, and `git check-ignore` matches `.gitignore` `var/`. A second first print is 409 `already_printed` with that job id. Both processes were stopped |

`src/config/env.test.ts` was run again after relative `MOCK_PRINT_ROOT` was pointed at the repository root: 8 passed. That change is after the `pnpm test` row above. It does not add a test.

Integration files, verbose, from the run after `pnpm db:reset:test`. The new file is printing (12). Every other file kept the fix-round-4 count. Total 138 = db 13 + api 125.

- db row level security (13): unchanged from Step B
- authorisation and tenancy (19): unchanged
- privileged MFA withholding (2), clients, catalogue and invoice drafts (6), credential vault (2), HTTP API (10), auth rate limit (1): unchanged
- orders import and API (16): unchanged. The invoice PDF assertion is still in the commerce file
- authentication (28): unchanged
- job runner (19): unchanged
- documents, files and company switches (10): unchanged. The gift-message check is still the fix-round-3 layout plus per-line visible glyphs. The 600-character message and the emoji `unsupportedChars` check stay in `packages/documents` and `apps/api/src/documents/render.test.ts`
- printing with the mock provider (12): one gift print reaches `done_reported` and a second first print is 409 `already_printed`; ten concurrent first prints create one job; a reprint without `print.reprint` is 403 and an audited denial, and a reprint with a reason of at least 5 characters is accepted; an offline printer fails once and a timeout stays `uncertain` with one submit and no requeue; a switch turned off after queueing ends `held` with no provider call, and release after it is enabled prints; company B's jobs go to `held` because printing is off; a phone-only import bump still hits the first-print index; a suspended requester is `requester_no_longer_authorised` with no provider call; 25 cancel races, plus an early cancel and a blocked claim, never both return 200 and call the provider; killing the lease during the provider call submits once and leaves the print `uncertain`; an emoji gift message is 422 `gift_message_needs_review`; admin.b with A's ids gets 404 on documents, files, templates, print requests, print jobs, printers, mappings, switches, and jobs, and the lists omit A's rows

The orders activity test still shows import, transitions, and notes. The printing file and the dev `#1001` activity also show `print_job.requested`. On the dev order the activity, newest first, included `print_job.requested` (the 409 is `failure`), `print_job.done_reported`, `print_job.submitted`, `print_job.submitting`, `print_job.confirmed`, `order.transition`, `order.source_updated`, and `order.imported`. That order had no note.

## Deviations added in C-2b2

- The `pdf` queue handler is not registered. `POST /print-requests` renders in the request. The plan's `pdf` concurrency of 2 has no handler.
- `GET /print-jobs/:id` is added so a client can poll one job. The plan lists the collection GET.
- The mock provider's state is `submitted` or `done`. The print job status `done_reported` is the worker's mapping of `done`. The provider does not store the string `done_reported`.
- A `print.submit` queue job whose print row is still `queued` when the lease expires, or when shutdown or timeout runs before the claim commits, is requeued and the attempt is restored. The plan's generic rule sends a non-retryable expired lease to `uncertain`. The provider has not been called, so returning the print to `queued` would be a second chance, and marking it `uncertain` would strand a job that never left the queue. Once the row is `submitting`, reclaim sets the print job and the queue job to `uncertain` and does not return the print to `queued`.
- Step (c) updates the print job only while its status is still `submitting`. If reclaim already wrote `uncertain`, that status stays. `provider_job_id` may still be attached when it is null.
- `print.refresh_status` uses the external handler mode as well, so a status read is not held inside the runner's single transaction.
- Relative `MOCK_PRINT_ROOT` resolves from the repository root. `STORAGE_ROOT` still resolves from `process.cwd()`. `pnpm dev:api` therefore writes stored files under `apps/api/var/storage` and mock print PDFs under the repository `var/mock-print-output`.
- Gift-message PDF acceptance stays the fix-round-3 reading: layout exactness plus per-line visible glyphs. The printing tests do not re-parse the 600-character card.
- The dev curl's first gift print, before the root fix, wrote its PDF under `apps/api/var/mock-print-output` because the process cwd was `apps/api`. That job was confirmed `not_printed` so the restarted API could print again. The print that the check records is the one under the repository `var/mock-print-output`.

## Risks

- An external handler is raced against the abort signal and the claim deadline. When `print.submit` has already claimed `submitting`, that timeout settles `uncertain` and does not retry. The handler keeps running so a late provider result is recorded and audited. The mock does not cancel an in-flight submit. Reclaim still covers a dead worker. See "Fix round 6".
- There is no physical printer and no PrintNode client. Discover upserts the three mock printers.
- Shopify import is still the mock mapper. Invoice drafts still cannot be issued.

## Fix round 5

Review of fix rounds 3 and 4. C-2b2 was left as it is, apart from the queue-job completion fence below. No migration, no route change, and `docs/api/openapi.json` was not regenerated. No new dependency.

The sanitiser blocks literal secrets in workflow parameters, including inside n8n and JavaScript expressions, and fails closed on expressions it can't parse. Deliberately obfuscated secrets (for example, computing a key or value through function calls) are out of scope. Credentials must live in n8n's credential store; reviewers check exported workflow diffs. The same paragraph is the header comment in `workflows/n8n/scripts/sanitize.mjs`.

Success and failure completion (`completeSucceeded`, `completeFailed`) and the external queue finish (`finishQueue`) lock the owned `running` row with `SELECT … FOR UPDATE` that does not mention the clock. A second statement then requires `clock_timestamp() < deadline AND locked_until > clock_timestamp()`. Zero rows, or a passed deadline, is the same lost lease as before. A transaction that only holds `FOR UPDATE` past the deadline can no longer let the waiting update succeed.

A parameter that mixes literal text with `{{ … }}` spans is checked after each span is replaced by `__n8n_expr__` inside a JSON string and by `x` elsewhere. That surface gets the JSON walk, the sensitive-key check, URL query and userinfo checks, and bearer, basic and entropy checks. Every decoded string literal gets the URL and JSON checks. A template literal is rebuilt from its quasis, with `x` for each `${…}`, and that string gets the URL userinfo and query checks. A computed key or computed member is a static name only when it is a string or numeric literal, or a template with no expressions. Any other computed key is unresolved, and an unresolved key whose value contains a string fails closed. Span ends are the `}}` candidates tried from the last backwards; the first body that parses is the span. A body that does not parse is rejected with `unparseable expression; cannot verify it is secret-free`. There is no permissive fallback. `workflows/n8n/exports` still contains only `.gitkeep`.

Gift-message block height uses the same `lineOrigin` the drawer advances by. The first line's top is the drawing origin. The last line's bottom is its baseline plus `|descent|`. Width still keeps the 2 pt inset. `\r\n` and a lone `\r` are one hard break while laying out and drawing. The stored string is not rewritten. `actuals` join back to that string, and pdfkit writes them as ActualText.

`LocalFsStorage` closes the descriptor when verification throws after `open`, and when the read stream ends or errors. A relative `STORAGE_ROOT` resolves from the repository root through the same helper as `MOCK_PRINT_ROOT`. The generated `apps/api/var` tree (stored PDFs and a mock-print sidecar from the old process-cwd resolution) was removed. `.env.example` states the new rule. No new environment variable.

### Commands verified locally (2026-10-21, fix round 5)

Node 24.22.0 via nvm. Dev Postgres was already running and seeded. No new migration. `pnpm test` used the Nx cache and did not print counts. The uncached re-run below is the count.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. Counts from `nx run-many -t test --skip-nx-cache`: domain 40, tools 7, integrations 16, documents 12, n8n-workflows 37, api 63. 175 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7979 bytes, Shopify order mapped, one `MockPrintProvider.submit` wrote 18209 bytes, `GET /api/health/ready` 200, worker logged `job loop started`, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 139 tests on `business_platform_test`: db 13, api 126. No `client.query` deprecation warning |
| `pnpm test:integration` twice more, no reset | pass. Each run: db 13, api 126, 139 tests. No `client.query` deprecation warning |

The gift-message smoke PDF is 7979 bytes. The C-2b2 run recorded 7970. ActualText now carries the original break bytes. The visible-glyph checks in `apps/api/src/documents/render.test.ts` still pass (6 tests).

Integration files, verbose, from the run immediately after `pnpm db:reset:test`. The job-runner file grew from 19 to 20. Every other file kept the C-2b2 count. Total 139 = db 13 + api 126.

- db row level security (13): unchanged from Step B
- authorisation and tenancy (19) and privileged MFA withholding (2): unchanged
- clients, catalogue and invoice drafts (6), credential vault (2), HTTP API (10), auth rate limit (1): unchanged
- orders import and API (16): unchanged
- authentication (28): unchanged
- job runner (20): the previous 19, plus a row lock held past the database deadline does not leave the job `succeeded`
- documents, files and company switches (10): unchanged
- printing with the mock provider (12): unchanged

## Deviations added in fix round 5

- One existing sanitiser fixture, `={{ { \`token\`: \`secret\` } }}`, is not valid JavaScript. A template literal is not a property name unless the key is computed. That fixture relied on the permissive fallback, which rejected it because the word `token` is sensitive. With the fallback gone it fails closed as `unparseable expression; cannot verify it is secret-free`. The computed form `={{ { [\`token\`]: \`secret\` } }}` still rejects as a possible secret. No exported workflow JSON depends on the fallback.
- The 2 pt inset still applies to width. It no longer applies to height. The block bottom is the baseline plus `|descent|` (21.792 pt for 16 pt Noto Sans). That fits the 22.677 pt content height of a 20 mm page with 6 mm margins. Subtracting 2 pt from the height made the same message report `fits=false`.
- `finishQueue` uses the same lock-then-clock helper, so an external queue job cannot be marked finished after its deadline either. `lockOwnedJob` still evaluates the clock inside `SELECT … FOR UPDATE`. The external path then calls `deadlineOpen` as a separate statement and rolls the transaction back when the deadline has passed. That lock was not rewritten.
- `apps/api/var` was deleted. It held only generated storage and mock-print files from the old cwd-relative `STORAGE_ROOT`.

## Left after fix round 5

The C-2b2 review is still open and is a later run. Step D (the web app) has not been started. Invoice issuance still has no issue endpoint. Shopify and printing are mock providers. The `pdf` queue handler is still not registered.

## Fix round 6

Review of C-2b2 printing. No migration, no new dependency, no new environment variable, and `docs/api/openapi.json` was not regenerated. The controller decorators did not change. A `printed` confirmation of a job that never reached the provider is 422 `confirm_not_allowed` through the existing error body, and that failure is audited as `print_job.confirmed`.

Invariant: for one `print_job`, the provider is called at most once, and never after a cancel has succeeded. Every provider outcome that arrives is recorded and audited, including one that arrives after reclaim or cancel.

Lock order, in every transaction that locks both rows: `print_job` first, then `job`. That is the claim, recording, reclaim, timeout settlement, cancel and release. Confirm locks only `print_job`. `uncertain` is written only from `submitting` (`WHERE status = 'submitting'`).

The PDF bytes are read before the fenced `submitting` claim. Immediately before `provider.submit`, the worker checks that the abort signal is still clear and that the print is `submitting`, the queue job is `running` under this lease token, and `locked_until` is more than 10 seconds ahead. A failed check does not call the provider. The abort signal is passed into `submit`. `runExternal` races the handler against the signal and the claim deadline. A timeout after `submitting` was claimed settles `uncertain` with no retry, and the handler continues so a late result can be stored. A late success on a row that is still `uncertain` writes `provider_job_id` and the audit and leaves the status for a person to reconcile. A cancellation or a manual confirmation is not overwritten. Only an error thrown by `provider.submit` is a provider outcome. If the provider returned and the database write fails, that write is retried up to three times. If it still fails, the provider job id and the error are logged and the row is left for reclaim. The provider is not called again.

`listScope` and `allowedLocations` take location ids only from location grants. A store grant does not add that store's location. Orders still expand a location grant to the stores at that location (`visibleStoreIds`). Documents and files match each resource's own store or location through `can()`. They do not copy a store's location into a list filter.

`serializeClientQueries` serialises only `query(text | config[, values])` with no callback, and only when the first argument is not a Submittable (an object with a `submit` function). Other overloads are returned unchanged. `packages/db` has a `test` target for that unit test. `test-integration` still excludes it.

Test hooks on `PrintProcessor` (`afterClaim`, `beforeRecord`, `duringRecord`) are null in production.

### Commands verified locally (2026-10-21, fix round 6)

Node 24.22.0 via nvm. Dev Postgres was already running and seeded. No new migration. `pnpm test` used the Nx cache for 4 of 7 tasks and did not print counts. The uncached re-run below is the count. Lint, typecheck and build were 5 tasks each.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. Counts from `nx run-many -t test --skip-nx-cache`: domain 40, tools 7, integrations 16, documents 12, n8n-workflows 37, api 63, db 4. 179 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7979 bytes, Shopify order mapped, one `MockPrintProvider.submit` wrote 18209 bytes, `GET /api/health/ready` 200, worker logged `job loop started`, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 144 tests on `business_platform_test`: db 13, api 131. No `client.query` deprecation warning |
| `pnpm test:integration` twice more, no reset | pass. Each run: db 13, api 131, 144 tests. No `client.query` deprecation warning |

Integration files, verbose, from the run immediately after `pnpm db:reset:test`. Printing grew from 12 to 17. Every other file kept the fix-round-5 count. Total 144 = db 13 + api 131.

- db row level security (13): unchanged from Step B
- authorisation and tenancy (19) and privileged MFA withholding (2): unchanged
- clients, catalogue and invoice drafts (6), credential vault (2), HTTP API (10), auth rate limit (1): unchanged
- orders import and API (16): unchanged
- authentication (28): unchanged
- job runner (20): unchanged
- documents, files and company switches (10): unchanged
- printing with the mock provider (17): the previous 12, plus a stall between the claim and submit sees reclaim and cancel and then zero provider calls; a Shopify-only grant does not see a PrestaShop print job at the same location, through the list or `?sourceId=`; a `beforeSubmit` that never resolves ends `uncertain` inside the timeout plus a margin, with one submit, and the late id is stored and audited; cancel overlaps late-result recording 25 times with no deadlock; the first recording transaction fails once and the retry still stores the result. The suspended-requester job cannot be confirmed `printed` (422 `confirm_not_allowed`, status stays `failed`, failure audited). The lease-killed submit stays `uncertain`, keeps `providerJobId`, and audits `print_job.submitted` with that id.

## Deviations added in fix round 6

- Confirm locks only `print_job`. The lock order is for a transaction that locks both rows. Confirm does not lock `job`, so it cannot take them in the other order.
- The external wait uses the host clock against the deadline instant stored at claim (`clock_timestamp() + timeout_ms`), and the existing abort timer. Status changes still use `clock_timestamp()`.
- Orders, documents and files did not have the store-grant-widens-to-location list expansion. Orders expand a location grant to stores at that location, which is the order list rule. That was left as it is. Printer listing in `allowedLocations` did copy store locations and was stopped with the print-job list.

## Left after fix round 6

The final Step C review has not been done. Step D (the web app) has not been started. Invoice issuance still has no issue endpoint. Shopify and printing are mock providers. The `pdf` queue handler is still not registered.

