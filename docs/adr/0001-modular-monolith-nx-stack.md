# ADR-0001: Modular monolith on Nx, Angular, NestJS, PostgreSQL and Prisma

- Status: accepted
- Date: 2026-10-19

## Context

The platform serves a small team (2–3 staff), will grow to more companies, and must run cheaply on one VPS. The maintainer is fluent in TypeScript, Angular, NestJS, Nx, SQL and Docker. The repository was empty apart from a README and the brief.

## Decision

- One Nx 23 workspace with pnpm: `apps/api` (NestJS 12), `apps/web` (Angular 22 + PrimeNG 21.1.10) and `packages/*` for domain, db, documents and integrations. PrimeNG 22 and later is under the commercial PrimeUI licence, so the web app stays on 21.1.10, the last MIT release, with `@primeuix/themes` 2.0.3 (Aura) and PrimeIcons 7.0.0.
- Node 24 LTS. Angular 22 requires Node `^24.15` and TypeScript `>=6.0 <6.1`, so the workspace pins TypeScript 6.0.x, not 7.x.
- PostgreSQL 18 with Prisma 7.10.x (the `prisma-client` generator and `@prisma/adapter-pg`). On 2026-10-19, npm's `latest` tag for `prisma` pointed at an 8.0 release candidate, so we pin the stable 7.10.x line explicitly.
- Validation and contracts use zod 4, shared from `packages/domain`. `nestjs-zod` generates OpenAPI.
- Vitest is the single test runner (Angular's default; Nest through SWC).
- API and worker share one image with different entrypoints.
- No microservices, Kubernetes, Kafka or Redis.

## Consequences

- One deployable unit plus n8n, simple local development, and shared types between web and API.
- Module boundaries have to be enforced by convention and Nx tags (`@nx/enforce-module-boundaries`) rather than by process boundaries.
- Version alignment matters. Angular, Nx and TypeScript upgrades move together and are validated before any production upgrade.
