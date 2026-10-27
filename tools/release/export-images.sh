#!/usr/bin/env bash
# Packs one release for the live laptop (R0-E), on the development Mac.
#
#   tools/release/export-images.sh <tag> [<output dir>]
#
# <tag> is the git short SHA the images were built and tagged with, and must be HEAD.
# Writes <output dir>/bp-<tag>.tar, bp-<tag>.tar.sha256 and a copy of deploy-laptop.sh.
# The tar holds images.tar (bp-api, bp-web and bp-migrate at <tag>), the RELEASE file
# and the committed files the laptop needs, taken from git (never the working tree).
# Third-party images (postgres, n8n) are pulled by the laptop at their pinned versions.
set -euo pipefail

usage() {
  echo "usage: tools/release/export-images.sh <tag> [<output dir>]" >&2
  exit 2
}

tag="${1:-}"
[[ "$tag" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
out="${2:-$root/var/releases}"
cd "$root"

head="$(git rev-parse --short HEAD)"
if [[ "$tag" != "$head" ]]; then
  echo "export: tag $tag is not HEAD ($head); build and tag the images from HEAD" >&2
  exit 1
fi
for image in bp-api bp-web bp-migrate; do
  if ! docker image inspect "$image:$tag" >/dev/null 2>&1; then
    echo "export: $image:$tag is missing; build it first" >&2
    exit 1
  fi
done

# Shipped paths, as committed at HEAD. A path not yet in git is skipped.
paths=()
for path in \
  infra/compose/compose.prod.yml \
  infra/compose/compose.laptop.yml \
  infra/caddy \
  infra/postgres \
  infra/launchd \
  infra/backup \
  infra/health \
  tools/release \
  docs/runbooks; do
  if [[ -n "$(git ls-tree HEAD -- "$path")" ]]; then
    paths+=("$path")
  fi
done

name="bp-$tag"
mkdir -p "$out"
stage="$(mktemp -d "${TMPDIR:-/tmp}/bp-export.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/$name"
git archive --format=tar HEAD -- "${paths[@]}" | tar -x -C "$stage/$name"
{
  echo "tag=$tag"
  echo "commit=$(git rev-parse HEAD)"
  echo "exported=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$stage/$name/RELEASE"
echo "export: saving bp-api, bp-web and bp-migrate at $tag"
docker save -o "$stage/$name/images.tar" "bp-api:$tag" "bp-web:$tag" "bp-migrate:$tag"

tar -cf "$out/$name.tar" -C "$stage" "$name"
(cd "$out" && shasum -a 256 "$name.tar" >"$name.tar.sha256")
# The bootstrap script comes from HEAD too, never from the working tree.
git show "HEAD:tools/release/deploy-laptop.sh" >"$out/deploy-laptop.sh"
chmod 755 "$out/deploy-laptop.sh"
echo "export: wrote $out/$name.tar, $name.tar.sha256 and deploy-laptop.sh"
echo "Copy all three to the laptop, then run: ./deploy-laptop.sh $name.tar"
