#!/usr/bin/env bash
# One-time backup set-up on the live laptop (R0-C).
#
#   ~/business-platform/current/infra/backup/backup-setup.sh "<cloud-synced backup folder>"
#
# Creates an age key pair. Writes the folder and the PUBLIC key to $BP_HOME/backup.conf.
# Shows the SECRET key once, for your password manager; it is not stored anywhere else.
# Without it no backup can be restored.
set -euo pipefail
umask 077

BP_HOME="${BP_HOME:-$HOME/business-platform}"
conf="$BP_HOME/backup.conf"
folder="${1:-}"

if [[ -z "$folder" || ! -d "$folder" ]]; then
  echo "usage: backup-setup.sh <existing backup folder>" >&2
  exit 2
fi
if [[ "$folder" == *$'\n'* ]]; then
  echo "backup-setup: the folder name must be one line" >&2
  exit 2
fi
if [[ -e "$conf" ]]; then
  echo "backup-setup: $conf already exists; nothing was changed" >&2
  exit 1
fi
mkdir -p "$BP_HOME"

secret="$(age-keygen 2>/dev/null | grep '^AGE-SECRET-KEY-1')"
public="$(printf '%s\n' "$secret" | age-keygen -y)"
(
  set -o noclobber
  printf 'BACKUP_DIR=%s\nAGE_RECIPIENT=%s\n' "$(cd "$folder" && pwd -P)" "$public" >"$conf"
)
chmod 600 "$conf"

echo "backup-setup: wrote $conf"
echo
echo "Save this SECRET key in your password manager now. It is shown only this once:"
echo
echo "  $secret"
echo
echo "Restores ask for it. Then clear this terminal (Cmd-K)."
