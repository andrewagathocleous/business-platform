#!/usr/bin/env bash
# Builds the three release images on the development Mac, tagged with HEAD's short SHA.
#
#   tools/release/build-images.sh
#
# The build context is `git archive HEAD`, so only committed files reach an image, never
# an ignored or untracked file in the working tree. It also refuses uncommitted changes,
# so the tag means what it says. Builds run one at a time: this Mac has no buildx, and a
# parallel classic build can race on the same tag.
# Then: tools/release/export-images.sh <tag>.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"

if [[ -n "$(git status --porcelain -- . ':(exclude).DS_Store')" ]]; then
  echo "build: the working tree has uncommitted changes; commit them first" >&2
  exit 1
fi
tag="$(git rev-parse --short HEAD)"

context="$(mktemp -d "${TMPDIR:-/tmp}/bp-build.XXXXXX")"
trap 'rm -rf "$context"' EXIT
git archive --format=tar -o "$context/context.tar" HEAD

echo "build: bp-api:$tag"
docker build -f infra/docker/api.Dockerfile --target runtime -t "bp-api:$tag" - <"$context/context.tar"
echo "build: bp-migrate:$tag"
docker build -f infra/docker/api.Dockerfile --target migrate -t "bp-migrate:$tag" - <"$context/context.tar"
echo "build: bp-web:$tag"
docker build -f infra/docker/web.Dockerfile -t "bp-web:$tag" - <"$context/context.tar"
echo "build: done. Next: tools/release/export-images.sh $tag"
