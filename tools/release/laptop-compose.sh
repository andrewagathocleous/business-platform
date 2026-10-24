#!/usr/bin/env bash
# docker compose for the live laptop stack (R0-E), using the image tag of the release
# this script belongs to. ~/business-platform/current points at the running release.
#
#   ~/business-platform/current/tools/release/laptop-compose.sh ps
#   ~/business-platform/current/tools/release/laptop-compose.sh --profile ops run --rm owner-cli list
#
# --wait-docker (first argument) waits up to five minutes for Docker, for the login agent.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release="$(cd "$here/../.." && pwd -P)"
BP_HOME="${BP_HOME:-$HOME/business-platform}"

wait_docker=0
if [[ "${1:-}" == "--wait-docker" ]]; then
  wait_docker=1
  shift
fi

release_file="$release/RELEASE"
if [[ ! -f "$release_file" ]]; then
  echo "laptop-compose: $release_file is missing; run this from an unpacked release" >&2
  exit 2
fi
tag="$(sed -n 's/^tag=//p' "$release_file")"
if [[ ! "$tag" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "laptop-compose: $release_file has no valid tag" >&2
  exit 2
fi

env_dir="$BP_HOME/env"
if [[ ! -d "$env_dir" ]]; then
  echo "laptop-compose: $env_dir is missing; run laptop-env.sh first" >&2
  exit 2
fi

if ((wait_docker)); then
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      break
    fi
    sleep 5
  done
fi

export BP_IMAGE_TAG="$tag"
export BP_ENV_DIR="$env_dir"
exec docker compose \
  -p business-platform-live \
  -f "$release/infra/compose/compose.prod.yml" \
  -f "$release/infra/compose/compose.laptop.yml" \
  "$@"
