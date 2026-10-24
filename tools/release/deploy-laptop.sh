#!/usr/bin/env bash
# Deploys one release on the live laptop (R0-E).
#
#   ./deploy-laptop.sh bp-<tag>.tar
#
# 1. Checks bp-<tag>.tar against bp-<tag>.tar.sha256 next to it.
# 2. Unpacks it to $BP_HOME/releases/<tag> (default ~/business-platform).
# 3. Checks the env files exist and hold no `replace-me`.
# 4. Loads the images.
# 5. With existing data, runs the release's backup first and stops if it fails.
# 6. Runs migrate and starts the stack (`up -d --wait`), then checks /api/health/ready.
# 7. Points $BP_HOME/current at the release and prints the running tag.
# It never prints an env value.
set -euo pipefail

usage() {
  echo "usage: ./deploy-laptop.sh bp-<tag>.tar" >&2
  exit 2
}

bundle="${1:-}"
[[ -n "$bundle" && -f "$bundle" ]] || usage
bundle_dir="$(cd "$(dirname "$bundle")" && pwd -P)"
bundle_file="$(basename "$bundle")"
name="${bundle_file%.tar}"
[[ "$bundle_file" == "$name.tar" && "$name" =~ ^bp-[A-Za-z0-9._-]{1,64}$ ]] || usage
tag="${name#bp-}"

sum_file="$bundle_dir/$bundle_file.sha256"
if [[ ! -f "$sum_file" ]]; then
  echo "deploy: $bundle_file.sha256 is missing next to the bundle" >&2
  exit 1
fi
# The sidecar must be exactly one line, for exactly this file name.
sum_line="$(cat "$sum_file")"
sum_pattern='^([0-9a-f]{64})  (.+)$'
expected=""
if [[ "$sum_line" != *$'\n'* && "$sum_line" =~ $sum_pattern && "${BASH_REMATCH[2]}" == "$bundle_file" ]]; then
  expected="${BASH_REMATCH[1]}"
fi
if [[ -z "$expected" ]]; then
  echo "deploy: $bundle_file.sha256 must hold one SHA-256 line for $bundle_file" >&2
  exit 1
fi
actual="$(shasum -a 256 "$bundle_dir/$bundle_file" | cut -d ' ' -f 1)"
if [[ "$actual" != "$expected" ]]; then
  echo "deploy: $bundle_file does not match its SHA-256; not deploying" >&2
  exit 1
fi

BP_HOME="${BP_HOME:-$HOME/business-platform}"
releases="$BP_HOME/releases"
release="$releases/$tag"
mkdir -p "$releases"
# Unpack into a private staging directory and check it fully before it is installed,
# so a rejected bundle never leaves a release behind for a retry to reuse.
unpack="$(mktemp -d "$releases/.unpack.XXXXXX")"
trap 'rm -rf "$unpack"' EXIT
tar -xf "$bundle_dir/$bundle_file" -C "$unpack"
staged="$unpack/$name"
if [[ ! -d "$staged" || -L "$staged" ]]; then
  echo "deploy: $bundle_file has no $name directory" >&2
  exit 1
fi
if [[ -n "$(find "$unpack" -type l -print -quit)" ]]; then
  echo "deploy: $bundle_file contains a symbolic link; not deploying" >&2
  exit 1
fi
if [[ "$(find "$unpack" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" != "1" ]]; then
  echo "deploy: $bundle_file has more than the $name directory at its top" >&2
  exit 1
fi
if [[ ! -f "$staged/RELEASE" ]] || ! grep -qxF "tag=$tag" "$staged/RELEASE"; then
  echo "deploy: $bundle_file does not hold a RELEASE file for tag $tag" >&2
  exit 1
fi
if [[ -e "$release" ]]; then
  # No link anywhere in the installed copy (diff -r would follow one), and the same files.
  if [[ -L "$release" || -n "$(find "$release" -type l -print -quit)" ]] ||
    ! diff -r -q "$staged" "$release" >/dev/null; then
    echo "deploy: $release already exists with other contents; not deploying" >&2
    exit 1
  fi
  echo "deploy: release $tag is already unpacked with the same contents"
else
  mv "$staged" "$release"
fi

env_dir="$BP_HOME/env"
for file in postgres.env migrate.env api.env n8n.env n8n-runner.env; do
  if [[ ! -f "$env_dir/$file" ]]; then
    echo "deploy: $env_dir/$file is missing; run $release/tools/release/laptop-env.sh first" >&2
    exit 1
  fi
done
placeholders="$(grep -l 'replace-me' "$env_dir"/*.env || true)"
if [[ -n "$placeholders" ]]; then
  echo "deploy: these env files still contain replace-me (fill the Entra values first):" >&2
  echo "$placeholders" >&2
  exit 1
fi

echo "deploy: loading images for $tag"
docker load -i "$release/images.tar" >/dev/null
for image in bp-api bp-web bp-migrate; do
  if ! docker image inspect "$image:$tag" >/dev/null 2>&1; then
    echo "deploy: $image:$tag was not loaded" >&2
    exit 1
  fi
done

# Fail closed: a Docker error must not be mistaken for "no data yet".
if ! existing="$(docker volume ls -q --filter name=^business-platform-live_bp_postgres$)"; then
  echo "deploy: could not list Docker volumes; not deploying" >&2
  exit 1
fi
if [[ -n "$existing" ]]; then
  backup="$release/infra/backup/laptop-backup.sh"
  if [[ ! -x "$backup" ]]; then
    echo "deploy: existing data and no backup script in this release; not deploying" >&2
    exit 1
  fi
  echo "deploy: backing up before the deploy"
  if ! "$backup"; then
    echo "deploy: the backup failed; not deploying" >&2
    exit 1
  fi
else
  echo "deploy: no existing database; this is the first deploy"
fi

compose="$release/tools/release/laptop-compose.sh"
echo "deploy: migrating and starting $tag"
"$compose" up -d --wait

if ! curl -fsSk --max-time 10 https://localhost:8443/api/health/ready >/dev/null; then
  echo "deploy: /api/health/ready did not answer; check '$compose ps' and the logs" >&2
  exit 1
fi

ln -sfn "$release" "$BP_HOME/current"
echo "deploy: running $tag"
