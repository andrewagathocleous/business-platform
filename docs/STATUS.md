# Implementation status

Last updated: 2026-10-20 (Phase 1 Step B review fixes, uncommitted on `develop`).

Test levels:

- **unit**: domain logic in isolation.
- **integration**: real Postgres as `bp_app`, plus HTTP tests that boot the Nest app against that database.
- **e2e**: browser.
- **mock-tested**: against a mock provider.
- **sandbox-tested**: against the provider's official test environment.
- **live-tested**: against a real account.

## Current phase

Phase 1 step A is commit `ca7d578`. Step B (B-1 API skeleton, B-2 staff authentication, B-3 authorisation and tenancy) is in the worktree and is not committed. The planner and reviewer findings on that tree are fixed in the same worktree. Step C is next.

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

Nothing in Step B. The worktree is uncommitted.

## Mocked or blocked

| Capability | State | Blocked by |
|---|---|---|
| Staff login via Entra | OIDC code path is mock-tested with `oauth2-mock-server`. Not sandbox-tested or live-tested. Entra v2 `amr` / `acrs` is still to verify (U2). `mfa` is matched case-sensitively | U2 (tenant access) |
| Sessions, CSRF, dev login | implemented. Dev login is enabled for `APP_ENV=development`. The local cookie name is `bp_session` because `SESSION_COOKIE_SECURE=false`. Dev-login sessions have `mfa_satisfied=false` | — |
| Privileged-permission MFA withholding | applied while the request context is built, and again before `GET /api/me` uses the owner flag. Covered with the flag forced on. The development default remains off | U2 for the real claim shape |
| Company context and permission checks | implemented and integration-tested. Every `@RequirePermission` route is evaluated | — |
| Service identities | implemented for `/api/automation/v1`. The ping route does not ingest store events | Step C |
| Store sync | schema and mock connection rows only. No import | U3, U4 |
| Printing | mock printer rows only. No provider | U6 |
| Invoice issuance | schema, series and immutability trigger only. Seed does not issue invoices | U1 (accountant validation) |
| Web UI | reserved project only | Step D |
| n8n workflows | export/import/sanitize scripts only. `workflows/n8n/exports` is empty | Step C |
| Worker job loop | process boots and shuts down. No queue polling | Step C |

## Known risks

- Angular 22 pins TypeScript 6.0.x. TypeScript 7 is not used.
- Prisma's npm `latest` tag is 8.0.0-rc.23. This repo pins 7.10.1. `prisma generate` prints an upgrade notice; do not follow it.
- The machine's default Node is 16. Always `nvm use` (`.nvmrc`).
- A later `prisma migrate dev` that changes the schema must be created with `--create-only` and reviewed. Custom partial indexes, RLS, grants and triggers live only in `20261018234900_rls`. `packages/db/prisma/manual/rls.sql` matches that migration. The B-1 migration only replaces the `print_job` queue foreign key and adds `job (company_id, id)` uniqueness. The B-2 migration only adds `user_identity.entra_oid`. `user_identity` stays RLS-exempt. B-3 did not change the schema.
- `gitleaks/gitleaks-action@v2` is in CI with `actions/checkout` `fetch-depth: 0`. It was not run locally. On a private repository the action can require a license. `pnpm audit --prod --audit-level high` is `continue-on-error` and was not run locally.
- Vitest 5 warns that `vitest.config.ts` is ESM loaded as CommonJS. The tests pass.
- pnpm 12 will not install dependency build scripts unless `allowBuilds` lists them. `@scarf/scarf` (pulled in by Swagger) is set to `false`. CI uses `pnpm install --frozen-lockfile` and needs that list.
- `pnpm dev:api` and `pnpm dev:worker` run under `tsx`, which does not emit `design:paramtypes`. Every Nest constructor parameter in `apps/api` needs an explicit `@Inject(...)`.
- Postgres applies the `audit_event` SELECT policy to `INSERT ... RETURNING`. A platform audit row is written only after `app.platform_scope=on` in that transaction. A denial that names a company sets `app.company_id` in the denial's own transaction.
- There is still no store-scoped list endpoint. Step C should call `permittedScopeFilter` rather than reimplementing scope rules.

## Deviations

- pnpm 12 ignores the `pnpm` key in `package.json`. Build approval and the Nest peer exception live in `pnpm-workspace.yaml` (`allowBuilds`, `peerDependencyRules`). `@scarf/scarf` install scripts are not run.
- `@nx/nest@23.3.0` optionally peers Nest `<12`. Nest stays 12.1.3. The API project is built with `tsc`.
- `openid-client` 6.8.8 and devDependency `oauth2-mock-server` 9.3.0 are installed. nestjs-zod, Angular, PrimeNG, Playwright, pdfmake, `@nx/angular` and `@nx/vite` are not. They belong to C or D.
- `apps/web` is a `project.json` reservation (`type:app`, `web`). `packages/documents` and `packages/integrations` export a package-id constant until Step C.
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

- `@bp/db` and `@bp/domain` publish `bp-source` before `default`. `packages/documents` and `packages/integrations` still export `./src/index.ts`. The API does not import them.
- Dev, test, seed and `openapi:export` pass `tsx --conditions=bp-source`. Vitest `resolve.conditions` is `bp-source`, `module`, `node`, and `development|production`. `tsconfig.base.json` sets `customConditions` to `bp-source`. Plain `node` uses `dist`.
- Nest's default shutdown hook re-raises SIGTERM, which a parent sees as a signal death. `enableShutdownHooks(undefined, { useProcessExit: true })` makes the HTTP process exit 0 after cleanup.
- Express copies case sensitivity when its router is created. Nest creates that router inside the adapter constructor, so `caseSensitiveAdapter()` sets the flag before `new ExpressAdapter`. Setting it later in `configureHttp` does not change routes already compiled. A path that misses the case-sensitive `/api` prefix is Express's HTML 404 (`Cannot GET /API/...`), not the JSON error body. A miss under `/api` still uses the JSON filter.
- `service_identity.expires_at` stays nullable. The create API never stores null. A row that already has null still passes the bearer expiry check, because that check only rejects a timestamp that is in the past. No such row is seeded.
- The service-identity delete path parameter is `:id`, matching the OpenAPI name. The URL shape is unchanged.

## Next step

Step C: the worker job loop, then clients, catalogue, invoice drafts, orders, documents, printing and the automation switches at execution time. List endpoints that are store-scoped should use `permittedScopeFilter`. Outbound actions must read the switches at execution time. New Nest providers need `@Inject`. Platform audit writes set `app.platform_scope`. A denial that names a company sets `app.company_id`.
