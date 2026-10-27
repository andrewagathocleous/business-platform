#!/usr/bin/env bash
# Creates the env files for the live laptop (R0-E) with fresh random secrets.
# Run once on the laptop. It never prints a secret and never overwrites an existing file.
#
#   tools/release/laptop-env.sh
#
# Writes $BP_HOME/env (default ~/business-platform/env), directory 0700, files 0600.
# The Entra values stay `replace-me` until you edit api.env; the API refuses to start
# in production with a placeholder.
set -euo pipefail
umask 077

BP_HOME="${BP_HOME:-$HOME/business-platform}"
env_dir="$BP_HOME/env"

mkdir -p "$BP_HOME"
# One run at a time: mkdir is atomic, so a second run stops here instead of racing.
lock="$BP_HOME/.laptop-env.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "laptop-env: another run holds $lock; if none is running, remove it and try again" >&2
  exit 1
fi
trap 'rmdir "$lock"' EXIT

if [[ -d "$env_dir" ]] && [[ -n "$(ls -A "$env_dir")" ]]; then
  echo "laptop-env: $env_dir already has files; nothing was changed" >&2
  exit 1
fi
mkdir -p "$env_dir"
chmod 700 "$env_dir"

hex() {
  openssl rand -hex 32
}

postgres_password="$(hex)"
owner_password="$(hex)"
app_password="$(hex)"
n8n_db_password="$(hex)"
n8n_encryption_key="$(hex)"
runner_token="$(hex)"
csrf_secret="$(hex)"
master_key="$(openssl rand -base64 32)"

# printf is a shell builtin, so the values never appear in a process listing.
# noclobber: an existing file is never overwritten.
write() {
  local file="$env_dir/$1"
  shift
  (
    set -o noclobber
    printf '%s\n' "$@" >"$file"
  )
  chmod 600 "$file"
}

write postgres.env \
  "POSTGRES_USER=postgres" \
  "POSTGRES_PASSWORD=$postgres_password" \
  "POSTGRES_DB=postgres" \
  "BP_OWNER_PASSWORD=$owner_password" \
  "BP_APP_PASSWORD=$app_password" \
  "N8N_DB_PASSWORD=$n8n_db_password"

write migrate.env \
  "DATABASE_URL_OWNER=postgresql://bp_owner:$owner_password@postgres:5432/business_platform"

write api.env \
  "APP_ENV=production" \
  "DATABASE_URL=postgresql://bp_app:$app_password@postgres:5432/business_platform" \
  "CSRF_SECRET=$csrf_secret" \
  "APP_MASTER_KEYS={\"k1\":\"$master_key\"}" \
  "APP_MASTER_KEY_ACTIVE=k1" \
  "OIDC_ISSUER=replace-me" \
  "OIDC_CLIENT_ID=replace-me" \
  "OIDC_CLIENT_SECRET=replace-me" \
  "OIDC_REDIRECT_URI=https://localhost:8443/api/auth/oidc/callback" \
  "STORAGE_ROOT=/var/lib/business-platform/storage" \
  "MOCK_PRINT_ROOT=/var/lib/business-platform/mock-print" \
  "AUTH_DEV_LOGIN_ENABLED=false" \
  "SESSION_COOKIE_SECURE=true" \
  "AUTH_REQUIRE_MFA_FOR_PRIVILEGED=true" \
  "HOST=0.0.0.0" \
  "PORT=3000"

write n8n.env \
  "DB_POSTGRESDB_PASSWORD=$n8n_db_password" \
  "N8N_ENCRYPTION_KEY=$n8n_encryption_key" \
  "N8N_RUNNERS_AUTH_TOKEN=$runner_token"

write n8n-runner.env \
  "N8N_RUNNERS_AUTH_TOKEN=$runner_token"

echo "laptop-env: wrote postgres.env, migrate.env, api.env, n8n.env and n8n-runner.env to $env_dir."
echo "laptop-env: no value was printed."
echo "Next:"
echo "  1. In $env_dir/api.env, replace OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET with the Entra values."
echo "  2. Copy APP_MASTER_KEYS (api.env) and N8N_ENCRYPTION_KEY (n8n.env) into your password manager."
