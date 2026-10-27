# Angular production build, then Caddy. The production Caddyfile is the image default.
# compose.local.yml bind-mounts Caddyfile.local over it.

FROM node:24.22.0-alpine AS web-build
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY workflows/n8n/package.json workflows/n8n/package.json
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
ENV NX_DAEMON=false
ENV CI=true
RUN pnpm exec nx build web --configuration=production

FROM caddy:2.11.7-alpine
# caddy:2.11.7-alpine has no caddy user or group. uid/gid 65532, system account, no home, no shell.
# The upstream image already grants cap_net_bind_service=+ep on /usr/bin/caddy.
# Busybox wget is already in Alpine, so the healthcheck does not install a package.
RUN addgroup -S -g 65532 caddy \
  && adduser -S -D -H -u 65532 -G caddy -s /sbin/nologin caddy
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
COPY infra/caddy/app.caddy /etc/caddy/app.caddy
COPY --from=web-build /src/dist/apps/web/browser /srv
# Upstream creates /data and /config mode 1777. chown makes a fresh named volume owned by caddy.
RUN chown -R caddy:caddy /srv /data /config /etc/caddy
USER caddy
EXPOSE 80 443
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:2019/config/
