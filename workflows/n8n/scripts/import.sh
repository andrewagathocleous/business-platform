#!/usr/bin/env bash
# Import sanitised workflows into the dev n8n container.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
IN="${1:-$ROOT/workflows/n8n/exports}"
COMPOSE=(docker compose --env-file "$ROOT/.env" -f "$ROOT/infra/compose/compose.dev.yml")
"${COMPOSE[@]}" exec -T n8n rm -rf /tmp/bp-workflow-import
"${COMPOSE[@]}" cp "$IN/." n8n:/tmp/bp-workflow-import
"${COMPOSE[@]}" exec -T n8n n8n import:workflow --separate --input=/tmp/bp-workflow-import
