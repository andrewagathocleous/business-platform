# STATUS

What is implemented and verified on `develop`. The Step C run-by-run log through fix round 6 is [docs/history/phase-1-step-c-log.md](history/phase-1-step-c-log.md).

## Current phase

Phase 1. Steps A (`ca7d578`), B (`271bd1d`) and C are committed on `develop` and pushed. Step C covers C-1, C-2a, C-2b1, C-2b2 and seven review-fix rounds, ending with a whole-step review. Step D (the web app) is next.

Fix round 7: print-handler reclaim locks `print_job` then `job`; a gift print in `submitting` or `uncertain` counts as possibly printed; `print.confirm` does not widen the print-job list; printer discovery upserts on `(company_id, provider, external_printer_id)` (migration `20261021150124_printer_identity`); printer mappings upsert on `(company_id, location_id, document_type)`; the n8n sanitiser rejects a sensitive variable initialised with a literal; one HTTP sweep covers every company route that takes an object id; the offline, timeout, held, release, cancel, confirm and reprint printing tests assert the audit action, outcome and correlation id.

## What works

Nothing below is sandbox-tested or live-tested.

| Capability | Behaviour | Test level | Main tests |
|---|---|---|---|
| Auth and sessions | Dev login, OIDC (mock issuer), CSRF, idle and absolute expiry, invitations, MFA withholding | integration; OIDC mock-tested | `apps/api/src/auth.integration.test.ts`, `apps/api/src/http.integration.test.ts` |
| Tenancy and permissions | Company URL, membership, deny-by-default, store and location scope, service identities | integration, unit | `apps/api/src/tenancy.integration.test.ts`, `apps/api/src/authz/`, `apps/api/src/isolation.integration.test.ts` |
| Audit | Append-only. State changes and authorisation denials record actor, company, action, object, outcome and correlation id | integration | the HTTP files above, plus commerce, orders, documents, printing and the vault. RLS rejects update and delete |
| Clients and catalogue | Clients, contacts, addresses, duplicate check, tax codes, products. Money is decimal strings | integration, unit | `apps/api/src/commerce.integration.test.ts`, `packages/domain/src/money/` |
| Invoice drafts and the PDF | Draft create, edit, preview, on-demand pdfmake PDF. Totals from `calculateDocumentTotals` | integration, unit | `apps/api/src/commerce.integration.test.ts`, `packages/documents/` |
| Orders import | Mock Shopify fixtures through the inbox and `inbox.process`. Gift text stored byte-for-byte | integration, mock-tested | `apps/api/src/orders.integration.test.ts`, `packages/integrations/src/shopify/` |
| Orders API | List, detail, transition, note, assign, claim, activity | integration | `apps/api/src/orders.integration.test.ts` |
| Documents and storage | Packing slip, gift message, gift templates, `GET /files/:id`, local filesystem storage | integration, unit | `apps/api/src/documents.integration.test.ts`, `packages/documents/`, `packages/integrations/src/storage/` |
| Printing (mock) | Mock provider. Submit, refresh, confirm, release, cancel, discover, mappings. No PrintNode | integration, mock-tested | `apps/api/src/printing.integration.test.ts`, `packages/integrations/src/printing/` |
| Job runner | Claim, lease, heartbeat, reclaim, shutdown. Handlers: `inbox.process`, `print.submit`, `print.refresh_status` | integration | `apps/api/src/automation/jobs.integration.test.ts` |
| Switches | Company switches and platform `outbound.all`. Checked again at execution | integration | `apps/api/src/documents.integration.test.ts` |
| Vault | AES-256-GCM credentials. No route calls it | integration | `apps/api/src/vault/credential-vault.integration.test.ts` |
| n8n sanitiser | Export, import and sanitize scripts. `workflows/n8n/exports` is empty | unit | `workflows/n8n/scripts/sanitize.test.ts` |

## Mocked or blocked

| Capability | State |
|---|---|
| Shopify | Mock contract and fixtures. API version on the fixtures is `unverified; check in Phase 2`. No live store calls |
| Printing | Mock provider. No PrintNode and no physical printer |
| Invoice issuance | No issue endpoint. Seed does not issue invoices |
| Web UI | `apps/web` is a reserved project. Angular, PrimeNG and Playwright are not installed |
| `pdf` queue handler | Not registered. `POST /print-requests` renders in the request |

## Known risks

- Service tokens are company-wide. An ordinary permission on a token must be held company-wide. Per-connection binding is a later hardening item.
- The sanitiser's scope is the header of `workflows/n8n/scripts/sanitize.mjs`: literal secrets in parameters and expressions are rejected, and an unparseable expression fails closed. The fixture `={{ { \`token\`: \`secret\` } }}` is not valid JavaScript and fails closed as unparseable. Deliberately obfuscated secrets are out of scope. Credentials belong in n8n's credential store.
- `prisma migrate dev` must not drop the SQL-only partial unique indexes. Prisma cannot model the predicates, so they are not in `schema.prisma`: `user_identity_one_entra_key` (`user_identity (user_id) WHERE provider = 'entra'`) and `gift_message_template_one_default_key` (`gift_message_template (company_id) WHERE is_default`). RLS, grants and triggers live in `20261018234900_rls`. The printer identity unique index is in `schema.prisma`.
- Prisma 7 issues concurrent queries on one interactive-transaction client. `createPrismaClient` serialises `pg` `query` per pooled connection. Pipeline mode is not used.
- Local storage has no `openat`. `put` creates each parent, checks its real path, opens with `O_EXCL | O_NOFOLLOW`, then checks the descriptor. `get` and `exists` open with `O_NOFOLLOW`. An attacker who can already write inside `STORAGE_ROOT` is out of scope. The root must be owned by the app user with mode `0700`.

## Deviations that still apply

Superseded notes (the worker job loop, nullable `service_identity.expires_at`, the gift-message ToUnicode rewrite, process-cwd `STORAGE_ROOT`, the sanitiser's permissive fallback, and the fix-round-7 defects) are only in the history log.

**Toolchain.** pnpm 12 reads `allowBuilds` and `peerDependencyRules` from `pnpm-workspace.yaml`. `@scarf/scarf` scripts are not run. Nest stays 12.1.3; the API is built with `tsc`. `moduleResolution` is `bundler`. `@types/express` 5.0.6 is a direct dev dependency. Workspace packages the API imports publish `bp-source`, then `types`, then `default`. Dev, test, seed and `openapi:export` use `tsx --conditions=bp-source`. Vitest aliases `@bp/db`, `@bp/domain`, `@bp/documents` and `@bp/integrations` to source. Plain `node` uses `dist`. `dev`, `dev:web` and `test:e2e` exit 1. `HOST` defaults to `127.0.0.1`. Throttle defaults are 300, 20 and 120 per 60 seconds, skipped when `APP_ENV=test` unless `THROTTLE_ENABLED_IN_TEST=true` (test-only, not in `.env.example`). The auth matcher is the case-sensitive prefix `/api/auth`. Swagger UI allows `'unsafe-inline'` on `/api/docs` in development and test. Express case sensitivity is set in the adapter constructor; a miss of `/api` is HTML 404. Nest shutdown uses `useProcessExit`. Compose commands pass `--env-file .env`.

**Auth and tenancy.** The Entra column is `entra_oid`. Lookup is `(provider, issuer, subject)`. One Entra identity per user is the partial index above. The invitation URL is `GET /api/auth/oidc/start?redirect=&invitation=`. Only the SHA-256 of the token is stored. Role JSON is `{ roleKey, scopeType, scopeId }`. TTL is 7 days. `email` matches only when `email_verified` is exactly `true`. `amr` matches MFA only for the exact string `mfa`. Dev login and the OIDC start and callback routes are public. Logout requires CSRF. The `XSRF-TOKEN` cookie is not HttpOnly, `SameSite=Strict`, `Path=/`, and its max-age is 7 days. Acceptance locks the company row and re-checks the inviter. It does not apply the last-admin rule and does not reactivate a suspended membership. A platform owner is treated as holding `platformOwnerGrants()` without a membership, and that check does not apply MFA withholding. `@Authenticated()` is a staff session with no company permission. `@PlatformOwner()` is a route class. The company check is `CompanyAccessService` inside `AuthorizationGuard`. `GET /members/:membershipId` exists so a miss is audited. `GET /context` requires `company.view` and returns every company switch, including the ones that are off. The global `outbound.all` row is not in that list. A non-owner on a platform route is 404 `not_platform_owner`. Missing MFA on an owner is 403 `mfa_required`. When privileged MFA is required and the session has none, `GET /api/me` lists only that user's active memberships. Session idle and absolute expiry use an injectable clock. `auth_flow` expiry uses database `now()`. A browser-binding mismatch does not consume the flow. Protocol failures are 400. An unprovisioned identity is 403. Unknown and disabled dev-login emails are both 401, with different audit reasons. Login revokes only the presented previous cookie. Account locks that do not change keys use `FOR NO KEY UPDATE`. Company locks stay `FOR UPDATE`. `mailbox` and `integration_account` assignments are 400 `scope_not_supported`. Successful GETs are not audited. Removal does not revoke sessions. Suspension revokes them only when the user has no other active membership. Self-suspension of the last `member.manage` holder is `self_modification` before rule 4. Invitation creation does not take the company lock. `/api/auth/providers` is Step D. `allowInsecureRequests` is used only in development and test. Service tokens are company-wide. Automation routes accept only `Authorization: Bearer bps_…`. A staff session on those routes is 401 `automation_requires_bearer`. `GET …/ping` returns `{ ok: true }` and does not ingest. The delete path parameter is `:id`.

**Money, documents and files.** Exclusive-mode `lineGross` equals `lineNet`. The tax summary is one row per tax code. `documentType` accepts `quote` or `invoice`. `GET /tax-codes` is `catalog.view`. Products have no `version`, and there is no `GET /products/:id`. `POST /clients/duplicate-check` is `client.manage`. The draft watermark is drawn twice so pdfjs extracts the Greek sentence. The PDF is rendered after the tenant transaction commits and is not stored. Gift cards use pdfkit 0.20.2 because pdfmake drops blank lines. Invoices and packing slips use pdfmake. Gift acceptance is layout exactness plus per-line visible glyphs, not a byte-identical pdfjs string. Width keeps a 2pt inset. Height does not. Fit height uses `|descent|`. `\r\n` and a lone `\r` are one hard break while drawing. The stored string is not rewritten. `/ActualText` is optional metadata. Gift-template PATCH has no `expectedVersion`. Writes take an advisory lock, not the company row. Each margin must be ≥ 0 and strictly less than half of its page axis. Test hooks on inbox enqueue, template save, switch writes and print recording are null in production. The stored file kind is `invoice_pdf`. `GET /files/:id` chooses the permission from the kind. A storage miss is an audited 404 and the path is not logged. Relative `STORAGE_ROOT` and `MOCK_PRINT_ROOT` both resolve from the repository root. `CredentialVault.encrypt` takes `{ companyId, provider, label, plaintext, createdById }`. `decrypt` and `rotate` take `companyId`.

**Orders, jobs and printing.** `GET /orders` uses `orderListScope`. A `storeId` outside the grants is an empty page. A missing order or a store outside the grants is 404 `out_of_scope`. Assign and claim share `POST /orders/:id/assign`. `inbox.process` sets `max_attempts` to 5. HTTP 409 keeps `error.code` `conflict`; the audit reason is `version_conflict`. `new → ready` is `transition_not_allowed`. `payment_not_settled` is `preparing → ready`. The first import of an order with `cancelledAt` sets `review_required`. Store totals are the Shopify money strings. `calculateDocumentTotals` is for invoices. The demo reads the connection id through `TenantDb`. Express `query parser` is `extended`. Advisory locks use `$executeRaw`. `automation_switch` and `job` are RLS-exempt; company lists filter on `companyId`. `setOutboundAll` updates by `id` after a `companyId: null` read. Job-runner updates match `id`, status and `locked_by`. Reclaim of a non-retryable or exhausted lease is `uncertain` with `lease_expired`, not `job.failed`. Shutdown of an exhausted retryable job is `failed`. `shutdownGraceMs` (25s) and `drainDeadlineMs` (5s) are runner fields, not environment variables. `finishQueue` locks the row, then checks the clock. `lockOwnedJob` still evaluates the clock inside `FOR UPDATE`. The external wait uses the host clock against the deadline instant stored at claim. When a heartbeat and the follow-up read both fail, the abort budget uses `performance.now()`. A `print.submit` whose print row is still `queued` is requeued. Once it is `submitting`, reclaim sets both rows to `uncertain`. Confirm locks only `print_job`. Orders expand a location grant to the stores at that location. Print lists do not copy a store's location into the filter, and `print.confirm` does not widen the list. The mock provider's states are `submitted` and `done`. `done_reported` is the worker's mapping. `GET /print-jobs/:id` is extra. The `pdf` handler is not registered. The `print_job` queue foreign key is `ON DELETE RESTRICT`.

**Seed and schema.** Unspecified statuses are text. Gift `line_height` is `1.200`. `job.max_attempts` defaults to 1. `fulfil.a` is fulfilment scoped to `Nutbox Demo Shopify` plus company-wide base. Company B's store is `Olive Grove Demo Shopify`. Packing-slip mapping is A4 and gift-message mapping is A6. Switches other than global `outbound.all` and Company A `printing` are explicit `false` rows. Draft invoices may have null series and number. `membership_role` uniqueness is an expression index. RLS is called out in `packages/db` rather than a custom ESLint rule. `bp_owner` with no company context sees 0 brand rows.

**Fix round 7.** Print-handler reclaim (`print.submit`, `print.refresh_status`) selects expired rows without locking them, then locks `print_job` and re-checks the queue row in one transaction per job. Generic jobs stay on the previous path. `submitting` and `uncertain` count as possibly printed for gift-message change detection. Discovery upserts on `companyId_provider_externalPrinterId`. The dev database had no duplicate printer identities, so the migration does not clean rows. Mapping writes upsert on `companyId_locationId_documentType`. A sensitive `const`, `let` or destructured binding fails unless the initialiser is an exact `$env` or `$credentials` reference. The isolation sweep builds its route list from the Nest router. Routes with no object id besides `:companyId` are an explicit exemption list, and a new company route that is neither swept nor exempted fails the test. Claim is the assign route. Contacts and addresses are nested on client create and patch. `duplicate-check` is exempt because `excludeClientId` does not 404. The store-events route rejects a staff session, so that one case uses a company B bearer token created by admin.b and company A's connection id. The switch key is not a row id, so that PUT uses company A's URL and expects `not_a_member`.

## Commands verified

Latest run only: 2026-10-21, fix round 7. Node 24.22.0. Dev Postgres was already running. Migration `20261021150124_printer_identity` applied on `business_platform` and, via `pnpm db:reset:test`, on `business_platform_test`. No new npm dependency. TypeScript stayed 6.0.x and Prisma stayed 7.10.1. No route or OpenAPI schema changed, so `pnpm openapi:export` was not run.

| Command | Result |
|---|---|
| `pnpm install` | pass. Already up to date |
| `pnpm lint` | pass. 5 tasks |
| `pnpm typecheck` | pass. 5 tasks |
| `pnpm test` | pass. Nx served a cache hit with no counts. Uncached `nx run-many -t test --skip-nx-cache`: domain 40, tools 7, integrations 16, documents 12, n8n-workflows 38, api 63, db 4. 180 tests |
| `pnpm build` | pass. 5 tasks |
| `node tools/smoke-dist.mjs` | pass. Draft PDF 25399 bytes, packing slip 18209 bytes, gift message 7979 bytes, Shopify order mapped, one mock submit wrote 18209 bytes, `GET /api/health/ready` 200, worker job loop started, both processes exited 0 |
| `pnpm db:reset:test` then `pnpm test:integration` | pass. 150 tests: db 13, api 137. No `client.query` deprecation. Vitest still prints its ESM-config warning |
| `pnpm test:integration` twice more, no reset | pass. Each run: db 13, api 137, 150 tests. No `client.query` deprecation. The same Vitest ESM-config warning |

Integration files, verbose, from the run immediately after `pnpm db:reset:test`. Printing grew from 17 to 22. The new file is the isolation sweep (1). Every other file kept the fix-round-6 count. Total 150 = db 13 + api 137.

- db row level security (13): unchanged from Step B
- authorisation and tenancy (19) and privileged MFA withholding (2): unchanged
- clients, catalogue and invoice drafts (6), credential vault (2), HTTP API (10), auth rate limit (1): unchanged
- orders import and API (16): unchanged
- authentication (28): unchanged
- job runner (20): unchanged
- documents, files and company switches (10): unchanged
- printing with the mock provider (22): the previous 17, plus an expired refresh lease reclaimed during late recording (25 iterations, no deadlock), a gift-message change while the print is `submitting`, a store-scoped submitter who also holds company-wide `print.confirm` can list, two concurrent discoveries leave one printer, and two identical first mapping PUTs both succeed and leave one row. Confirm, reprint, offline, timeout, held, release and cancel assert action, outcome and correlation id
- company isolation sweep (1): admin.b sends company A's object ids to every company-scoped route that takes an object id. Each response is 404 with `authorization.denied` and the correlation id, and A's row is unchanged

## Next step

Step D is the Angular app. Invoice issuance still has no issue endpoint. Shopify and printing stay mock providers until their live credentials exist. The `pdf` queue handler is still not registered.
