# OWASP ASVS 5.0, Level 2-oriented checklist

Version 0.1, 2026-10-19. This is a **chapter-level** tracker. Item-level mapping (each `V#.#.#` with evidence) is a Phase 1 exit task for the chapters marked *P1* and a pre-production gate for all chapters. Status values are `not started`, `in progress`, `evidence: <test/file>`, `n/a (reason)` and `gap (reason)`.

| Chapter | Focus for this platform | Target phase | Status | Evidence |
|---|---|---|---|---|
| V1 Encoding and Sanitization | Angular escaping, parameterised SQL (Prisma), safe HTML for email, CSV formula injection | P1 / P3 | not started | |
| V2 Validation and Business Logic | zod at every boundary, money validation, state-machine transitions, approval binding | P1 | not started | |
| V3 Web Frontend Security | CSP, security headers, cookie flags, no secrets in bundles | P1 | not started | |
| V4 API and Web Service | deny-by-default routes, OpenAPI, content types, rate limits | P1 | not started | |
| V5 File Handling | private storage, generated keys, type and size limits, attachment downloads | P1 / P3 | not started | |
| V6 Authentication | Entra OIDC, MFA policy, invitation-only accounts, dev-login guard, break-glass account | P1 | not started | |
| V7 Session Management | server-side sessions, rotation, idle and absolute timeouts, revocation | P1 | not started | |
| V8 Authorization | RBAC with scopes, RLS, escalation rules, guessed-ID tests | P1 | not started | |
| V9 Self-contained Tokens | Entra ID token validation only; service tokens are opaque | P1 | not started | |
| V10 OAuth and OIDC | PKCE, state, nonce, issuer and audience checks; provider OAuth for Shopify, Graph, Meta and LinkedIn | P1 / P2–4 | not started | |
| V11 Cryptography | AES-256-GCM vault via `node:crypto`, key separation, rotation | P1 | not started | |
| V12 Secure Communication | TLS through Caddy, HSTS, internal network segmentation | P1 / P5 | not started | |
| V13 Configuration | env validation at startup, no default secrets, hardened containers, n8n hardening | P1 / P5 | not started | |
| V14 Data Protection | data minimisation, retention, export and deletion, log redaction | P3 / P5 | not started | |
| V15 Secure Coding and Architecture | dependency scanning, module boundaries, SSRF-safe HTTP client | P1 / P2 | not started | |
| V16 Security Logging and Error Handling | audit events, correlation ids, no stack traces to clients, alerting | P1 | not started | |
| V17 WebRTC | n/a (no WebRTC) | — | n/a | |

## Pre-production review plan (Phase 5)

1. Complete the item-level evidence for all chapters, with gaps explicitly accepted or fixed.
2. Re-run the threat model with the integrations as actually built.
3. Dependency, image and secret scans with no unresolved high or critical findings.
4. External exposure test from the internet: only 80/443 open; the n8n editor and DB unreachable.
5. Restore drill on a clean VPS, with the results recorded.
6. Optional independent penetration test before onboarding any company the owner doesn't operate.
