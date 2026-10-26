# AGENTS.md — business-platform

Project rules for every coding agent (Claude Code, Cursor CLI, Codex CLI) working in this repository.
From the machine-wide `~/.agents/AGENTS.md`, the planner → implementer → reviewer roles and the git rules apply here. Its Heroku and Linear rules do not: this project uses neither.

## Read first

1. `docs/STATUS.md`: what is actually implemented, verified, mocked or blocked. Update it when you finish a step.
2. `docs/BACKLOG.md`: the prioritised backlog by phase.
3. `docs/architecture.md`: modules, data flows, where credentials live, and the main assumptions.
4. `docs/plan/` has the step plan for the phase in progress. Implement exactly what the current step says. If the plan looks wrong, say so; don't improvise.
5. The original product brief is `business-platform-claude-prompt.txt`. It is the long-term product direction.

## Toolchain

- Node 24 LTS (`.nvmrc`), with pnpm via corepack. Run `nvm use` first: the machine default is Node 16, which will not work.
- Nx monorepo: `apps/api` (NestJS), `apps/web` (Angular + PrimeNG), and `packages/*` (domain, db, documents, integrations).
- PostgreSQL through `infra/compose/compose.dev.yml` (Colima/Docker locally). Integration tests need it running.
- Common commands (see README for the full list): `pnpm dev:infra`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm build`.

## Non-negotiable engineering rules

- **Tenant isolation:** every company-scoped query runs through the tenant-context database helper, which sets `app.company_id` for the transaction so Postgres RLS applies. Company context comes from the URL and is verified against an active membership; a company id supplied by a client is never trusted on its own. Return 404 rather than 403 for objects in another company.
- **Deny by default:** every API route declares a permission (`@RequirePermission`) or is explicitly `@Public()`. The global guard rejects any route that does neither.
- **Money:** use `decimal.js` through `packages/domain/money` only, never JS `number` for amounts. Totals are calculated on the backend and never trusted from the client. The rounding rules are in `docs/finance/rounding.md`.
- **Audit:** every state-changing action and every authorisation denial writes an `audit_event` with actor, company, action, object, outcome and correlation id. The application never updates or deletes audit rows.
- **Outbound safety:** prints, sends, publishes, store writes, shipments and real invoice issuance check the automation switches at execution time, not just when queued. All of them are off by default.
- **Uncertain outcomes:** never blindly retry an external side effect after a timeout or ambiguous response. Mark it `uncertain` and require reconciliation or human review.
- **No fake success:** mock providers are clearly labelled as mocks in code, UI and docs. Never present a mock or placeholder integration as finished.
- **Fictional data only:** seed data uses `.test` email domains and clearly fictional companies. Never invent real legal-company details, VAT numbers or credentials.
- **Secrets:** never in code, Git, logs, docs, URLs or frontend bundles. Only `.env.example` with placeholders is committed. Logs redact cookies, authorisation headers, tokens and credential payloads.
- **Gift messages and customer text:** store them byte-for-byte (Greek, line breaks, punctuation). Never rewrite, trim internal whitespace or "normalise" them.
- **Time:** store timestamps as UTC `timestamptz`. Display and compute business dates (invoice issue date, due date) in the company's IANA timezone (default `Asia/Nicosia`).

## Testing expectations

- Domain logic (money, tax, state machines, permissions) has unit tests that cover edge cases.
- Anything involving authorisation, RLS, concurrency, idempotency or deduplication has integration tests against real Postgres, not mocks.
- Say which level a capability was tested at: mock-tested, sandbox-tested or live-tested.

## Review speed rules

**Status: on** (adopted 2026-10-23 at the user's request). To switch back, set the status to **off** or delete this section. With the rules off, the machine-wide defaults apply again: every review finding blocks, the implementer makes every change, and every review runs at `xhigh`. These rules apply to this repository only.

**Severity.** The reviewer labels every finding:

- **P0:** a security hole (authentication bypass, a tenant leak, an exposed secret), data loss or corruption, wrong money or tax, a side effect that can happen twice (print, send, publish), or a broken backup or restore.
- **P1:** a bug a user would hit in normal use, or a violation of the current plan's acceptance criteria.
- **P2:** a rare edge case with low impact, or hardening.

**Rules.**

1. **Blocking.** Only P0 and P1 findings block a step. A P2 finding is fixed in the same round only when the fix is small (about 10 lines) and in a file the round already changes. Otherwise it goes to `docs/BACKLOG.md` with the finding text, so nothing is dropped.
2. **Strict areas.** In these areas every finding blocks, P2 included, and the planner does not edit code directly:
   - authentication and sessions;
   - authorisation and tenant isolation (RLS);
   - money, tax and invoice issuance;
   - outbound safety (switches, never printing or sending twice, uncertain outcomes);
   - credentials and secrets;
   - backups and restore.
3. **Planner edits.** The planner may make a change directly, instead of a full implementer round, when it is about 10 changed lines or fewer outside the strict areas, or documentation only. The next review covers those edits.
4. **Review effort.** `xhigh` when the diff touches a strict area; `high` for everything else (tooling, scripts, docs, screens with no permission logic).

## Git

- Work on `develop`. Agents push only `develop`, and only when the user asks.
- Code is promoted `develop` → `main` (Staging) → `deploy_uat` (UAT) → `deploy_prod` (PROD). The user does each promotion; it is a deliberate release action. The live laptop builds only `deploy_prod`.
- Never commit `.env*` (except `.env.example`), generated PDFs, backups, n8n credential exports or real customer data.
