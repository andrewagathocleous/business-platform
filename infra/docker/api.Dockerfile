# API, worker, migrate and the local-only tools image.
# pnpm 12 deploy (not --legacy) rewrites workspace dependencies to file: dependencies
# in a dedicated lockfile. Gitignored dist is packed only when a package `files` field includes it.

FROM node:24.22.0-alpine AS base
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /src

FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY workflows/n8n/package.json workflows/n8n/package.json
RUN pnpm fetch

FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile
ENV NX_DAEMON=false
ENV CI=true
RUN pnpm --filter @bp/db generate && pnpm exec nx run-many -t build -p api
# Deploy flattens @bp/api to /opt/runtime, so the process commands are
# `node dist/main.js` and `node dist/main.worker.js`.
RUN pnpm --filter @bp/api --prod deploy /opt/runtime

# Local stack only. compose.prod.yml must never reference this target.
# Dev dependencies stay so `pnpm db:seed` and `pnpm demo:import-fixtures` can run through tsx.
# Root, because those commands write under /src/var and pnpm may touch its store. Not used in production.
FROM build AS tools
ENV NODE_ENV=development
WORKDIR /src
CMD ["pnpm", "db:seed"]

# Prisma CLI, schema, migrations and prisma.config.ts. Nothing else.
# dotenv is required by prisma.config.ts. The CLI is a devDependency of @bp/db and is installed only here.
FROM node:24.22.0-alpine AS migrate
RUN apk add --no-cache openssl
WORKDIR /opt/migrate
COPY packages/db/prisma.config.ts ./prisma.config.ts
COPY packages/db/prisma ./prisma
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund prisma@7.10.1 dotenv@18.0.8 \
  && npm cache clean --force \
  && chown -R node:node /opt/migrate
USER node
ENV NODE_ENV=production
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM node:24.22.0-alpine AS runtime
RUN apk add --no-cache openssl \
  && mkdir -p /var/lib/business-platform/storage /var/lib/business-platform/mock-print
WORKDIR /app
COPY --from=build /opt/runtime ./
# @prisma/adapter-pg belongs to @bp/db. Resolve it from that package, not from /app.
RUN node -e "const fs=require('node:fs'); const {createRequire}=require('node:module'); require('@bp/db'); createRequire(require.resolve('@bp/db'))('@prisma/adapter-pg'); const font='/app/node_modules/@bp/documents/assets/fonts/NotoSans-Regular.ttf'; if(!fs.existsSync(font)){console.error('missing Noto Sans font'); process.exit(1)} if(fs.existsSync('/app/node_modules/prisma')||fs.existsSync('/app/node_modules/.bin/prisma')){console.error('prisma CLI must not be in the runtime image'); process.exit(1)}" \
  && chown -R node:node /app /var/lib/business-platform
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
