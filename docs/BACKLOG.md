# Backlog

Prioritised. IDs are stable; reference them in commits and in STATUS. Detailed plans live in `docs/plan/` once a release starts.

On 2026-10-23 the user replaced Phases 2–5 with **separate feature releases**, so each feature can be used as soon as it is ready. The old IDs (`P2-…` to `P5-…`) are kept and regrouped under the releases. New items have release IDs (`R0-…`).

## Release order

| Release | Delivers | Plan | Waiting on the user |
|---|---|---|---|
| R0 | Go-live base on a dedicated laptop: real Microsoft sign-in, first owner, company setup, backups, recovery runbook. A server comes later | [`docs/plan/release-0.md`](plan/release-0.md) | the laptop set-up, a backup folder off the laptop, Microsoft 365 admin rights (U2) |
| R1 | PrestaShop orders read automatically, gift cards and packing slips printed through PrintNode | [`docs/plan/release-1.md`](plan/release-1.md) | PrintNode account and the shop PC (U6), card stock (U7), a read-only Webservice key (U4) |
| R2 | Invoicing: issue, numbering, credit notes, payments | not written | accountant's requirements (U1) |
| R3 | Shopify orders (4 brands) into the same order and print flow | not written | Shopify access (U3), one store or four |
| R4 | Couriers | not written | courier accounts and API answers (U5) |
| R5 | Email through Microsoft 365, approvals, reminders | not written | Entra admin access (U2) |
| R6 | Marketing and social (Brevo, Meta, LinkedIn) | not written | Meta and LinkedIn app approval (start early: weeks of waiting) |
| — | Hardening that is not tied to one release | — | — |

Each release is done when its code is reviewed and tested, it is deployed to production by image tag, its live checks are recorded in `docs/releases/rN-report.md`, the owner has turned its switches on, and STATUS says so. Production starts with every outbound switch off.

## Phase 1: foundation and Milestone 1 (plan: `docs/plan/phase-1.md`), done

| ID | Item | Step |
|---|---|---|
| P1-A | Workspace, infra (Postgres, n8n + runner), schema, RLS, domain package, seed, CI | A |
| P1-B | API core: config, security middleware, sessions, dev login, OIDC (mock-tested), authorisation, tenancy endpoints, audit, service identities | B |
| P1-C | Clients, catalogue, invoice drafts + PDF, mock Shopify import contract, orders and transitions, documents, mock printing, jobs, switches, credential vault | C |
| P1-D | Angular staff app | D |
| P1-E | Production-like Compose, Dockerfiles, Caddy, milestone verification, runbooks, M1 report | E |
| P1-F | First production platform owner. Moved to R0 | R0 |
| P1-G | Break-glass recovery runbook named by ADR-0004. Moved to R0 | R0 |

## R0: go-live base

| ID | Item | Blocked by |
|---|---|---|
| P1-F | First production platform owner: CLI enrolment plus a one-time Entra sign-in link | — |
| P1-G | Break-glass recovery runbook | P1-F |
| R0-01 | Real Entra sign-in: app registration, check the email and MFA claims the code relies on, adjust if Entra does not send them | U2 |
| R0-02 | Company setup API and screens: company details, brands, locations, stores | — |
| P5-01 | Encrypted backups off the laptop (both databases, documents), retention, restore drill before go-live, recorded RPO/RTO. Master keys kept apart from the backups. Server version when moving | — |
| R0-03 | Minimum monitoring: health, backup and disk notifications on the laptop (the rest of P5-02 is hardening) | — |
| R0-05 | Laptop host: `compose.laptop.yml` (production mode, loopback only), image export and deploy scripts, first deploy by image tag | — |
| P5-03 | Moving to a server: VPS provision, firewall and exposure test, SSH hardening. Later, when staff or Shopify webhooks need it | U8 |
| R0-04 | Go-live scans: dependency audit, image secret scan, loopback-only listener check, recorded in `docs/releases/r0-report.md` | R0-05 |

## R1: PrestaShop orders and printing

| ID | Item | Blocked by |
|---|---|---|
| P2-05 | SSRF-safe outbound HTTP client (DNS and private-range checks, redirect re-validation). Every connector uses it | — |
| R1-01 | Integration settings: PrestaShop connection and PrintNode account, keys stored in the vault, test-connection checks | P2-05 |
| P2-04 | PrestaShop 1.7.7.2 read-only reader: Webservice client, polling with `date_upd` checkpoints, overlap and dedupe, mapping into the existing import pipeline | R1-01, U4 |
| P2-06 | PrintNode real provider: discovery, idempotency header, state polling, base64 PDF, test print with approval | R1-01, U6 |
| P2-09 | Integration health (R1 part): last sync, last error, failed imports, PrintNode computer online or offline | P2-04 |
| P2-11 | Gift-card template tuning with the real card stock and tray (U7); a physical test print needs explicit approval | P2-06, U7 |
| R1-02 | Automatic printing of new gift orders. Deferred: the user chose manual printing on 2026-10-23 | — |

## R2: invoicing and receivables

| ID | Item | Blocked by |
|---|---|---|
| P3-01 | Review EU/Cyprus invoice requirements (mandatory fields, simplified invoices, credit notes, retention); configurable rules; accountant sign-off checklist | U1 |
| P3-02 | Issuance: atomic numbering under a row lock, immutable snapshot, issued PDF stored with a hash; concurrency tests | P3-01 for real use |
| P3-03 | Quotes → invoice conversion; credit notes and corrections | P3-02 |
| P3-04 | Payments: record, partial, allocation, over-allocation prevention; outstanding balances | P3-02 |
| P3-06 | Per-store invoice authority enforcement (one tax invoice per sale) | P3-02 |
| P3-07 | Receivables reports (issued, collected, unpaid, ageing; cash vs invoiced labelled) and accountant export | P3-04 |
| P3-12 | Client CSV import/export with formula-injection protection | — |
| R2-01 | Tax codes and invoice series set up through the app (today only the seed creates them) | P3-01 |

## R3: Shopify orders

| ID | Item | Blocked by |
|---|---|---|
| P2-01 | Verify the Shopify app path, scopes, protected customer data and API version; record in provider-constraints | U3 |
| P2-02 | Shopify read-only connector: GraphQL client (versioned), cost-based throttling, pagination, token handling; products, orders, customers import | P2-01 |
| P2-03 | Shopify webhooks to the app: raw-body HMAC verification, inbox, reconciliation job for missed events | P2-02 |
| R3-01 | Brand routing if the 4 brands are one Shopify store: assign each order to its brand's platform store by a tested rule | P2-02 |
| P2-08 | n8n W1 (order import notifications) and W2 (ready → documents → print) exports, mock fixtures, import verified against 2.43.7 | P2-03 |

## R4: couriers

| ID | Item | Blocked by |
|---|---|---|
| P2-07 | Courier workflows: Svelta/EasyCourier and Cyprus Post (verify APIs, else export plus manual tracking entry); keep label creation, handover and completion distinct; customs data validation for international | U5 |

## R5: email (Microsoft 365) and approvals

| ID | Item | Blocked by |
|---|---|---|
| P3-08 | Microsoft Graph: app registration, Exchange RBAC for Applications scoping, authorised mailbox set, sync (delta and subscriptions plus polling fallback), threads, assignment, sanitised HTML, attachments | U2 |
| P3-09 | Sending: sender selector, per-mailbox send permission, signatures, wrong-company safeguard, Send As vs Send on Behalf verified | P3-08 |
| P3-10 | Approval centre: approvals bound to content version, company, recipients, destination and amount; invalidated on change; rechecked at execution | — |
| P3-11 | n8n W3 (invoice issued → send) and W4 (mailbox event → match) | P3-09, P3-10 |
| P3-05 | Overdue views, statements, reminders (controlled sending) | P3-04, P3-09 |

## R6: marketing, social, optional AI

| ID | Item |
|---|---|
| R6-01 | Apply early for Meta business verification and app review, and for LinkedIn API access. This is waiting time, not build time |
| P4-01 | Brevo contacts and lists sync with consent provenance and suppression that always wins |
| P4-02 | Brevo campaigns: draft, preview, approved test send, schedule, approved send, events |
| P4-03 | Meta and LinkedIn: verify access paths and app review; connect approved pages and accounts; mark unavailable features honestly |
| P4-04 | Content calendar, media library, channel previews, draft/review/approve/schedule/publish states, publish history |
| P4-05 | AI provider adapter (optional): cost limits, structured outputs, no tool permissions from content, human approval before publication |
| P4-06 | n8n W5 |

## Hardening (not tied to one release)

| ID | Item |
|---|---|
| P5-02 | Monitoring beyond R0: job queue depth, failed workflows, token expiry |
| P5-04 | Full ASVS L2 evidence pass, threat-model refresh, dependency, image and secret scans, optional pen test |
| P5-05 | Performance checks on the target VPS size; PDF and media concurrency limits |
| P5-06 | Release process: `deploy_uat` and `deploy_prod` branches, deployment as a deliberate release action |
| P5-07 | Recovery runbooks: lost VPS, compromised credential, broken deployment, PrintNode PC unavailable |
| H-01 | Invitations still accept a `preferred_username` match when `email_verified` is not true (`invitationEmailMatches`). Owner enrolment no longer does (R0-A review, 2026-10-24). Decide at R0-G, with the real Entra claims, whether invitations should require a verified email or an expected object id too |
| H-02 | Test isolation: `orders.integration.test.ts` expects `JobRunner.drainOnce()` to process exactly 1 job, but it runs every due job in the database. When `isolation`, `company-setup` or `documents` runs first (Vitest runs failed files first on the next run), a job they left due makes it 2 and 9 orders tests fail. Clear or scope due jobs before that assertion (found 2026-10-27 while fixing CI) |
| P5-08 | Audit hash-chain or external anchoring for tamper evidence |
| P2-10 | Order "assigned-only" view mode for stricter fulfilment roles (A2) |

## Later

Supplier purchasing, inventory synchronisation (needs an ownership design first), expenses, recurring billing, customer portal (separate auth), more couriers, WhatsApp Business, advanced reporting, general ledger, bank feeds and reconciliation, payroll, statutory reporting.
