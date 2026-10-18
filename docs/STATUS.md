# Implementation status

Last updated: 2026-10-19 (Phase 0 complete; Phase 1 step A starting).

Test levels:
- **unit**: domain logic in isolation.
- **integration**: real Postgres as `bp_app`.
- **e2e**: browser.
- **mock-tested**: against a mock provider.
- **sandbox-tested**: against the provider's official test environment.
- **live-tested**: against a real account.

## Current phase

Phase 1, step A (see `docs/plan/phase-1.md`).

## Done

| Item | Evidence |
|---|---|
| Branches `develop`, `deploy_uat`, `deploy_prod` created from `main` and pushed | `git branch -a` |
| Phase 0 docs: architecture, ADRs 0001–0007, permission matrix, threat model, ASVS tracker, rounding rules, source-of-truth matrix, provider constraints (n8n verified 2026-10-19), workflow catalogue, backlog, Phase 1 plan | `docs/` |
| Local toolchain: Node 24.22.0 (nvm), Colima + Docker 29.5 + Compose 5.6 | — |

## In progress

| Item | Notes |
|---|---|
| P1-A | not started |

## Mocked or blocked

| Capability | State | Blocked by |
|---|---|---|
| Staff login via Entra | Phase 1 tests OIDC against a mock provider only | U2 (tenant access) |
| Store sync | mock import contract only | U3, U4 |
| Printing | mock provider only | U6 |
| Invoice issuance | not in Phase 1 | U1 (accountant validation) |

## Known risks

- Angular 22 pins TypeScript 6.0.x. TypeScript 7 (the native compiler) is out but can't be used yet.
- Prisma's npm `latest` tag points at an 8.0 RC, so 7.10.x is pinned explicitly.
- The machine's default Node is 16. Always `nvm use` (`.nvmrc`).

## Next step

Implement step A. The planner verifies it, Codex reviews it, fixes are applied, then it's committed on `develop`.
