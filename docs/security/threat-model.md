# Threat model

Version 0.1, 2026-10-19 (Phase 0). Reviewed at every phase end and before production. This document claims no security guarantee. It lists what we defend against, how, and what is still open.

## Assets

1. Customer personal data: names, addresses, phone numbers, emails, gift messages.
2. Financial records: invoices, numbering continuity, payments, bank details.
3. Integration credentials: store tokens, PrintNode, Graph, Brevo, Meta, LinkedIn, plus the vault master key.
4. Staff identities, sessions and privileges.
5. The ability to cause external side effects: printing, emails, publishing, store writes, shipments.
6. Audit trail integrity.
7. Availability of order processing on a single VPS.

## Trust boundaries

- Browser ↔ Caddy ↔ API (internet)
- Store, Graph and Brevo webhooks → API public routes (internet, unauthenticated until the signature is verified)
- n8n ↔ API automation routes (internal network, service tokens)
- API/worker ↔ Postgres (internal, roles `bp_app` and `bp_owner`)
- Worker → external providers (internet, credentials from the vault)
- Admins → n8n editor and SSH (private access only)
- Untrusted content: emails, customer-entered text, attachments, retrieved media, AI output (later)

## Threats and mitigations

| ID | Threat (STRIDE) | Mitigation | Phase | Status |
|---|---|---|---|---|
| T1 | Cross-company data access via guessed IDs (I) | URL company plus membership check; RLS forced for `bp_app`; 404 on foreign objects; integration tests with guessed IDs on list, get, download, print and automation routes | 1 | tested: `apps/api/src/isolation.integration.test.ts` `returns 404 when admin.b sends company A object ids to every company-scoped route`; `apps/api/src/tenancy.integration.test.ts` `gives another company 404 and audits the denial`; `packages/db/src/rls.integration.test.ts` `shows only the current company, including to the table owner when context is set` |
| T2 | Privilege escalation by company admin (E) | platform owner flag isn't a permission; grant-subset rule; no self-modification; tests | 1 | tested: `apps/api/src/tenancy.integration.test.ts` `refuses a grant the actor does not hold and audits a role change` and `lets only a platform owner suspend the last member.manage holder`; `packages/domain/src/authz/evaluate.test.ts` `refuses a grant when the actor is missing a permission or only holds a narrower scope` |
| T3 | Session theft or fixation (S) | HttpOnly, Secure, SameSite cookies; new token issued at login; only the hash stored; idle and absolute expiry; revocation; CSRF tokens | 1 | planned |
| T4 | Dev login enabled in production (S/E) | startup refuses dev login when `APP_ENV` is `uat` or `production`, and refuses a missing `APP_ENV`; test | 1 | planned |
| T5 | Forged webhooks or replayed events (S/T) | HMAC over the raw body with a constant-time compare; timestamp/event-id dedupe in the inbox; out-of-order detection | 1 (mock) / 2 | planned |
| T6 | Leaked or overpowered automation token (E) | per-company, per-purpose service identities; permission subset; expiry; hash only; revocation; last-used tracking | 1 | planned |
| T7 | Credential disclosure via logs, API or backups (I) | vault encryption with the master key outside the DB; log redaction; responses show only "configured"; no secrets in the frontend | 1 | planned |
| T8 | Duplicate external side effects such as double prints or sends (T) | intent persisted first; idempotency keys; `uncertain` state instead of blind retry; reprint permission plus reason | 1 | planned |
| T9 | Invoice number reuse or tampering (T/R) | atomic allocation under a row lock; unique `(company, series, number)`; immutable snapshots with DB triggers; credit-note corrections | 3 | designed |
| T10 | Audit log tampering (R) | `bp_app` has no UPDATE or DELETE on `audit_event`, plus a trigger; independent off-site backups; hash chain in the backlog. A DB table is not called tamper-proof | 1 | planned |
| T11 | SSRF via store URLs, media or PDF retrieval (I/E) | outbound HTTP client with an allowlist of schemes, DNS resolution, private and link-local range blocking, redirect re-validation, size and time limits | 2 | backlog |
| T12 | Malicious email HTML or attachments (T/I) | sanitised HTML (DOMPurify server-side); remote images blocked; attachment type and size limits; downloads served as attachments with `nosniff` | 3 | backlog |
| T13 | CSV formula injection in exports (T) | prefix `= + - @ \t \r` cells with `'`; tests | 3 | backlog |
| T14 | Path traversal in storage (T/I) | server-generated keys only; the storage adapter resolves and verifies paths under its root | 1 | planned |
| T15 | XSS in the staff UI (T) | Angular auto-escaping; no `innerHTML` with untrusted data; strict CSP; gift messages shown as text with `white-space: pre-wrap` | 1 | planned |
| T16 | n8n editor compromise leading to broad access (E) | editor never public; n8n holds no business-data provider credentials; env and file access blocked in nodes; dangerous nodes excluded; external runners; least-privileged DB user | 1 | planned |
| T17 | Prompt injection via emails or content (E) | AI features later only: structured outputs, no tool permissions from content, approval before external effects | 4 | backlog |
| T18 | Exposed DB or n8n ports on the VPS (I) | Compose binds internal services to private networks, dev ports to 127.0.0.1 only; firewall test including the Docker iptables bypass | 1 / 5 | planned |
| T19 | Loss of the VPS or data (D) | encrypted off-site backups with separate credentials; restore drill; RPO/RTO targets | 5 | backlog |
| T20 | Dependency or container vulnerabilities (T/E) | lockfile; CI audit, secret scanning (gitleaks) and image scanning (Trivy, later); pinned images; patch schedule | 1 / 5 | planned |
| T21 | Login abuse or brute force (S/D) | rate limits on auth routes; Entra handles credentials and MFA; invitation expiry | 1 | planned |
| T23 | Login CSRF: victim's browser completes the attacker's OIDC flow (S) | flow bound to a browser cookie (hash in `auth_flow`); atomic single-use consumption; tests with a foreign cookie jar | 1 | planned |
| T24 | Privilege use from a non-MFA session after a mid-session promotion (E) | MFA evaluated per request; privileged permissions withheld from sessions with `mfa_satisfied = false` | 1 | planned |
| T25 | Queued action runs after the requester lost access (E) | the worker re-validates the requester's membership, permission and scope at execution | 1 | planned |
| T26 | Races that break invariants: last-admin lockout, stale import overwrite, cancel vs submit (T) | company row lock for membership changes; advisory lock per source object plus conditional updates; atomic state-claim updates; concurrency tests | 1 | planned |
| T22 | Wrong-company email sending (T) | prominent sender selector; per-mailbox send permission; server-side check that the sender belongs to the current company | 3 | backlog |

## Residual risks (accepted for now)

- A single VPS means downtime during maintenance or failures. It is not highly available.
- Application-level bugs inside one company's scope (for example, a missing scope check for store-scoped roles) aren't caught by RLS. They rely on tests.
- n8n Community has no RBAC or projects, so anyone with editor access is fully trusted.
- PrintNode "done" doesn't prove paper was printed, so staff confirmation is needed.
