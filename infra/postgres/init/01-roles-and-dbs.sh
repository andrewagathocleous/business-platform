#!/bin/sh
# Runs once, when the Postgres data directory is first created.
# The same SQL is infra/postgres/roles.sql. CREATEDB is on here so Prisma can
# create its shadow database. CI passes bp_owner_createdb=off.
set -eu

if [ -z "${BP_OWNER_PASSWORD:-}" ] || [ -z "${BP_APP_PASSWORD:-}" ] || [ -z "${N8N_DB_PASSWORD:-}" ]; then
  echo "BP_OWNER_PASSWORD, BP_APP_PASSWORD and N8N_DB_PASSWORD are required" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v bp_owner_password="$BP_OWNER_PASSWORD" \
  -v bp_app_password="$BP_APP_PASSWORD" \
  -v n8n_password="$N8N_DB_PASSWORD" \
  -v bp_owner_createdb="${BP_OWNER_CREATEDB:-on}" \
  -f /opt/business-platform/roles.sql
