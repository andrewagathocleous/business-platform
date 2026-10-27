#!/usr/bin/env bash
# Export workflows from the dev n8n container and strip secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="${1:-$ROOT/workflows/n8n/exports}"
COMPOSE=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/compose.dev.yml")
"${COMPOSE[@]}" exec -T n8n n8n export:workflow --all --separate --output=/tmp/bp-workflow-export
rm -rf "$OUT"
mkdir -p "$OUT"
"${COMPOSE[@]}" cp n8n:/tmp/bp-workflow-export/. "$OUT/"
node "$ROOT/workflows/n8n/scripts/sanitize.mjs" "$OUT"
