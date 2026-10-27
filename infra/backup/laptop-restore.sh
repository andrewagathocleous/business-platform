#!/usr/bin/env bash
# Restores one backup made by laptop-backup.sh (R0-C).
#
#   ~/business-platform/current/infra/backup/laptop-restore.sh <backup dir> [--project <name>] [--replace]
#
# Default project: business-platform-restore, a scratch copy for the restore drill. Only
# postgres, migrate and the API run there: no Caddy, no n8n and never the worker.
# With --project business-platform-live it restores the live stack (a new laptop, or
# undoing a bad deploy) and starts everything.
#
# Order, so nothing is destroyed before the restore is known to work:
#  1. Copies the backup into a private working folder (retention or a sync cannot remove
#     it meanwhile) and checks MANIFEST.sha256, file by exact name.
#  2. Reads the age secret key from the terminal (hidden) or a pipe, never an argument
#     or a file, and decrypts every file once to /dev/null to prove key and integrity.
#  3. Refuses a project that has any volume, unless --replace and you type its name; then
#     backs up the live data first and removes only the data volumes (Postgres, stored
#     files, n8n). Caddy's local certificate authority is kept, so the browser still trusts it.
#  4. Restores the database, turns every company automation switch OFF straight away
#     (audited; every outbound action needs its company switch), then n8n and the files,
#     runs migrate, starts the stack and prints row counts. Turn the switches back on in
#     Admin, Automation after checking queued print jobs.
# For the live project, $BP_HOME/state/restore-in-progress exists from before anything is
# removed until the stack is up again; laptop-compose.sh (the login agent, deploys) will
# not start the stack while it exists, so an interrupted restore cannot start the worker.
set -euo pipefail
umask 077

usage() {
  echo "usage: laptop-restore.sh <backup dir> [--project <name>] [--replace]" >&2
  exit 2
}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release="$(cd "$here/../.." && pwd -P)"
BP_HOME="${BP_HOME:-$HOME/business-platform}"

source_dir=""
project="business-platform-restore"
replace=0
while (($# > 0)); do
  case "$1" in
    --project)
      [[ $# -ge 2 ]] || usage
      project="$2"
      shift 2
      ;;
    --replace)
      replace=1
      shift
      ;;
    -*)
      usage
      ;;
    *)
      [[ -z "$source_dir" ]] || usage
      source_dir="$1"
      shift
      ;;
  esac
done
[[ -n "$source_dir" && -d "$source_dir" ]] || usage
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || usage
source_dir="$(cd "$source_dir" && pwd -P)"

# The whole restore holds two kernel locks (run-locked.pl, never stale): the stack lock,
# so a login agent or deploy cannot start the stack in the middle of it, and the backup
# lock, so no other backup can read half-restored data. Its own backup of the live data
# runs inside them (BP_BACKUP_LOCKED tells laptop-backup.sh the lock is already held).
mkdir -p "$BP_HOME/state"
if [[ "${BP_STACK_LOCKED:-}" != "1" ]]; then
  again=("$source_dir" --project "$project")
  if ((replace)); then
    again+=(--replace)
  fi
  export BP_STACK_LOCKED=1 BP_BACKUP_LOCKED=1
  busy="restore: the stack is starting, or a backup or another restore is running; try again in a few minutes"
  exec "$release/tools/release/run-locked.pl" "$BP_HOME/state/stack.lock" nowait --busy "$busy" \
    "$release/tools/release/run-locked.pl" "$BP_HOME/state/backup.lock" nowait --busy "$busy" \
    /bin/bash "$0" "${again[@]}"
fi
started=$(date +%s)
files="business_platform.dump.age n8n.dump.age storage.tar.age n8n-data.tar.age RELEASE"

# 1. Private working copy, then the manifest by exact file name.
mkdir -p "$BP_HOME/state"
work="$(mktemp -d "$BP_HOME/state/restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
for file in $files MANIFEST.sha256; do
  if [[ ! -f "$source_dir/$file" || -L "$source_dir/$file" ]]; then
    echo "restore: $source_dir/$file is missing" >&2
    exit 1
  fi
  cp "$source_dir/$file" "$work/$file"
done
for file in $files; do
  if ! awk -v f="$file" 'NF == 2 && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 && $2 == f { n++ } END { exit n == 1 ? 0 : 1 }' "$work/MANIFEST.sha256"; then
    echo "restore: MANIFEST.sha256 does not cover $file exactly once" >&2
    exit 1
  fi
done
if ! (cd "$work" && shasum -a 256 -c MANIFEST.sha256 >/dev/null); then
  echo "restore: the backup does not match its MANIFEST.sha256; not restoring" >&2
  exit 1
fi
echo "restore: manifest verified for $(basename "$source_dir")"

# 2. The key, proven against every file before anything is changed.
if [[ -t 0 ]]; then
  printf 'age secret key (AGE-SECRET-KEY-1...), input hidden: ' >/dev/tty
  read -rs key </dev/tty
  printf '\n' >/dev/tty
else
  read -r key || true
fi
if [[ ! "$key" =~ ^AGE-SECRET-KEY-1[0-9A-Z]{58}$ ]]; then
  echo "restore: that is not an age secret key" >&2
  exit 1
fi
decrypt() {
  age -d -i <(printf '%s\n' "$key") "$work/$1"
}
for file in business_platform.dump.age n8n.dump.age storage.tar.age n8n-data.tar.age; do
  if ! decrypt "$file" >/dev/null; then
    echo "restore: $file does not decrypt with that key; nothing was changed" >&2
    exit 1
  fi
done
echo "restore: the key opens every file"

tag="$(sed -n 's/^tag=//p' "$release/RELEASE")"
if [[ ! "$tag" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  echo "restore: $release/RELEASE has no valid tag" >&2
  exit 1
fi
export BP_IMAGE_TAG="$tag"
export BP_ENV_DIR="$BP_HOME/env"
dc() {
  docker compose -p "$project" \
    -f "$release/infra/compose/compose.prod.yml" \
    -f "$release/infra/compose/compose.laptop.yml" \
    "$@"
}

# 3. Any existing volume of the project counts as data.
if ! existing="$(docker volume ls -q --filter "name=^${project}_")"; then
  echo "restore: could not list Docker volumes" >&2
  exit 1
fi
marker="$BP_HOME/state/restore-in-progress"
mark_restoring() {
  if [[ "$project" == "business-platform-live" ]]; then
    printf 'restore of %s started %s\n' "$(basename "$source_dir")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$marker"
  fi
}

if [[ -n "$existing" ]]; then
  if ((replace == 0)); then
    echo "restore: project $project already has volumes; use --replace to overwrite its data" >&2
    exit 1
  fi
  printf 'This replaces the databases, stored files and n8n data of %s. Type the project name to continue: ' "$project" >/dev/tty
  read -r answer </dev/tty
  if [[ "$answer" != "$project" ]]; then
    echo "restore: not confirmed; nothing was changed" >&2
    exit 1
  fi
  if [[ "$project" == "business-platform-live" && -f "$marker" ]]; then
    echo "restore: an earlier restore did not finish; its partial data is not backed up"
  elif [[ "$project" == "business-platform-live" ]]; then
    echo "restore: backing up the live data before replacing it"
    "$release/infra/backup/laptop-backup.sh"
  fi
  mark_restoring
  dc --profile ops down
  for volume in bp_postgres bp_storage bp_n8n; do
    if docker volume inspect "${project}_${volume}" >/dev/null 2>&1; then
      docker volume rm "${project}_${volume}" >/dev/null
    fi
  done
fi

# 4. Restore; company switches off before anything else, and long before the app starts.
mark_restoring
echo "restore: starting postgres for project $project"
dc up -d --wait postgres
echo "restore: restoring business_platform"
decrypt business_platform.dump.age | dc exec -T postgres pg_restore -U postgres -d business_platform --exit-on-error

turned="$(dc exec -T postgres psql -X -q -U postgres -d business_platform -v ON_ERROR_STOP=1 -tA -c "
  WITH turned AS (
    UPDATE automation_switch
    SET enabled = false, reason = 'turned off by laptop-restore.sh', updated_at = now()
    WHERE enabled AND company_id IS NOT NULL
    RETURNING id, company_id, key
  ), audited AS (
    INSERT INTO audit_event (id, company_id, actor_type, actor_label, action, object_type, object_id, outcome, correlation_id, details)
    SELECT gen_random_uuid(), company_id, 'system', 'restore', 'automation_switch.updated', 'automation_switch', id,
           'success', 'restore-$(date -u +%Y%m%dT%H%M%SZ)', jsonb_build_object('key', key, 'enabled', false, 'reason', 'restore')
    FROM turned
    RETURNING 1
  )
  SELECT count(*) FROM audited")"
echo "restore: turned off $turned company switch(es); turn them on again in Admin, Automation after checking queued print jobs"

echo "restore: restoring n8n"
decrypt n8n.dump.age | dc exec -T postgres pg_restore -U postgres -d n8n --exit-on-error
echo "restore: restoring stored files and n8n files"
decrypt storage.tar.age | dc --profile ops run --rm --no-deps -T files -C /var/lib/business-platform/storage -xf -
decrypt n8n-data.tar.age | dc --profile ops run --rm --no-deps -T n8n-files -C /home/node/.n8n -xf -
key=""

echo "restore: running migrate"
dc run --rm --no-deps migrate
if [[ "$project" == "business-platform-live" ]]; then
  echo "restore: starting the whole live stack"
  dc up -d --wait
  rm -f "$marker"
else
  echo "restore: starting the API only (no worker, n8n or Caddy)"
  dc up -d --wait --no-deps api
fi

echo "restore: row counts in $project"
dc exec -T postgres psql -X -U postgres -d business_platform -tA -F ' ' -c "
  SELECT 'company', count(*) FROM company
  UNION ALL SELECT 'user_account', count(*) FROM user_account
  UNION ALL SELECT 'sales_order', count(*) FROM sales_order
  UNION ALL SELECT 'invoice', count(*) FROM invoice
  UNION ALL SELECT 'stored_file', count(*) FROM stored_file
  UNION ALL SELECT 'audit_event', count(*) FROM audit_event"
echo "restore: done in $(($(date +%s) - started)) s from backup $(basename "$source_dir") (release $(sed -n 's/^tag=//p' "$work/RELEASE"))"
if [[ "$project" != "business-platform-live" ]]; then
  echo "restore: when the drill is recorded, delete the scratch copy with:"
  echo "  BP_IMAGE_TAG=$tag BP_ENV_DIR=$BP_ENV_DIR docker compose -p $project -f $release/infra/compose/compose.prod.yml -f $release/infra/compose/compose.laptop.yml down -v"
fi
