# Architecture

Status: Phase 0 baseline, written 2026-10-19. Material decisions are recorded as ADRs in `docs/adr/`.

## 1. Shape

A **modular monolith** that a single provider-neutral Linux VPS can run with Docker Compose.

```
                 Internet (HTTPS only)
                        │
                 ┌──────▼──────┐
                 │    Caddy    │  TLS, security headers, static web app,
                 └──┬───────┬──┘  reverse proxy for /api and public webhook routes
                    │       │
       /  (static)  │       │ /api/*
     ┌──────────────▼┐   ┌──▼─────────────────────┐
     │  web (Angular │   │ api (NestJS)           │◄──── n8n calls authenticated
     │  + PrimeNG)   │   │ HTTP API, auth, RBAC,  │      automation APIs (service
     └───────────────┘   │ domain services        │      identities, company-scoped)
                         └──┬──────────────────┬──┘
                            │ same image       │
                         ┌──▼─────────────┐    │
                         │ worker (NestJS │    │
                         │ app context)   │    │
                         │ jobs / outbox, │    │
                         │ provider calls │    │
                         └──┬─────────────┘    │
                            │                  │
                 ┌──────────▼──────────────────▼──┐      ┌──────────────────────┐
                 │ PostgreSQL                      │      │ n8n Community        │
                 │  db business_platform (RLS)     │◄────►│ (+ external task     │
                 │  db n8n (own least-priv. user)  │      │  runner sidecar)     │
                 └─────────────────────────────────┘      │ editor: private only │
                                                          └──────────────────────┘
       Private document storage: volume behind StorageAdapter (S3-compatible later)
```

- **api**: owns business state, validation, money, permissions, approvals, invoice numbering and audit. It serves `/api/*`.
- **worker**: the same codebase and image, started with a different entrypoint. It claims durable jobs from Postgres (`FOR UPDATE SKIP LOCKED`), performs provider calls and records results. It runs separately so slow PDFs or providers never block HTTP requests.
- **web**: the staff application, a static Angular build served by Caddy.
- **n8n**: orchestration only (schedules, triggers, branching, notifications). It changes business state solely by calling authenticated application APIs, never by writing to business tables. Only trusted technical administrators can reach its editor, through an SSH tunnel or VPN, never on a public route.
- **PostgreSQL**: one cluster with separate databases and roles for the application and for n8n.

## 2. Repository layout

```
apps/api              NestJS HTTP API (main.ts) and worker entrypoint (main.worker.ts)
apps/web              Angular staff application (PrimeNG)
packages/domain       Pure TypeScript: money/tax, invoice totals, order state machine,
                      permission catalogue and role templates, shared zod contracts
packages/db           Prisma schema, migrations (including raw-SQL RLS), client factory, seed
packages/documents    PDF rendering (invoices, packing slips, gift messages), fonts
packages/integrations Provider adapters behind interfaces: printnode, shopify,
                      prestashop, storage, plus clearly labelled mock implementations
workflows/n8n         Sanitised workflow exports, import/export scripts, fixtures
infra/compose         compose.dev.yml, compose.prod.yml, compose.local.yml
infra/caddy           Caddyfile, Caddyfile.local, app.caddy
infra/docker          api.Dockerfile, web.Dockerfile
infra/postgres        roles.sql and init/01-roles-and-dbs.sh
docs/                 Architecture, ADRs, security, finance rules, integrations, runbooks
```

## 3. Module boundaries (backend)

| Module | Owns | Phase |
|---|---|---|
| identity | users, identities (OIDC/dev), sessions, invitations, MFA policy | 1 |
| tenancy | legal companies, brands, stores, locations, memberships, roles, scopes | 1 |
| authz | permission evaluation, guards, escalation rules | 1 |
| audit | append-only audit events, activity timelines | 1 |
| clients | client organisations/individuals, contacts, addresses, duplicate detection | 1 |
| catalog | products/services, tax codes | 1 |
| invoicing | quotes, drafts, issuance and numbering, credit notes, payments, statements | 1 (drafts) / 3 |
| orders | unified orders, lines, notes, assignment, operational state machine | 1 |
| fulfilment | delivery method, courier export, tracking, handover | 2 |
| documents | PDF generation, templates, stored files, downloads | 1 |
| printing | printers, mapping, print jobs, PrintNode adapter | 1 (mock) / 2 |
| integrations | store connections, inbox/outbox, sync checkpoints, credential vault | 1 (mock) / 2 |
| automation | service identities, switches, job queue, replay | 1 |
| approvals | approval requests bound to content versions | 3–4 |
| mail | Microsoft Graph mailboxes, threads, send-as | 3 |
| marketing / social | Brevo, Meta, LinkedIn | 4 |

Modules talk to each other through exported services. Never reach into another module's tables. Domain rules live in `packages/domain`, or in module services with tests, and never in n8n Code nodes.

## 4. Tenancy and access control

See ADR-0003 and `docs/security/permission-matrix.md`.

- **Entities:** a *legal company* is the tenant boundary (invoices, VAT, bank details). *Brands*, *stores* and *locations* belong to a company and are not separate legal entities by default. *Clients* (customer organisations or individuals) and their *contacts* belong to a company.
- **Memberships:** a user has a per-company membership with its own status and role assignments, so the same person can be finance in A and auditor in B. A role is a configurable bundle of permissions. An assignment can be company-wide or scoped to a store, location, mailbox or integration account.
- **Request flow:**
  1. Session cookie → user.
  2. URL `/api/c/:companyId/...` → active membership check.
  3. Load permissions.
  4. `@RequirePermission` check, including scope against the resource.
  5. The tenant-context transaction sets `app.company_id` for RLS.
  6. Business logic.
  7. Audit.
- **Defence in depth:** Postgres RLS on every company-scoped table, enforced for the runtime role `bp_app` (not the owner, no `BYPASSRLS`). Migrations run as `bp_owner`. A query issued without tenant context matches no rows.
- **Platform owner:** a flag on the user account, set only by seed or CLI and never through the API. Company admins cannot grant it, and cannot grant permissions they don't hold themselves.
- **Service identities:** n8n and other automation authenticate with company-scoped, permission-limited, hashed, expiring bearer tokens. There is no single all-powerful token.

## 5. Authentication

See ADR-0004.

- **Staff:** Microsoft Entra ID through OIDC (Authorization Code + PKCE, state, nonce). Staff without Microsoft 365 licences get an unlicensed cloud-only account or a B2B guest in the same tenant, so Entra handles MFA for everyone and the platform stores no passwords. MFA is enforced at the tenant (Security Defaults or Conditional Access), and the app also checks it for privileged roles where Entra exposes it in token claims. The exact claim is still to be verified (see Unknowns).
- **Sessions:** server-side. An opaque 256-bit token goes in an HttpOnly, Secure, SameSite=Lax cookie, and only its SHA-256 hash is stored. Sessions have idle and absolute expiry and can be revoked per session, per user (on suspension or role change) or globally.
- **CSRF:** Angular's XSRF cookie/header pair, bound to the session, checked on every unsafe method.
- **Dev login:** a fictional-user picker. It only works when `APP_ENV` is `development` or `test` and `AUTH_DEV_LOGIN_ENABLED=true`. The API refuses to start with dev login enabled under `APP_ENV=uat` or `production`. Images always run with `NODE_ENV=production`; `APP_ENV` is what governs security toggles.
- **Customers:** customer registration and portal are separate future work with a different cookie and audience. Staff accounts are invitation-only, with no self-registration.

## 6. Data and money

See ADR-0006 and `docs/finance/rounding.md`.

- PostgreSQL 18, Prisma 7 (with the `pg` driver adapter) and versioned migrations. Raw-SQL migrations hold RLS policies, grants and immutability triggers.
- Money is `numeric` in Postgres and `decimal.js` in code, with deterministic rounding documented and tested. The API carries amounts as decimal strings and never as JSON numbers.
- Timestamps are `timestamptz` in UTC. Business dates are computed in the company's IANA timezone.
- Issued financial documents (Phase 3) are immutable snapshots. Corrections go through credit notes. Numbers are allocated atomically per company and series at issuance.

## 7. Jobs, inbox and outbox

See ADR-0005.

- Durable `job` table in Postgres, claimed with `FOR UPDATE SKIP LOCKED`, with bounded retries, backoff, timeouts, a `held` state and correlation ids. Redis is added only if a measured need appears.
- **Inbound:** every external event lands in `integration_inbox` with a unique `(connection_id, external_event_id)`. Processing is idempotent, and out-of-order updates are detected by comparing the source `updated_at`.
- **Outbound side effects** (print, send, publish, write-back): job intent is persisted first along with an idempotency key. The automation switches are checked at execution time. An ambiguous result becomes `uncertain`, never an automatic retry.

## 8. Where credentials live, and who calls providers

See ADR-0007. Provisional; confirmed per integration when it is built.

| Integration | Credential location | Makes provider calls | Notes |
|---|---|---|---|
| Entra OIDC (staff login) | API env/secret file (client id and secret, or certificate) | api | |
| Shopify Admin API | app credential vault (encrypted, per connection) | worker | n8n triggers sync through the app API |
| Shopify webhook secret | app credential vault | api (verifies HMAC on raw body) | |
| PrestaShop Webservice key | app credential vault | worker | polling with durable checkpoints |
| PrintNode API key | app credential vault (per company/account) | worker | |
| Microsoft Graph (mail) | app credential vault (app registration, scoped with Exchange RBAC for Applications) | worker | Phase 3 |
| Brevo API key | app credential vault | worker | Phase 4 |
| Meta / LinkedIn tokens | app credential vault (refresh tracked) | worker | Phase 4 |
| n8n → app service tokens | n8n credential store (header auth), only the hash in the app DB | n8n | one per company and purpose |
| n8n notification channels | n8n credential store | n8n | low-risk notifications only |
| Credential-vault master key | VPS secret file or env, outside the DB and backups of the DB | api/worker | backed up separately |

Business-data connectors live in the application, not n8n. n8n Community has no projects or credential sharing, so it can't isolate credentials per company, and connector logic in the app can be tested, typed and gated by switches. n8n still owns orchestration: triggers, schedules, branching and notifications.

## 9. Environments

- **Branches:** `develop` (integration), `deploy_uat` (UAT release) and `deploy_prod` (production release). Assumption: `main` mirrors the last production release.
- **dev:** local. Postgres and n8n run in Compose; api and web run on the host with hot reload; fictional seed data.
- **test/CI:** a disposable Postgres; migrations plus a role-setup script.
- **uat/prod:** VPS Compose stacks with images built in CI or locally (never on the small VPS), separate credentials and data, and deployment as a deliberate release action.

## 10. Assumptions

| # | Assumption | Why it matters | Revisit when |
|---|---|---|---|
| A1 | Staff can sign in through one Entra tenant, including unlicensed or guest accounts for non-M365 staff | removes the need for local passwords and MFA | Entra tenant access confirmed |
| A2 | "Fulfilment can view assigned orders" means orders in the stores/locations they are scoped to. A stricter assigned-only mode is in the backlog | permission design | user feedback |
| A3 | A single VPS with about 8 GB RAM, not highly available | sizing, monitoring, recovery | provider selected |
| A4 | `main` mirrors production releases; work happens on `develop` | git flow | user feedback |
| A5 | Prices default to tax-inclusive for retail stores and tax-exclusive for B2B invoices, configurable per document | totals | accountant review |
| A6 | Store-issued invoices are not authoritative until configured per store (`invoice_authority = undecided` blocks platform issuance for that store's orders) | prevents double tax invoices | per-store decision |
| A7 | UI language defaults to English, with Greek UI translations progressive. Documents and customer text fully support Greek from day one | i18n scope | |

## 11. Essential unknowns (non-blocking for Phase 1)

| # | Unknown | Blocks | Owner |
|---|---|---|---|
| U1 | Real legal-company details, VAT registration, invoice series in use, whether store invoices are authoritative today | real invoicing (R2) | user + accountant |
| U2 | Entra tenant: admin access, licences, whether Security Defaults or Conditional Access are available; how MFA shows up in ID token claims | real staff login (R0) | user |
| U3 | Shopify app type and access (custom app in the admin vs dev dashboard app), protected customer data approval, historical order access | Shopify read-only sync (R3) | user |
| U4 | Answered 2026-10-23: PrestaShop 1.7.7.2, PHP 7.3.33, MariaDB 10.6.19, LiteSpeed shared hosting, Webservice enabled, gift message is the built-in field. Still open: the GET-only key and the shop timezone, set at the R1 live check | PrestaShop reader (R1) | user |
| U5 | Svelta/EasyCourier and Cyprus Post ePost: account access, API availability, export formats | courier workflows (R4) | user |
| U6 | PrintNode account/plan, and the shop PC's availability schedule | real printing (R1) | user |
| U7 | Gift-message card stock size and printer tray setup on the HP LaserJet M209dw | gift-message template defaults (R1) | user |
| U8 | VPS provider, domain/DNS, off-site backup destination | deployment (R0) | user |
| U9 | Brevo plan, sender domains; Meta/LinkedIn app review status | marketing and social (R6) | user |
