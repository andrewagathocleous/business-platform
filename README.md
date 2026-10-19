# business-platform

Business apps, integrations, and automation workflows.

## Local foundation

Node 24.22.0 (`nvm use`), pnpm via corepack, and Docker through Colima.

```bash
pnpm install
pnpm setup:env
pnpm dev:infra
pnpm db:migrate
pnpm db:seed
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

`pnpm dev:infra` starts Postgres on `127.0.0.1:5432` and n8n on `127.0.0.1:5678`. The API and web app are later steps. `apps/api` currently builds as a marked stub.
