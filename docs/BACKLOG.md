# Backlog

Prioritised, by phase. IDs are stable; reference them in commits and in STATUS. Detailed plans live in `docs/plan/phase-N.md` once a phase starts.

## Phase 1: foundation and Milestone 1 (plan: `docs/plan/phase-1.md`)

| ID | Item | Step |
|---|---|---|
| P1-A | Workspace, infra (Postgres, n8n + runner), schema, RLS, domain package, seed, CI | A |
| P1-B | API core: config, security middleware, sessions, dev login, OIDC (mock-tested), authorisation, tenancy endpoints, audit, service identities | B |
| P1-C | Clients, catalogue, invoice drafts + PDF, mock Shopify import contract, orders and transitions, documents, mock printing, jobs, switches, credential vault | C |
| P1-D | Angular staff app | D |
| P1-E | Production-like Compose, Dockerfiles, Caddy, milestone verification, runbooks, M1 report | E |
| P1-F | First production platform owner. `compose.prod.yml` has no seed and no dev login. A fresh production database has no staff user. Not implemented | blocked before a real deploy |
| P1-G | Break-glass recovery runbook named by ADR-0004. The runbook does not exist. Not implemented | blocked before a real deploy |

## Phase 2: stores, printing and Nutbox operations

| ID | Item | Blocked by |
|---|---|---|
| P2-01 | Verify the Shopify app path, scopes, protected customer data and API version; record in provider-constraints | U3 |
| P2-02 | Shopify read-only connector: GraphQL client (versioned), cost-based throttling, pagination, token handling; products, orders, customers import | P2-01 |
| P2-03 | Shopify webhooks to the app: raw-body HMAC verification, inbox, reconciliation job for missed events | P2-02 |
| P2-04 | PrestaShop: detect the installed version, Webservice client, polling with `date_upd` checkpoints, overlap and dedupe | U4 |
| P2-05 | SSRF-safe outbound HTTP client (DNS and private-range checks, redirect re-validation); required by P2-02 and P2-04 | — |
| P2-06 | PrintNode real provider: account setup, printer discovery, idempotency header, state polling or webhooks, PDF delivery (base64), test print with approval | U6 |
| P2-07 | Courier workflows: Svelta/EasyCourier and Cyprus Post (verify APIs, else export plus manual tracking entry); keep label creation, handover and completion distinct; customs data validation for international | U5 |
| P2-08 | n8n W1 (order import notifications) and W2 (ready → documents → print) exports, mock fixtures, import verified against 2.43.7 | P2-03 |
| P2-09 | Integration health dashboard (connections, last sync, inbox failures, token expiry) | P2-02 |
| P2-10 | Order "assigned-only" view mode for stricter fulfilment roles (A2) | — |
| P2-11 | Gift-message template tuning with the real card stock and tray (U7); a physical test print needs explicit approval | U7 |

## Phase 3: invoicing and receivables, Microsoft 365

| ID | Item | Blocked by |
|---|---|---|
| P3-01 | Review EU/Cyprus invoice requirements (mandatory fields, simplified invoices, credit notes, retention); configurable rules; accountant sign-off checklist | U1 |
| P3-02 | Issuance: atomic numbering under a row lock, immutable snapshot, issued PDF stored with a hash; concurrency tests | P3-01 for real use |
| P3-03 | Quotes → invoice conversion; credit notes and corrections | P3-02 |
| P3-04 | Payments: record, partial, allocation, over-allocation prevention; outstanding balances | P3-02 |
| P3-05 | Overdue views, statements, reminders (controlled sending) | P3-04, P3-08 |
| P3-06 | Per-store invoice authority enforcement (one tax invoice per sale) | P3-02 |
| P3-07 | Receivables reports (issued, collected, unpaid, ageing; cash vs invoiced labelled) and accountant export | P3-04 |
| P3-08 | Microsoft Graph: app registration, Exchange RBAC for Applications scoping, authorised mailbox set, sync (delta and subscriptions plus polling fallback), threads, assignment, sanitised HTML, attachments | U2 |
| P3-09 | Sending: sender selector, per-mailbox send permission, signatures, wrong-company safeguard, Send As vs Send on Behalf verified | P3-08 |
| P3-10 | Approval centre: approvals bound to content version, company, recipients, destination and amount; invalidated on change; rechecked at execution | — |
| P3-11 | n8n W3 (invoice issued → send) and W4 (mailbox event → match) | P3-09, P3-10 |
| P3-12 | Client CSV import/export with formula-injection protection | — |

## Phase 4: marketing, social, optional AI

| ID | Item |
|---|---|
| P4-01 | Brevo contacts and lists sync with consent provenance and suppression that always wins |
| P4-02 | Brevo campaigns: draft, preview, approved test send, schedule, approved send, events |
| P4-03 | Meta and LinkedIn: verify access paths and app review; connect approved pages and accounts; mark unavailable features honestly |
| P4-04 | Content calendar, media library, channel previews, draft/review/approve/schedule/publish states, publish history |
| P4-05 | AI provider adapter (optional): cost limits, structured outputs, no tool permissions from content, human approval before publication |
| P4-06 | n8n W5 |

## Phase 5: hardening and rollout

| ID | Item |
|---|---|
| P5-01 | Encrypted off-site backups (both DBs, documents, n8n key, master keys stored separately), retention, restore drill on a clean VPS, recorded RPO/RTO |
| P5-02 | Monitoring: uptime, disk and memory, job queue depth, failed workflows, token expiry, backup failures; actionable notifications |
| P5-03 | VPS provider selection (U8), provisioning scripts (optional), firewall and exposure test, SSH hardening |
| P5-04 | Full ASVS L2 evidence pass, threat-model refresh, dependency, image and secret scans, optional pen test |
| P5-05 | Performance checks on the target VPS size; PDF and media concurrency limits |
| P5-06 | UAT on `deploy_uat`, staged production rollout on `deploy_prod`; deployment as a deliberate release action |
| P5-07 | Recovery runbooks: lost VPS, compromised credential, broken deployment, PrintNode PC unavailable |
| P5-08 | Audit hash-chain or external anchoring for tamper evidence |

## Later

Supplier purchasing, inventory synchronisation (needs an ownership design first), expenses, recurring billing, customer portal (separate auth), more couriers, WhatsApp Business, advanced reporting, general ledger, bank feeds and reconciliation, payroll, statutory reporting.
