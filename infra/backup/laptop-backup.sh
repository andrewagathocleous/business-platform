#!/usr/bin/env bash
# Encrypted backup of the live laptop stack (R0-C). Run daily at 03:00 by launchd, by
# deploy-laptop.sh before every deploy, and on demand:
#
#   ~/business-platform/current/infra/backup/laptop-backup.sh
#
# Reads $BP_HOME/backup.conf (default ~/business-platform/backup.conf):
#   BACKUP_DIR=<a cloud-synced folder>
#   AGE_RECIPIENT=age1...        (public key; the secret key is only in the password manager)
#
# Writes <BACKUP_DIR>/business-platform/<UTC timestamp>/ with:
#   business_platform.dump.age, n8n.dump.age  both databases (pg_dump through docker exec)
#   storage.tar.age                           the stored files
#   n8n-data.tar.age                          n8n's files, without its config (which holds its key)
#   RELEASE, MANIFEST.sha256
# Each stream is encrypted as it is written; nothing unencrypted reaches the disk or
# Docker's logs (exec output is not logged, and the file helpers have no log driver).
# Keeps the 14 newest backups and the first backup of each of the 6 newest months.
# The env files and master keys are never in a backup.
# Logs to ~/Library/Logs/business-platform-backup.log and posts a notification on failure.
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release="$(cd "$here/../.." && pwd -P)"
BP_HOME="${BP_HOME:-$HOME/business-platform}"
compose="$release/tools/release/laptop-compose.sh"
log_file="$HOME/Library/Logs/business-platform-backup.log"
mkdir -p "$(dirname "$log_file")"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log_file"
}

notify_failure() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'display notification "The backup failed. See ~/Library/Logs/business-platform-backup.log" with title "Business platform backup"' >/dev/null 2>&1 || true
  fi
}

fail() {
  log "backup FAILED: $*"
  notify_failure
  exit 1
}

# Reads KEY=value from backup.conf without executing it.
conf_value() {
  sed -n "s/^$1=//p" "$BP_HOME/backup.conf" | tail -n 1
}

[[ -f "$BP_HOME/backup.conf" ]] || fail "$BP_HOME/backup.conf is missing"
backup_dir="$(conf_value BACKUP_DIR)"
recipient="$(conf_value AGE_RECIPIENT)"
[[ -n "$backup_dir" && -d "$backup_dir" ]] || fail "BACKUP_DIR is not set to an existing folder"
[[ "$recipient" =~ ^age1[0-9a-z]{58}$ ]] || fail "AGE_RECIPIENT is not an age public key"

# One backup at a time, under a kernel lock (run-locked.pl): it is released when the run
# ends, crashes or the power goes, so it is never left behind. When the lock is busy (another
# backup, or a restore), run-locked.pl runs this script with --busy, which logs and notifies.
if [[ "${1:-}" == "--busy" ]]; then
  fail "another backup or a restore is running"
fi
mkdir -p "$BP_HOME/state"
if [[ "${BP_BACKUP_LOCKED:-}" != "1" ]]; then
  export BP_BACKUP_LOCKED=1
  exec "$release/tools/release/run-locked.pl" "$BP_HOME/state/backup.lock" nowait \
    --on-busy /bin/bash "$0" --busy -- \
    /bin/bash "$0" "$@"
fi

# A restore of the live stack that did not finish leaves partial data; never back that up.
if [[ -f "$BP_HOME/state/restore-in-progress" ]]; then
  fail "a restore of the live stack did not finish; not backing up partial data"
fi

work=""
finish() {
  local status=$?
  if [[ -n "$work" && -d "$work" ]]; then
    rm -rf "$work"
  fi
  if ((status != 0)); then
    log "backup FAILED (exit $status)"
    notify_failure
  fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

root="$backup_dir/business-platform"
mkdir -p "$root"
# Interrupted runs leave .incomplete-* folders; with the kernel lock held, none is in use.
for leftover in "$root"/.incomplete-*; do
  if [[ -d "$leftover" ]]; then
    rm -rf "$leftover"
    log "backup: removed an interrupted run's folder $(basename "$leftover")"
  fi
done

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$root/.incomplete-$stamp"
mkdir "$work"
log "backup started: $stamp"

"$compose" exec -T postgres pg_dump -U postgres -Fc business_platform |
  age -r "$recipient" -o "$work/business_platform.dump.age"
"$compose" exec -T postgres pg_dump -U postgres -Fc n8n |
  age -r "$recipient" -o "$work/n8n.dump.age"
"$compose" --profile ops run --rm --no-deps -T files -C /var/lib/business-platform/storage -cf - . |
  age -r "$recipient" -o "$work/storage.tar.age"
"$compose" --profile ops run --rm --no-deps -T n8n-files -C /home/node/.n8n --exclude ./config -cf - . |
  age -r "$recipient" -o "$work/n8n-data.tar.age"
cp "$release/RELEASE" "$work/RELEASE"
(cd "$work" && shasum -a 256 business_platform.dump.age n8n.dump.age storage.tar.age n8n-data.tar.age RELEASE >MANIFEST.sha256)

mv "$work" "$root/$stamp"
work=""
log "backup written: $root/$stamp ($(du -sh "$root/$stamp" | cut -f 1))"

# Retention: the 14 newest, plus the first backup of each of the 6 newest months.
keep=" "
all=()
# The glob sorts by name, which is chronological for this timestamp format.
for path in "$root"/*; do
  name="$(basename "$path")"
  if [[ -d "$path" && "$name" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    all+=("$name")
  fi
done
count=${#all[@]}
if ((count > 0)); then
  start=$((count > 14 ? count - 14 : 0))
  for ((i = start; i < count; i++)); do
    keep="$keep${all[$i]} "
  done
  firsts=()
  previous=""
  for name in "${all[@]}"; do
    month="${name:0:6}"
    if [[ "$month" != "$previous" ]]; then
      firsts+=("$name")
      previous="$month"
    fi
  done
  month_count=${#firsts[@]}
  month_start=$((month_count > 6 ? month_count - 6 : 0))
  for ((i = month_start; i < month_count; i++)); do
    keep="$keep${firsts[$i]} "
  done
  for name in "${all[@]}"; do
    if [[ "$keep" != *" $name "* ]]; then
      rm -rf "${root:?}/$name"
      log "backup removed by retention: $name"
    fi
  done
fi
log "backup done: $stamp"
