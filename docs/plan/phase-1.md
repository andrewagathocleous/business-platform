# Phase 1 plan: runnable foundation and first milestone

Owner: planner (Claude Code). Implementer: Cursor CLI. Reviewer: Codex CLI.
Written 2026-10-19. Implement **one step at a time**: A, B, C, D, E. After each step the planner verifies it (runs everything, reads the diff), the reviewer reviews it, and fixes are applied before the step is committed.

Everything in Phase 1 uses **fictional data and mock providers**. There are no live accounts, no real sends and no real prints.

## Milestone 1 acceptance (from the brief, section 13)

The milestone is met when all of these are demonstrated and recorded in `docs/milestones/m1-report.md`:

1. Authorised login (dev login on the local stack; the OIDC code path tested against a mock OIDC provider).
2. Two isolated companies.
3. Company-scoped roles.
4. Client registration (staff create a client).
5. A persisted draft invoice with correct backend totals and a PDF.
6. A realistic mock order imported through the real automation import contract.
7. The gift message preserved byte-for-byte (Greek, line breaks).
8. A transition to `ready`.
9. A simulated print queued and processed by the worker through the mock PrintNode provider.
10. Audit history for all of the above.
11. Restart all services and confirm persistence.
12. Proof that an unauthorised employee can't access the other company's data (automated checks, listed below).

## Pinned versions (checked 2026-10-19)

| Item | Version | Note |
|---|---|---|
| Node | 24.22.0 (`.nvmrc`: `24.22.0`) | Angular 22 needs `^24.15` |
| pnpm | 12.x through corepack (`packageManager` field) | |
| Nx | 23.3.x | `@nx/angular`, `@nx/nest`, `@nx/js`, `@nx/vite` |
| TypeScript | 6.0.x | Angular 22 peer `>=6.0 <6.1`. **Not 7.x** |
| Angular | 22.2.x | standalone, signals, zoneless if the generator supports it |
| PrimeNG | 22.1.x plus `@primeuix/themes` 3.x (Aura) | `@angular/cdk` 22.1+ |
| NestJS | 12.1.x | Express platform |
| Prisma | **7.10.x** (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) | npm `latest` points at 8.0 RC; do not use it |
| zod | 4.x; `nestjs-zod` 5.x | |
| decimal.js | 10.6.x | |
| pdfmake | 0.3.x | Node API; check its server-side usage docs |
| openid-client | 6.x | |
| Vitest | 5.x (`unplugin-swc` for Nest decorators) | |
| Playwright | latest stable | web e2e |
| Postgres image | `postgres:18.6-alpine` | **PG 18 images mount at `/var/lib/postgresql`**, not `/var/lib/postgresql/data` |
| n8n | `n8nio/n8n:2.43.7` and `n8nio/runners:2.43.7` | versions must match |
| Caddy | `caddy:2.11.7-alpine` | |
| Node image | `node:24.22.0-alpine` | |

If a pinned version turns out to be incompatible, pick the nearest compatible version and record why in `docs/STATUS.md`. Don't silently change major versions.

---

## Step A: workspace, infrastructure, database schema, RLS, domain package, seed

### A1. Workspace and tooling

- Nx 23 + pnpm workspace in the existing repo. Keep `README.md`, `.gitignore`, the brief file, `AGENTS.md`, `CLAUDE.md` and `docs/`. Extend `.gitignore` with `var/`, `*.pdf` outside fixtures, `.nx/`, Playwright reports and `packages/db/src/generated/`.
- Projects:
  - `apps/api`: NestJS
  - `apps/web`: Angular; generated in Step D, but reserve the name now
  - `packages/domain`
  - `packages/db`
  - `packages/documents`
  - `packages/integrations`
- Nx module boundary tags:
  - `type:app`
  - `type:domain`, which depends on nothing but `decimal.js` and `zod`
  - `type:data` (db)
  - `type:infra` (documents, integrations)
  - `web` may import only `domain` (types and zod schemas). It must never import `db`, `documents` or `integrations`.
- ESLint (flat config) and Prettier. `strict: true` TypeScript everywhere.
- Root scripts in `package.json`:
  - `dev:infra`: `docker compose -f infra/compose/compose.dev.yml up -d`
  - `dev:infra:down`
  - `db:migrate` (dev: `prisma migrate dev`), `db:deploy` (`prisma migrate deploy`), `db:reset:test`, `db:seed`
  - `dev` (api + worker + web), `dev:api`, `dev:worker`, `dev:web`
  - `lint`, `typecheck`, `test` (unit), `test:integration`, `test:e2e`, `build`
  - `setup:env`: generates `.env` from `.env.example` with random local secrets; never overwrites an existing `.env`
  - `openapi:export`: writes `docs/api/openapi.json`
- `.env.example`: placeholders only, and every variable documented with a comment.

### A2. Local infrastructure (`infra/compose/compose.dev.yml`)

- `postgres` (18.6-alpine):
  - port `127.0.0.1:5432:5432` only
  - named volume mounted at `/var/lib/postgresql`
  - healthcheck
  - init scripts from `infra/postgres/init/`
- `infra/postgres/init/01-roles-and-dbs.sh` (idempotent; passwords from env) creates:
  - Roles:
    - `bp_owner`: LOGIN, owns the app schema, CREATEDB in dev only for the Prisma shadow DB
    - `bp_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE
    - `n8n`: LOGIN, owner of database `n8n` only
  - Databases:
    - `business_platform`, owned by bp_owner
    - `business_platform_test`, owned by bp_owner
    - `n8n`, owned by n8n
  - Grants and settings:
    - `REVOKE ALL ON DATABASE n8n FROM PUBLIC`
    - `REVOKE ALL ON DATABASE business_platform FROM PUBLIC`
    - grant CONNECT to the intended roles only
    - `ALTER DEFAULT PRIVILEGES FOR ROLE bp_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bp_app`, plus `USAGE, SELECT ON SEQUENCES`
  - The same SQL lives in `infra/postgres/roles.sql` so CI and the VPS can run it.
- `n8n` (2.43.7) plus `n8n-runner` (`n8nio/runners:2.43.7`):
  - `DB_TYPE=postgresdb` with the `n8n` user and DB
  - `N8N_ENCRYPTION_KEY` from env
  - `N8N_RUNNERS_MODE=external`, `N8N_RUNNERS_AUTH_TOKEN`, `N8N_RUNNERS_BROKER_LISTEN_ADDRESS=0.0.0.0`
  - `N8N_BLOCK_ENV_ACCESS_IN_NODE=true`, `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=true`
  - `NODES_EXCLUDE` covering executeCommand, localFileTrigger, readWriteFile, ssh and git
  - `N8N_COMMUNITY_PACKAGES_ENABLED=false`, `N8N_DIAGNOSTICS_ENABLED=false`, `N8N_PERSONALIZATION_ENABLED=false`
  - `EXECUTIONS_DATA_PRUNE=true`, `EXECUTIONS_DATA_MAX_AGE=168`, `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`
  - `GENERIC_TIMEZONE=Asia/Nicosia`
  - port `127.0.0.1:5678:5678`
  - `N8N_SECURE_COOKIE=false` is allowed **only** in the dev compose (plain-HTTP localhost), with a comment explaining why
- Docker socket mounted into nothing. All containers run as non-root where the image supports it.
- `workflows/n8n/scripts/export.sh` and `import.sh` wrap `n8n export:workflow --all --separate --output=...` and `n8n import:workflow --separate --input=...` through `docker compose exec`. Export is followed by `sanitize.mjs`, which strips `pinData`, `staticData`, credential **ids** (keeping names) and execution metadata, and fails if anything that looks like a secret remains.

### A3. Database (`packages/db`)

- Prisma 7 with `prisma.config.ts`, the `prisma-client` generator (choose the CJS or ESM module format that matches the Nest build), and `@prisma/adapter-pg`.
- Two connection URLs:
  - `DATABASE_URL_OWNER` (bp_owner) for migrations and seed only
  - `DATABASE_URL` (bp_app) for the api, the worker and integration tests
- Conventions:
  - `uuid` primary keys (`@default(uuid(7))`)
  - `created_at` and `updated_at` as `timestamptz`
  - snake_case tables and columns via `@@map`/`@map`
  - money as `Decimal @db.Decimal(19,2)`, quantities and unit prices as `@db.Decimal(19,4)`, rates as `@db.Decimal(7,4)`
  - email columns use `citext` (enable the extension in the first migration)
- Export `createPrismaClient(url)` and the **`TenantDb`** helper:
  - `TenantDb.run(ctx: { companyId, actor, correlationId }, fn: (tx) => Promise<T>)` opens an interactive transaction, runs `select set_config('app.company_id', $1, true)` (plus `app.actor_id` and `app.correlation_id`), then calls `fn(tx)`.
  - The helper is the **only** way company-scoped tables are touched. Add an ESLint rule or code-review note against using the raw client for RLS tables.

#### Tables

Identity, tenancy and infrastructure tables (**no RLS**; only their owning services access them):

- `user_account`: id, email (citext, unique), display_name, locale (`en`/`el`), is_platform_owner (default false), status (`active`/`disabled`), timestamps.
- `user_identity`: id, user_id, provider (`entra`/`dev`), issuer, subject, tenant_id, email_at_link, last_login_at; unique (provider, issuer, subject).
- `user_session`: id, user_id, token_hash (unique), auth_method, mfa_satisfied, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revoked_reason, ip, user_agent.
- `auth_flow`: id, state_hash, browser_binding_hash, nonce, code_verifier (encrypted with the vault), redirect_after, invitation_token_hash, expires_at (10 min), consumed_at. Holds OIDC transaction state, bound to the browser that started it (see B2).
- `company`: id, legal_name, trading_name, country_code (default `CY`), registration_number, vat_number, tax_office, address (jsonb), default_currency (`EUR`), timezone (`Asia/Nicosia`), default_locale, document_language, payment_terms_days (30), status, is_fictional, timestamps.
- `membership`: id, user_id, company_id, status (`invited`/`active`/`suspended`/`removed`), suspended_at, removed_at, timestamps; unique (user_id, company_id).
- `role`: id, company_id, key, name, description, template_key, timestamps; unique (company_id, key).
- `role_permission`: role_id, permission; primary key (role_id, permission).
- `membership_role`: id, membership_id, role_id, scope_type (`company`/`store`/`location`/`mailbox`/`integration_account`), scope_id (nullable, required unless the scope is company), granted_by, created_at; unique (membership_id, role_id, scope_type, scope_id).
- `invitation`: id, company_id, email, role_assignments (jsonb), token_hash (unique), expires_at (7 days), invited_by, accepted_at, accepted_user_id, revoked_at, created_at.
- `service_identity`: id, company_id, name, purpose, secret_hash, permissions (text[]), status, expires_at, created_by, created_at, last_used_at, revoked_at.
- `automation_switch`: id, company_id (null means global), key, enabled (default **false**), reason, updated_by, updated_at; unique index on (coalesce(company_id, nil-uuid), key).
- `job`: id, company_id, type, payload (jsonb), status (`queued`/`running`/`succeeded`/`failed`/`held`/`uncertain`/`cancelled`), attempts, max_attempts, run_after, locked_by, locked_until, timeout_ms, last_error, correlation_id, idempotency_key (unique), created_at, updated_at, finished_at; index (status, run_after).

Company-scoped tables. Every one has a non-null `company_id` FK and **RLS ENABLE + FORCE**:

- `company_bank_account`: bank_name, iban, bic, account_holder, is_default.
- `brand`: name.
- `location`: name, address (jsonb), timezone (nullable).
- `store`: brand_id, location_id, platform (`shopify`/`prestashop`/`manual`), name, domain, invoice_authority (`undecided`/`store`/`platform`, default `undecided`), gift_message_keys (text[], default `{'Gift Message','gift_message','Gift message'}`), delivery_method_map (jsonb: shipping code or title → `courier_cy`/`post_international`/`collection`), status.
- `store_connection`: store_id, mode (`mock`/`live`), status, credential_id, read_only (default true), write_back_enabled (default false), last_event_at, last_sync_at, sync_checkpoint (jsonb).
- `integration_credential`: provider, label, key_id, nonce, ciphertext, auth_tag, hint, created_by, created_at, rotated_at, revoked_at.
- `integration_inbox`: connection_id, provider, external_event_id, topic, external_object_id, source_updated_at, payload (jsonb), received_at, status (`received`/`processed`/`stale`/`failed`), duplicate_count (default 0), processed_at, error, correlation_id; unique (company_id, connection_id, external_event_id).
- `client`: kind (`organisation`/`individual`), display_name, legal_name, vat_number, tax_id, email, phone, website, notes, default_currency, default_language, payment_terms_days, name_normalized, email_normalized, vat_normalized, archived_at, created_by, version, timestamps.
- `client_contact`: client_id, name, email, phone, position, is_primary.
- `client_address`: client_id, kind (`billing`/`shipping`), label, line1, line2, city, region, postal_code, country_code, is_default.
- `tax_code`: code, name, rate_percent, kind (`standard`/`reduced`/`zero`/`exempt`/`reverse_charge`/`out_of_scope`), note_en, note_el, is_example, active; unique (company_id, code).
- `product`: sku, name, description, kind (`product`/`service`/`shipping`), unit, unit_price, prices_include_tax, tax_code_id, active; partial unique (company_id, sku) where sku is not null.
- `invoice_series`: document_type (`quote`/`invoice`/`credit_note`), code, prefix, next_number, padding, active; unique (company_id, code). Schema and seed only in Phase 1.
- `invoice`: document_type, status (`draft`/`issued`/`cancelled`), client_id, currency, language, prices_include_tax, issue_date (date), due_date (date), series_id, number, number_seq, subtotal, discount_total, net_total, tax_total, total, reference, notes, terms, source_order_id, created_by, updated_by, issued_by, issued_at, version, timestamps; partial unique (company_id, series_id, number_seq) where number_seq is not null.
- `invoice_line`: invoice_id, position, kind (`item`/`shipping`), product_id, description, quantity, unit, unit_price, discount_percent (`Decimal(5,2)`), tax_code_id, tax_rate_percent (snapshot), line_subtotal, line_discount, line_net, line_gross.
- `invoice_tax_summary`: invoice_id, tax_code_id, tax_rate_percent, net, tax, gross.
- `sales_order`: store_id, connection_id, external_id, external_number, source_platform, source_status (jsonb, raw), source_created_at, source_updated_at, payment_status (`pending`/`authorized`/`paid`/`partially_paid`/`refunded`/`partially_refunded`/`voided`/`unknown`), fulfilment_status (`new`/`review_required`/`preparing`/`ready`/`handed_to_courier`/`completed`/`cancelled`), integration_status (`synced`/`stale`/`error`), review_reason, attention_reasons (text[], default `{}`; records source changes that arrive after an order is already `completed` or `cancelled` without reopening it), customer (jsonb), recipient (jsonb), billing_address (jsonb), delivery_method (`courier_cy`/`post_international`/`collection`/`unknown`), shipping_line (jsonb), gift_message (text, exact), gift_message_meta (jsonb), customer_note, currency, subtotal, shipping_total, tax_total, total, assigned_to_user_id, version, timestamps; unique (company_id, connection_id, external_id).
- `sales_order_line`: order_id, external_line_id, sku, title, variant_title, quantity, unit_price, total.
- `order_note`: order_id, author_user_id, body, created_at.
- `stored_file`: kind (`invoice_pdf`/`packing_slip`/`gift_message`/`test_print`), storage_key (unique), content_type, size_bytes, sha256, source_type, source_id, source_version, created_by, created_at.
- `gift_message_template`: name, page_width_mm, page_height_mm, margin_top_mm, margin_right_mm, margin_bottom_mm, margin_left_mm, font_size_pt, min_font_size_pt, line_height, align (`left`/`center`), vertical_align (`top`/`middle`), is_default.
- `printer`: location_id, provider (`mock`/`printnode`), external_printer_id, name, description, paper_sizes (text[]), status (`online`/`offline`/`unknown`), last_seen_at.
- `printer_mapping`: location_id, document_type (`invoice`/`packing_slip`/`gift_message`/`shipping_label`), printer_id, paper_size, copies (default 1); unique (company_id, location_id, document_type).
- `print_job`: printer_id, document_type, source_type (`order`/`invoice`/`test`), source_id, source_version, file_id, copies, paper_size, status (below), is_reprint, reprint_of_id, reprint_reason, idempotency_key, provider_job_id, provider_state, requested_by, queue_job_id, attempts, last_error, correlation_id, submitted_at, completed_at, confirmed_by, confirmed_at, timestamps.
  - unique (company_id, idempotency_key)
  - **partial unique index** (company_id, source_type, source_id, document_type) where `is_reprint = false and status not in ('failed','cancelled','not_printed')`, which stops concurrent duplicate first prints. The index deliberately leaves out `source_version`: an unrelated order change (such as a new phone number) must not allow a second "first" print. Any later output for the same document goes through the explicit reprint path, with permission and a reason. `source_version` is still recorded on the job for information.
  - statuses: `queued`, `held`, `submitting`, `submitted`, `delivered_to_printer`, `done_reported`, `confirmed_printed`, `not_printed`, `failed`, `uncertain`, `cancelled`
- `audit_event`: id, company_id (nullable for platform events), occurred_at, actor_type (`user`/`service`/`system`), actor_id, actor_label, action, object_type, object_id, outcome (`success`/`denied`/`failure`), correlation_id, ip, user_agent, details (jsonb, redacted).
  - RLS policies:
    - SELECT `USING (company_id = app_current_company() OR (company_id IS NULL AND current_setting('app.platform_scope', true) = 'on'))`
    - INSERT `WITH CHECK (true)`
  - `bp_app` gets no UPDATE or DELETE, and a trigger raises on UPDATE or DELETE.

#### Raw-SQL migration (after the Prisma-generated tables)

- `CREATE FUNCTION app_current_company() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;`
- For every company-scoped table:
  - `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`
  - `CREATE POLICY tenant_isolation ON … USING (company_id = app_current_company()) WITH CHECK (company_id = app_current_company());`
- Grants: re-grant DML to `bp_app` on all tables, then `REVOKE UPDATE, DELETE ON audit_event FROM bp_app`.
- Trigger `invoice_issued_immutable`: once an invoice's `status = 'issued'`, it blocks UPDATE or DELETE of the `invoice` row (except the receivables columns that Phase 3 will name). For `invoice_line` and `invoice_tax_summary` it blocks:
  - **INSERT** where the target invoice is issued
  - **UPDATE** where the old *or* new parent invoice is issued, which also blocks moving a child row between invoices
  - **DELETE** where the parent invoice is issued

  Write it now and test it. A test can set `status = 'issued'` directly as bp_owner to set this up.
- A schema test (integration) lists every table with a `company_id` column, asserts that RLS is enabled and forced on all of them except the documented exceptions, and fails if a new table is missing it.

### A4. Domain package (`packages/domain`)

Pure TypeScript with no Nest or Prisma imports.

- `money/`:
  - `Money` helpers over decimal.js (precision 40, `ROUND_HALF_UP`)
  - `parseAmount(string)`, which rejects numbers, more than 4 decimal places for prices and quantities, and non-finite input
  - `round2`
  - `calculateDocumentTotals(input)`, which implements `docs/finance/rounding.md` exactly, including largest-remainder allocation in inclusive mode. Groups are keyed by **tax code id**, not by rate (E12).
- `orders/state-machine.ts`: the allowed transitions and their guards:
  - `new` → `review_required`, `preparing`, `cancelled`
  - `review_required` → `new`, `preparing`, `cancelled`
  - `preparing` → `ready`, `review_required`, `cancelled`
  - `ready` → `handed_to_courier` (only if delivery method is `courier_cy` or `post_international`), `completed` (only if delivery method is `collection`), `preparing`, `cancelled`
  - `handed_to_courier` → `completed`
  - `completed` and `cancelled` are terminal
  - Guard: `→ ready` requires payment status `paid`; anything else returns the error `payment_not_settled`.
  - Guard: `→ cancelled` requires the separate `order.cancel` permission, checked by the API.
  - Export `allowedTransitions(order)` for the UI.
- `authz/permissions.ts`: the permission catalogue (keys exactly as in `docs/security/permission-matrix.md`). Each entry has its phase, `scopableBy` (`[]`, `['store','location']` or `['mailbox']`, and so on) and `automationOnly`.
- `authz/role-templates.ts`: the 7 role templates plus `BASE` (staff baseline: `company.view`, `catalog.view`). Templates never include automation-only permissions.
- `authz/evaluate.ts`: `can(grants, permission, resourceScope?)`, which implements the matrix's scope semantics. A scoped assignment yields only the role permissions whose `scopableBy` includes that scope type, limited to the scope id. Non-scopable permissions from a scoped assignment are **not** granted. There's also `canGrant(actorGrants, targetRole, scope)`, which implements the escalation rules.
- `contracts/`: zod schemas for the API DTOs shared with web (money as decimal strings).
- `text/`: `normalizeForDuplicateCheck` (NFKC, lower-case, collapse whitespace, strip legal suffixes such as `ltd`/`limited`/`ltd.`). This is used **only** for duplicate detection and never for stored customer text.
- `time/`: `businessDateInZone(instant, tz)` (Intl based) and `addDaysToBusinessDate`.

Unit tests must include:

- E1–E12 from `docs/finance/rounding.md`
- scope semantics: a store-scoped FS assignment grants `order.view` for that store only, and grants neither `catalog.view` nor `company.view`; a store-scoped CA assignment grants no `member.manage`; BASE company-wide gives `catalog.view`
- every allowed and disallowed state transition
- the permission-matrix doc and code staying in sync (the test parses the markdown tables)
- `canGrant` escalation cases
- the DST boundary for `Asia/Nicosia`: 2026-10-25 at 00:30 UTC is still 2026-10-25 locally
- duplicate normalisation that leaves the stored values untouched

### A5. Seed (`packages/db/seed`)

Fictional data only, with `is_fictional = true` and `.test` emails. Idempotent, so it can be re-run safely. It runs as bp_owner but **sets `app.company_id` per company** so it also proves the policies.

- **Company A**: legal name `Demo Company A Ltd (fictional)`, trading name `Nutbox (demo data)`, no VAT number.
  - Location `Demo Shop – Nicosia`.
  - Brand `Nutbox (demo)`.
  - Stores: `Nutbox Demo Shopify` (shopify) and `Nutbox Demo PrestaShop` (prestashop), each with a `mock` connection.
- **Company B**: `Demo Company B Ltd (fictional)`, trading name `Olive Grove (demo data)`.
  - One Shopify store with a mock connection.
- Each company gets the role templates copied in, and these example tax codes (`is_example = true`, names suffixed "(example — verify with accountant)"): `STD19` 19%, `RED9` 9%, `RED5` 5%, `ZERO` 0% (zero), `EXEMPT` 0% (exempt).
- Each company gets 4 products (nuts and gift box; one `service` gift wrapping; one `shipping` local delivery), 3 clients (an organisation with billing and shipping addresses; individuals with Greek names in Greek script), and invoice series `INV`/`CN`/`QUO` with prefixes `DEMO-A-INV-` and so on.
- Default gift-message template: 148 × 105 mm, margins 12 mm, 16 pt shrinking to 10 pt, centred, middle. Name it "A6 landscape card (placeholder until card stock confirmed)".
- Mock printers in Company A's location:
  - `Mock LaserJet (online)`: A4 and A6
  - `Mock Offline Printer`: submits fail with `printer_offline`
  - `Mock Flaky Printer`: submits time out, which yields `uncertain`
- Mappings: packing slip and gift message point at the online mock. Company B has a mock online printer but **its printing switch stays off**.
- Users and memberships (dev identities):

  | Email | Memberships |
  |---|---|
  | owner@example.test | platform owner, no memberships needed |
  | admin.a@example.test | CA in A |
  | ops.a@example.test | OM in A |
  | fulfil.a@example.test | FS in A scoped to `store:Nutbox Demo Shopify`, plus BASE in A company-wide |
  | finance.a@example.test | FIN in A |
  | marketing.a@example.test | MKT in A |
  | support.a@example.test | CS in A |
  | multi@example.test | FIN in B and AUD in A |
  | admin.b@example.test | CA in B |
  | fulfil.b@example.test | FS in B, company-wide |
  | suspended.a@example.test | FS in A, membership suspended |

- Switches: global `outbound.all = true` and Company A `printing = true`, both with reason "dev seed: mock provider only". Everything else stays at the default `false`.
- Orders: the seed does **not** insert orders directly. Step C provides `pnpm demo:import-fixtures`, which pushes fixtures through the real import contract.

### Step A acceptance

- `pnpm install && pnpm dev:infra && pnpm db:migrate && pnpm db:seed` works from a clean checkout after `pnpm setup:env`.
- `pnpm lint typecheck test` pass. `pnpm test:integration` passes the RLS schema test and these direct RLS tests, connected as **bp_app**:
  1. With no company context, every RLS table returns 0 rows.
  2. In A's context, B's rows are invisible.
  3. Inserting a row with B's company_id in A's context fails.
  4. Running `UPDATE` or `DELETE` on `audit_event` fails.
  5. Updating an issued invoice fails. So does inserting, updating, moving or deleting its lines or tax-summary rows.
- n8n opens on `http://127.0.0.1:5678` with its runner connected (check the runner logs). Port checks show that only 127.0.0.1 bindings exist.
- CI (`.github/workflows/ci.yml`) runs:
  - install with `--frozen-lockfile`
  - lint, typecheck and unit tests
  - integration tests against a `postgres:18.6-alpine` service, after applying `infra/postgres/roles.sql`
  - build
  - gitleaks secret scan
  - `pnpm audit --prod --audit-level high`, reported but not yet blocking; this is noted in STATUS
- `docs/STATUS.md` is updated.

---

## Step B: API core (config, security, auth, authorisation, audit, tenancy endpoints)

### B1. App skeleton

- `apps/api/src/main.ts` (HTTP) and `main.worker.ts` (Nest application context with no HTTP listener, running the job loop).
- Config validated with zod at startup:
  - `APP_ENV` is required and must be one of `development|test|uat|production`.
  - In `uat` or `production`: refuse to start if `AUTH_DEV_LOGIN_ENABLED=true`, `SESSION_COOKIE_SECURE=false`, any secret is missing or still a placeholder, or `APP_MASTER_KEYS` is missing.
- Middleware and global setup:
  - pino logging (`nestjs-pino`) with redaction of `req.headers.cookie`, `req.headers.authorization`, `*.token`, `*.secret`, `*.password`, `*.iban`, `*.ciphertext` and `set-cookie`
  - correlation id middleware: accept `X-Correlation-Id` if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise generate a UUIDv7; store it in AsyncLocalStorage; echo it in the response header
  - `helmet` with a strict CSP for API responses
  - CORS disabled; same origin through the proxy
  - body size limit 1 MB, raw-body capture available for webhook routes
  - a global exception filter that returns `{ error: { code, message, correlationId } }` and never leaks stack traces
- Health: `GET /api/health/live` (process) and `GET /api/health/ready` (DB query as bp_app).
- OpenAPI at `/api/docs` (only in development and test) and `pnpm openapi:export`.
- `@nestjs/throttler`: the default plus stricter limits on `/api/auth/*` and the automation routes.

### B2. Authentication

- **Sessions** (`identity` module), per ADR-0004:
  - cookie name `__Host-bp_session` when `SESSION_COOKIE_SECURE=true`, `bp_session` otherwise
  - HttpOnly, SameSite=Lax, Path=/
  - idle timeout 8 h (sliding, `last_seen_at` updated at most once a minute), absolute timeout 7 days
  - a new token is issued at every login, and the previous session cookie (if any) is revoked
- **CSRF**: on login and on `GET /api/me`, set cookie `XSRF-TOKEN` = base64url(HMAC-SHA256(session_id, CSRF_SECRET)), not HttpOnly, SameSite=Strict. Every unsafe method on cookie-authenticated routes requires header `X-XSRF-TOKEN` to match, compared in constant time. Bearer-token automation routes are exempt.
- **Dev login**:
  - `GET /api/auth/dev/users` returns seed users (email, display name, memberships summary)
  - `POST /api/auth/dev/login {email}`
  - both return 404 unless dev login is enabled for the current `APP_ENV`
- **OIDC** (openid-client 6):
  - `GET /api/auth/oidc/start?redirect=/...` (the redirect must be a relative path, so there are no open redirects) and `GET /api/auth/oidc/callback`
  - PKCE S256, state and nonce kept in `auth_flow`; validate issuer, audience, nonce and expiry
  - **browser binding, against login CSRF:**
    - `start` sets a random 32-byte cookie `bp_oidc_flow` (HttpOnly, Secure per config, SameSite=Lax, Path=`/api/auth/oidc`, Max-Age 600) and stores its SHA-256 as `browser_binding_hash`
    - `callback` rejects the request unless that cookie is present and matches the flow found by `state` (constant-time compare)
    - consuming the flow is atomic: `UPDATE … SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()`, which must return 1 row
    - the cookie is cleared after the callback
  - map users by `(provider='entra', issuer, sub)`, also storing `tid` and `oid`
  - an unknown identity without a valid invitation is denied with "account not provisioned", and the denial is audited
  - with an invitation token from `auth_flow`, the invitation's email must match the token's verified `email` or `preferred_username` (case-insensitive); then link the identity, activate the membership and apply the invitation's role assignments
  - MFA is recorded at login: `user_session.mfa_satisfied = (amr includes 'mfa')`. Dev-login sessions always have `mfa_satisfied = false`.
  - MFA is enforced **per request, not just at login**. When `AUTH_REQUIRE_MFA_FOR_PRIVILEGED=true` (default `true` in uat and production, `false` in development and test), a session with `mfa_satisfied = false` doesn't get the **privileged permissions**: `member.invite`, `member.manage`, `member.sessions.revoke`, `role.manage`, `company.bank.manage`, `automation.manage`, `service_identity.manage`, `store.manage` and `integration.manage`. It also doesn't get platform-owner capabilities.
    - These permissions are removed when the request context is built, so a user promoted mid-session can't use the new privileges until they sign in again with MFA.
    - `/context` returns `mfaStepUpRequired: true` with the withheld permissions so the UI can prompt for re-authentication.
    - Document in STATUS that the Entra v2 claim behaviour is still to verify (U2).
  - tests run against `oauth2-mock-server` (npm) started inside the integration test, and cover:
    - happy path
    - wrong state
    - wrong nonce
    - replayed callback (`auth_flow` already consumed)
    - **callback opened with a different cookie jar or with no `bp_oidc_flow` cookie fails**
    - an unprovisioned identity
    - a non-MFA session whose user is promoted to company admin can't use `member.manage` until they log in again with `amr: ['mfa']`
- `POST /api/auth/logout` revokes the session and clears the cookies.
- `GET /api/me` returns the user, their **authorised companies** (active memberships; platform owners get all active companies) and the session's expiry.

### B3. Authorisation and tenancy

- A global guard enforces deny by default. A route must carry either `@Public()` or `@RequirePermission(perm, { scope?: resolverFn })`. A route with neither returns 500 at boot. Add a startup self-check that walks all routes and fails if any lacks both.
- `CompanyContextGuard` on `/api/c/:companyId/*`:
  - validate the uuid
  - load the active membership (suspended or removed memberships, or a disabled user, mean "not a member")
  - non-members get a **404**, with an audited denial
  - build `RequestContext { userId | serviceIdentityId, companyId, grants[], isPlatformOwner, correlationId }`
- Permission checks:
  - company-level permissions are checked in the guard
  - store-scoped checks go through resource resolvers: the order's `store_id` is resolved under RLS, then checked with `can()`; out of scope gives 404
  - list endpoints filter by permitted scopes (for example, a store-scoped `order.view` filters `store_id IN (...)`)
- Service identities, on `/api/automation/v1/c/:companyId/*` only:
  - header `Authorization: Bearer bps_<id>.<secret>`; look up by id, compare the hash in constant time, then check status, expiry and that the identity's company equals the URL company (otherwise 404)
  - permissions come from the identity's own list
  - update `last_used_at` at most once a minute
  - cookies are never accepted on automation routes, and bearer tokens never on staff routes
- Endpoints (all audited, all tested):
  - `GET /api/c/:companyId/context`: company summary, my permissions and scopes, enabled switches (read-only view)
  - `GET /api/c/:companyId/members` (`member.view`)
  - `POST /api/c/:companyId/invitations` (`member.invite` plus `canGrant` for every role assignment); returns the invitation link **once**; there is no email sending in Phase 1, so the link is shown to the admin
  - `PATCH /api/c/:companyId/members/:membershipId` (`member.manage`): roles and status, applying the escalation rules (no self-modification, no targeting platform owners, no last-admin lockout); suspending a membership revokes that user's sessions **if they have no other active membership**, otherwise only access to this company stops (on the next request, automatically)
    - **Serialisation:** every membership, role-assignment or invitation-acceptance change runs in one transaction that first takes `SELECT … FROM company WHERE id = $1 FOR UPDATE`. Under that lock it re-checks that the **acting** membership is still active and still has the permission, then checks the last-`member.manage` invariant, then writes. Two admins suspending each other concurrently must leave at least one active admin.
  - `POST /api/c/:companyId/members/:membershipId/revoke-sessions` (`member.sessions.revoke`)
  - `GET /api/c/:companyId/roles` (`member.view`)
  - `GET /api/c/:companyId/audit-events` (`audit.view`): filters for object type/id, action, actor, outcome and date range; paginated
  - `GET /api/c/:companyId/service-identities`, `POST` (`service_identity.manage`; automation-only permissions such as `store.events.ingest` are grantable by any holder of `service_identity.manage`; ordinary permissions must be held by the creator; returns the token once), `DELETE /:id` (revoke)
  - Platform, owner only: `GET /api/platform/companies`, `POST /api/platform/companies` (creates the company, copies role templates, adds example tax codes, sets switches false), `PUT /api/platform/switches/outbound.all`
- `AuditService.record(...)` is called inside the same transaction as the change wherever possible. Denials are recorded in their own transaction. `details` passes through a redactor.

### Step B acceptance (integration tests against real Postgres as bp_app)

1. The full dev-login flow, `/me` and company list. multi@example.test sees A and B; admin.b sees only B.
2. admin.b requesting `/api/c/<A>/members` gets 404 and an audited denial. Guessed member ids of A under `/api/c/<B>/members/<A-member-id>` give 404.
3. A suspended membership is denied at once, while the same session still works for that user's other company. A revoked session gives 401.
4. Escalation: admin.a can't grant platform owner (no such permission), can't modify their own roles, and can't remove the last member holding `member.manage`. An ops manager can't invite anyone. With exactly two admins, **concurrent** mutual suspension (`Promise.all`) leaves at least one active admin, and one request fails.
5. CSRF: an unsafe request without or with a wrong `X-XSRF-TOKEN` gets 403.
6. `APP_ENV=production` with `AUTH_DEV_LOGIN_ENABLED=true` makes startup throw. A missing `APP_ENV` makes startup throw.
7. The route self-check: a test controller without a permission decorator makes boot fail.
8. Service tokens: admin.a can create a token with `store.events.ingest`, but not one with an ordinary permission admin.a lacks. A's token on B's URL gets 404; an expired or revoked token gets 401; a token can't do anything outside its permission list (403); a token can't be used on staff routes.
9. OIDC tests against the mock server (B2).
10. Audit events exist for logins, denials, invitations, role changes, suspensions and token creation, each with a correlation id.

---

## Step C: business modules (clients, catalogue, invoice drafts and PDF, orders import, transitions, documents, printing, switches, jobs)

### C1. Clients and catalogue

- `GET/POST /clients`, `GET/PATCH /clients/:id` (`client.view` / `client.manage`):
  - nested contacts and addresses
  - optimistic concurrency via `expectedVersion`; a mismatch gives 409
  - `archived` instead of delete
- `POST /clients/duplicate-check`: matches on normalised name, email or VAT within the company only.
- `GET /tax-codes`; `GET/POST/PATCH /products` (`catalog.*`, `tax.manage`).

### C2. Invoice drafts and PDF

- `POST /invoices/preview-totals` (`invoice.draft`) takes lines and returns the backend-calculated totals without persisting anything.
- `POST /invoices` and `PATCH /invoices/:id`: draft only, with `expectedVersion`.
  - The server loads tax rates from tax codes, snapshots the rate onto each line, and calculates and stores all totals plus `invoice_tax_summary`.
  - Client-sent totals are ignored (strip unknown fields).
  - The language comes from the client default, then the company default.
  - `issue_date` and `due_date` on drafts are optional; the default due date is computed in the company timezone.
- `GET /invoices`: filters for status, client, date and text. `GET /invoices/:id`.
- `GET /invoices/:id/pdf` (`invoice.view`):
  - rendered by `packages/documents` (pdfmake, Noto Sans), with bilingual labels by document language
  - seller details from the company, client details from the client, lines, the tax summary per rate, and totals
  - a large diagonal **"DRAFT – NOT A TAX INVOICE / ΠΡΟΣΧΕΔΙΟ – ΔΕΝ ΑΠΟΤΕΛΕΙ ΦΟΡΟΛΟΓΙΚΟ ΤΙΜΟΛΟΓΙΟ"** watermark
  - drafts are rendered on demand and not stored
  - response headers: `Content-Disposition: inline; filename="draft-<id>.pdf"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`
- **Issuance stays out of Phase 1**: there is no issue endpoint.

### C3. Orders import (mock Shopify contract)

- `packages/integrations/shopify`:
  - `mapShopifyOrder(payload, storeConfig)` maps a GraphQL Admin `Order` shape to the internal order upsert DTO, using the fields listed below.
  - Fixtures in `packages/integrations/shopify/fixtures/`, realistic but fictional, in the GraphQL Admin API order shape (**mark the API version the shape is modelled on as "unverified; check in Phase 2"**):
    - `order-1001-paid-greek-gift.json`: paid; local delivery; gift message `"Χρόνια πολλά, Μαρία!\n\nΜε αγάπη,\nΓιώργος & Ελένη — «καλή χρονιά»"` with a trailing space on one line; a customer note; 3 lines; Greek recipient address
    - `order-1001-updated-later.json`: same order, a later `updatedAt`, recipient phone changed
    - `order-1001-updated-earlier.json`: the stale case, an `updatedAt` before the first one
    - `order-1002-pending-international.json`: payment pending; international shipping; English gift message of 600+ characters (overflow test)
    - `order-1003-emoji-gift.json`: gift message with an emoji, which the font can't render, so it must be flagged
    - `order-2001-company-b.json`: for Company B's store
  - Field mapping:
    - `id` → `external_id`; `name` → `external_number`
    - `createdAt` and `updatedAt` → the source timestamps
    - `displayFinancialStatus` → `payment_status`, with the mapping table documented in code
    - `displayFulfillmentStatus` and `cancelledAt` → `source_status`
    - `customer`, `email` and `phone` → `customer`; `shippingAddress` → `recipient`; `billingAddress` → `billing_address`
    - `customAttributes[key ∈ store.gift_message_keys]` → `gift_message`; `note` → `customer_note`
    - `shippingLine.code` or `title` → `delivery_method` through `store.delivery_method_map`, falling back to `unknown`
    - `lineItems.nodes` → lines, with money from `shopMoney`
    - `currencyCode` → currency
- Automation endpoint: `POST /api/automation/v1/c/:companyId/store-connections/:connectionId/events` (service identity permission `store.events.ingest`, an automation-only permission; add it to the catalogue as automation-only, meaning not grantable to human roles).
  - Body: `{ eventId, topic: 'orders/create'|'orders/updated', occurredAt, payload }`.
  - Verify the connection belongs to the URL company (404 otherwise) and is active and `mock` (live mode is Phase 2).
  - Insert `integration_inbox` with `ON CONFLICT (company_id, connection_id, external_event_id) DO UPDATE SET duplicate_count = duplicate_count + 1`.
  - Return `202 { inboxId, status: 'accepted' | 'duplicate' }`.
  - The inbox insert and its `inbox.process` job (idempotency key `inbox:<inboxId>`) are written in **one transaction**, so a crash can never leave an accepted event with no job. A duplicate whose inbox row is still `received` and has no job (defensive check) gets its job re-enqueued, using the same idempotency key.
- Worker handler `inbox.process`, run inside TenantDb:
  - **Serialise per source object.** First, inside the transaction, call `pg_advisory_xact_lock(hashtextextended(connection_id || ':' || external_object_id, 0))`. Every read-compare-write below happens under that lock. Order creation uses `INSERT … ON CONFLICT (company_id, connection_id, external_id) DO NOTHING`, followed by a locked re-read. The source-field update also carries the predicate `WHERE source_updated_at < $incoming`, as a second line of defence.
  - Map the payload. If no order exists, create it with `fulfilment_status = new`, or `review_required` with a reason when `delivery_method = unknown`, the gift message has unsupported glyphs, or the payment status is unknown.
  - If the order exists and the incoming `source_updated_at` is not newer, mark the inbox row `stale` and don't touch the order.
  - If the order exists and the update is newer, update the source fields only: never `fulfilment_status`, assignment or notes.
    - A source `cancelledAt`, or a gift-message change on an order whose gift message was already printed, moves a **non-terminal** order to `review_required`, with reason `cancelled_at_source` or `gift_message_changed_after_print`.
    - **Terminal orders (`completed`, `cancelled`) never change fulfilment status on import.** The reason is appended to `attention_reasons` instead, and audited, so it's visible without reopening the order.
  - Bump `version`, audit `order.imported` or `order.source_updated`, and mark the inbox row `processed`.
- `pnpm demo:import-fixtures --company A|B`:
  1. creates (or reuses from a local gitignored file) a service identity through the API as the company admin
  2. posts the fixtures through the endpoint
  3. runs the worker drain once
  4. prints a summary

### C4. Orders API

- `GET /orders` (`order.view`, scope-filtered):
  - filters: `q` (number, customer name, email), `fulfilmentStatus[]`, `paymentStatus[]`, `storeId`, `assigned=me|none|any`, and a date range
  - sort, plus `page`/`pageSize` (max 100)
  - returns statuses separately and never collapses them
- `GET /orders/:id`: lines, notes, gift message (exact), statuses, `allowedTransitions` for this user, and the latest print jobs per document type.
- `POST /orders/:id/transitions {to, expectedVersion, reason?}`:
  - `order.transition`, and `order.cancel` when `to = cancelled`
  - the domain state machine applies
  - 409 on a version conflict, 422 with a code on a guard failure
  - audited with from/to
- `POST /orders/:id/notes` (`order.edit`).
- `POST /orders/:id/assign {userId|null, expectedVersion}`: `order.assign`, or `order.claim` when `userId` is self. The assignee must be an active member who can view this order's store.
- `GET /orders/:id/activity`: audit events for this order and its print jobs, newest first.

### C5. Documents and storage

- `packages/integrations/storage`: a `StorageAdapter` interface (`put`, `get`, `exists`) and `LocalFsStorage(root)`. Keys are generated by the server as `companies/<companyId>/<kind>/<yyyy>/<mm>/<uuid>.pdf`. Paths resolve under the root, and anything that would escape it throws.
- `packages/documents`:
  - `renderPackingSlip(order, company, lang)`: an A4 packing slip (no prices by default) showing order number, store, recipient, delivery method, items with quantities, and the gift-message presence flag
  - `renderGiftMessage(text, template)`: the exact page size from the template in mm; the font shrinks from `font_size_pt` down to `min_font_size_pt`; result `{ pdf, fits: boolean, unsupportedChars: string[] }`
  - text is drawn exactly, keeping line breaks and spaces (no trimming); check glyph coverage with fontkit `hasGlyphForCodePoint`
- `GET /orders/:id/documents/packing-slip.pdf` and `/gift-message.pdf?templateId=` (`document.download`, scope-checked) render a preview; `Cache-Control: no-store`.
- `GET /gift-message-templates` and `PATCH /gift-message-templates/:id` (`company.manage`).
- `GET /files/:id` (`document.download` or `invoice.view` depending on the kind): the lookup goes through RLS first, then the stream comes from storage.

### C6. Printing (mock provider) and jobs

- `packages/integrations/printing`: a `PrintProvider` interface:
  - `listPrinters(account)`
  - `submit({ printerExternalId, pdf, copies, paperSize, title, idempotencyKey })`, which returns `{ providerJobId }` or throws typed errors (`PrinterOffline`, `ProviderRejected`, `ProviderTimeout`)
  - `getJobState(providerJobId)`
- `MockPrintProvider`, **clearly labelled "Simulated — no physical printing" in code, API responses (`provider: 'mock'`) and UI**:
  - behaviour depends on the printer: online, offline or timeout
  - writes the PDF it would have printed to `var/mock-print-output/<companyId>/<printJobId>.pdf` (gitignored), so humans can inspect it
  - job state moves `submitted` → `done_reported` on the next status refresh
- `POST /print-requests {documentType, sourceType:'order', sourceId, copies?, printerId?, reprint?: {ofPrintJobId, reason}}`:
  - permissions: `print.submit`, or `print.reprint` with a reason of at least 5 characters
  - check the order is in scope
  - resolve the printer from the mapping and validate copies (1–5) and paper size against the printer
  - render the document now, store it as a `stored_file`, and record `source_version = order.version`
  - in one transaction, insert the `print_job` (status `queued`, `idempotency_key = 'pj_' || print_job.id`, which is sent to the provider as its idempotency key) and a `job` (`print.submit`, idempotency key `print.submit:<printJobId>`). Duplicate first prints are blocked by the partial unique index, not by the idempotency key.
  - a first print that would break the partial unique index gives 409 `already_printed` with the existing job id
  - the gift-message document is refused if `fits = false` or `unsupportedChars` is not empty: 422 `gift_message_needs_review`
- Worker `print.submit`:
  1. **Re-check switches at execution time**: global `outbound.all` and the company's `printing`. If either is off, set the print job to `held` and the job to `held`, and audit it.
  2. **Re-validate the requester at execution time.** The requesting user must still be active with an active membership. They must still hold `print.submit` (or `print.reprint` for reprints) covering the order's store, and the order must still exist. If not, set the print job to `failed`, with `last_error = 'requester_no_longer_authorised'`, and audit it. Held jobs released later are re-validated against the **releaser** as well as the requester.
  3. **Claim atomically:** `UPDATE print_job SET status = 'submitting' WHERE id = $1 AND status = 'queued' RETURNING …`. If no row comes back (for example, it was cancelled meanwhile), stop without calling the provider and mark the queue job `cancelled`. The provider is called only after winning this transition.
  4. Call the provider under the job timeout.
     - success: `submitted`, store `provider_job_id`, enqueue `print.refresh_status` after 2 s
     - `PrinterOffline` or `ProviderRejected`: `failed`
     - `ProviderTimeout` or an unknown error after the request was sent: `uncertain`, **with no retry**
  5. Audit every outcome.
- Worker `print.refresh_status` maps the provider state to `delivered_to_printer` or `done_reported`. **`done_reported` is never shown as "printed".**
- `POST /print-jobs/:id/confirm {outcome:'printed'|'not_printed'}` (`print.confirm`).
- `POST /print-jobs/:id/release` (`automation.replay`): held → queued, re-enqueued, audited.
- `POST /print-jobs/:id/cancel`: only from queued, held or uncertain, as one atomic conditional update (`… WHERE status IN ('queued','held','uncertain')`). Because the worker can only call the provider after winning `queued → submitting`, a successful cancel guarantees no submission. If the job is already `submitting` or later, the cancel returns 409.
- `GET /print-jobs?sourceId=&status=` (`print.submit` or `automation.view`).
- `GET /printers`, `POST /printers/discover` (`printer.manage`; for mock, it upserts the mock printers), `PUT /printer-mappings` (`printer.manage`).
- Job runner (`automation` module):
  - claim loop with `FOR UPDATE SKIP LOCKED`, a lease of `locked_until` (60 s) and a heartbeat
  - per-type concurrency limits (`print.submit` 2, `inbox.process` 4, `pdf` 2)
  - exponential backoff for handlers flagged `retryable`
  - graceful shutdown on SIGTERM: stop claiming and finish or release current leases
  - expired leases are reclaimed and their attempts counted; a non-retryable handler whose lease expired goes to `uncertain`
- Switches API:
  - `GET /automation/switches` (`automation.view`)
  - `PUT /automation/switches/:key {enabled, reason}` (`automation.manage`; reason required; audited)
  - `GET /automation/jobs?status=` (`automation.view`)

### C7. Credential vault (implemented and tested, used by nothing live yet)

- `CredentialVault.encrypt(companyId, provider, label, plaintext)` and `decrypt(id)`: AES-256-GCM through `node:crypto`, with AAD = `companyId|provider|credentialId` and `APP_MASTER_KEYS` = JSON `{ "k1": "<base64 32 bytes>" }` plus `APP_MASTER_KEY_ACTIVE=k1`.
- Tests: round trip; tampered ciphertext, tag or AAD fails; a different company's AAD fails; rotation to k2 re-encrypts; plaintext never appears in logs (logger spy).

### Step C acceptance (integration tests)

1. **Isolation sweep.** For every new company-scoped endpoint (clients, products, invoices, PDFs, orders, documents, files, print requests, print jobs, switches, jobs, service identities), requests made as admin.b with A's object ids give 404. List endpoints never include another company's rows. The automation import with A's token on B's connection gives 404.
2. **Scope.** fulfil.a can list and view only Nutbox Demo Shopify orders. A PrestaShop-store order gives **404**, because it's outside fulfil.a's scope. fulfil.a gets **403** on `/invoices` and `/invoices/:id`, because a permission miss inside their own company gives 403 (rule 6 in the permission matrix).
3. **Totals.** A draft created through the API for each worked example E1–E9 stores exactly the documented totals. Sending fake totals has no effect. JSON numbers in money fields give 400.
4. **PDF.** The invoice draft PDF contains the client name, a Greek client name and the watermark text (extracted with `pdfjs-dist` in tests). The gift-message PDF has page size 148 × 105 mm (± 0.5 pt) and its text extraction equals the stored message, line breaks included. The 600-character message shrinks or flags `fits=false` per the template. The emoji message reports `unsupportedChars`.
5. **Import.**
   - The same event twice gives one order and `duplicate_count = 1`.
   - The later update changes the phone and bumps the version.
   - The earlier (stale) update leaves the order untouched and the inbox row `stale`.
   - A source cancellation moves the order to `review_required`.
   - A stored gift message equals the fixture string byte-for-byte (compare UTF-8 buffers).
   - Unknown delivery gives `review_required`.
   - **Concurrency:** process the create, T2 and T3 events for the same order concurrently, in every arrival order. The result is always exactly one order holding T3's data, with the older events marked `stale` or processed in order.
   - **Atomic enqueue:** a failure injected after the inbox insert rolls back the inbox row too, so redelivery is `accepted`, not `duplicate`.
   - **Terminal orders:** a source cancellation or gift-message change on a `completed` or `cancelled` order leaves `fulfilment_status` unchanged and appends to `attention_reasons`.
6. **Transitions.** new → preparing → ready works for a paid order. Ready on a pending order gives 422 `payment_not_settled`. A stale `expectedVersion` gives 409. Two concurrent transitions: exactly one succeeds.
7. **Printing.**
   - The first print is queued → submitted → done_reported, and the mock output file exists.
   - A second first print gives 409 `already_printed`.
   - 10 concurrent first-print requests produce exactly 1 job.
   - A reprint without `print.reprint` gives 403; with it and a reason, a new job with `is_reprint` is audited.
   - The offline printer gives `failed`.
   - The flaky printer gives `uncertain` with exactly one provider submit call and no auto-retry.
   - If the switch is turned off **after** queueing and before the worker runs, the job ends up `held` and the provider is never called. Release after re-enabling then prints.
   - Company B's printing is off, so B's jobs go to `held`.
   - **First-print identity:** print the gift message, then import a newer event that changes only the recipient phone (bumping the order version), then request another first print. The result is 409 `already_printed`.
   - **Requester revoked:** queue a print as fulfil.a, suspend fulfil.a's membership, then run the worker. The job is `failed` with `requester_no_longer_authorised`, and the provider is never called.
   - **Cancel race:** run cancel and worker claim concurrently, repeated many times. Either the cancel succeeds and the provider is never called, or the worker wins and the cancel returns 409. Never both.
8. **Audit.** Every action above has an audit event with a correlation id. The order activity endpoint shows import, transitions, notes and prints.

---

## Step D: web app (Angular 22 + PrimeNG 22)

- Standalone components, signals, the `provideHttpClient(withXsrfConfiguration({cookieName:'XSRF-TOKEN', headerName:'X-XSRF-TOKEN'}))` setup, and the dev-server proxy `/api` → `http://localhost:3000`.
- Aura theme preset (PrimeNG's own; no third-party paid themes or icon packs; PrimeIcons is MIT). Responsive layout: a top bar with the **company switcher** (only authorised companies, from `/api/me`) and user menu, and a side nav filtered by the permissions from `/context`. The UI hides what the user can't do, while the backend still enforces it.
- i18n with Transloco (`@jsverse/transloco`). English is complete; the Greek file covers the shell and order screens. The language switch is stored per user (`user_account.locale`, `PATCH /api/me`).
- Dates use a `companyDate` pipe (Intl with the company timezone, with a DST-correct test). Money is formatted from decimal strings without converting to float for display: format the string with grouping and keep the full precision.
- Screens:
  1. Login: a "Sign in with Microsoft" button, shown when OIDC is configured, and a dev-login user picker, visible only when `/api/auth/providers` says it's enabled, with a red "DEVELOPMENT LOGIN — fictional users" banner.
  2. Orders list: PrimeNG Table with lazy pagination, filters (status chips, store, payment, assigned) and search. Payment, fulfilment and integration statuses appear as separate tags. "Review required" is highlighted with its reason.
  3. Order detail:
     - customer and recipient, items, the three statuses separately, delivery method
     - the gift message in a bordered box with `white-space: pre-wrap` (text binding only, never innerHTML) and a "Preview at print size" button that opens the PDF
     - notes (add) and assignment (claim, or assign)
     - transition buttons from `allowedTransitions`, plus a version-conflict toast with reload
     - a print panel per document type showing the latest job status with honest labels. Examples: "Sent to printer (provider reported done — not confirmed)", "Uncertain — check the printer before reprinting". It offers confirm-printed and not-printed actions, a reprint dialog that requires a reason, and the label "Simulated printer" when the provider is mock.
     - an activity timeline
  4. Clients: list, create/edit form (organisation/individual, contacts, addresses) and a duplicate warning before save.
  5. Invoices: list, and a draft editor (client, language, tax-inclusive toggle, line editor with product picker, quantity, price, discount and tax code). Totals come from `preview-totals` (debounced) and are never computed in the browser. Save draft, open the draft PDF.
  6. Admin:
     - members: list, invite (shows the link once), change roles, suspend/reactivate, revoke sessions
     - automation: switches with required reason, jobs table, print jobs with release and cancel
     - audit log: filterable table
     - printers: list, discover (mock), mappings
  7. Forbidden and not-found pages, plus an error toast with the correlation id.
- Tests: component tests for the money formatting, the companyDate pipe, the gift-message display (keeps line breaks and doesn't render HTML) and permission-based nav. Playwright e2e (`apps/web-e2e`) against the dev stack:
  - admin.a logs in, switches company (not possible to B), opens order #1001, sees the exact gift message, moves it to ready, prints the packing slip, sees the simulated status, and sees the activity
  - fulfil.a can't see the Invoices nav, and a direct URL gives the forbidden page
  - finance.a creates a client and a draft invoice with E4 lines and sees total 20.23
- Accessibility basics: labelled form controls, keyboard-reachable actions, and colour not used as the only status cue.

### Step D acceptance

- `pnpm build` produces the web bundle. No secrets or env values appear in the bundle (grep test in CI for `bps_`, `APP_MASTER`, `postgres://`).
- Playwright flows pass locally against `pnpm dev`.

---

## Step E: production-like stack, milestone verification, documentation

- **Dockerfiles** for `apps/api` (one image with `api` and `worker` commands) and `web` (Caddy serving the static build and proxying `/api`):
  - multi-stage, `node:24.22.0-alpine`, `pnpm deploy --prod` (or the Nx-pruned lockfile)
  - non-root user, `HEALTHCHECK`, no dev dependencies
  - `NODE_ENV=production`, with `APP_ENV` from env
- **`infra/compose/compose.prod.yml`** (provider-neutral VPS):
  - services `caddy` (ports 80/443 only), `api`, `worker`, `migrate` (one-shot `prisma migrate deploy` as bp_owner; `api` and `worker` depend on it with `service_completed_successfully`), `postgres` (no published ports), `n8n`, `n8n-runner` (no public route; the editor is reached through `127.0.0.1:5678` plus an SSH tunnel)
  - networks `edge` (caddy, api) and `internal` (api, worker, postgres, n8n, runner); postgres and n8n are not on `edge`
  - named volumes: postgres, documents storage, n8n data, caddy data
  - `deploy.resources.limits` memory and CPU for each service, sized for about 8 GB total; document the numbers
  - healthchecks, `restart: unless-stopped`, `stop_grace_period` for the worker, and log rotation (`json-file` max-size)
  - secrets come from env files outside the repo (`/opt/business-platform/env/*.env`), documented in `.env.example` sections
- `infra/caddy/Caddyfile`:
  - app domain from env; HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and a CSP for the SPA
  - `/api/*` → api
  - only `/api/webhooks/*` and the OIDC callback are needed publicly besides the app
  - no n8n routes
- `infra/compose/compose.local.yml`, an override for running the prod stack on this Mac:
  - `APP_ENV=development` with dev login enabled
  - Caddy `tls internal` on `https://localhost:8443`
  - secrets from a gitignored `.env.local-stack` generated by `pnpm setup:env --local-stack`
- **Milestone script** `tools/milestone/verify.ts` (`pnpm milestone:verify [--phase=initial|after-restart]`) runs against `https://localhost:8443`, accepting the local CA:
  - **initial**: performs the full milestone flow (acceptance items 1–10) through the HTTP API, plus the isolation checks:
    - admin.b gets 404 on A's order, invoice, PDF, file and print job
    - fulfil.a gets 403 on invoices and 404 on the PrestaShop order
    - A's service token gets 404 on B's connection
    - the suspended user is denied
    - logged out gives 401
  - writes ids to `var/milestone-state.json`
  - **after-restart**: re-logs in and checks that the client, draft invoice (totals unchanged), order, gift message bytes, `ready` status, print job and audit events all still exist
  - outputs a PASS/FAIL table
- **Runbook** `docs/runbooks/local-stack.md`: build images, run `up`, migrate, seed, import fixtures, run verify, `docker compose restart`, then verify with `--phase=after-restart`. The planner runs this and records the real output in `docs/milestones/m1-report.md`.
- **Docs to complete:**
  - `README.md` (setup and commands)
  - `docs/runbooks/vps-deployment.md` (draft: DNS, firewall incl. Docker port publishing caveat, SSH keys, n8n tunnel, deploy/rollback by image tag, certificate renewal by Caddy, moving to another VPS)
  - `docs/runbooks/backup-restore.md` (design plus Phase 5 TODO: encrypted off-site `pg_dump` for both DBs, documents volume, n8n encryption key, master keys stored separately; proposed RPO 24 h and RTO 8 h; not implemented in Phase 1, say so)
  - `docs/integrations/printnode.md` and `shopify.md` (what the mock covers vs what Phase 2 must verify)
  - `docs/security/asvs-checklist.md` with the P1 chapters' evidence filled in where tests exist
  - `docs/STATUS.md`

### Step E acceptance

- The images build. `compose.prod.yml` + `compose.local.yml` come up healthy. `milestone:verify` passes in both phases around a full `docker compose restart`. Only Caddy publishes ports beyond loopback (check with `docker compose ps` and `lsof`).
- The m1 report is committed with real output.
