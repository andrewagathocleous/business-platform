#!/usr/bin/env bash
# Health check for the live laptop (R0-D), run every 5 minutes by launchd while you are
# logged in:
#
#   ~/business-platform/current/infra/health/laptop-health.sh
#
# - Calls https://localhost:8443/api/health/ready. After 2 failures in a row (10 minutes)
#   it posts a macOS notification, then again every hour while it stays down, and once
#   when it answers again.
# - Warns once a day when less than 20 % of the startup disk is free.
# Logs to ~/Library/Logs/business-platform-health.log. It never prints a secret.
set -euo pipefail

BP_HOME="${BP_HOME:-$HOME/business-platform}"
state_dir="$BP_HOME/state"
failures_file="$state_dir/health-failures"
disk_file="$state_dir/disk-warned-on"
log_file="$HOME/Library/Logs/business-platform-health.log"
mkdir -p "$state_dir" "$(dirname "$log_file")"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log_file"
}

# Messages are fixed strings, so nothing outside this file reaches AppleScript.
notify() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$1\" with title \"Business platform\"" >/dev/null 2>&1 || true
  fi
}

previous=0
if [[ -f "$failures_file" ]]; then
  previous="$(cat "$failures_file")"
  [[ "$previous" =~ ^[0-9]+$ ]] || previous=0
fi

if curl -fsSk --max-time 10 https://localhost:8443/api/health/ready >/dev/null 2>&1; then
  if ((previous >= 2)); then
    log "health recovered after $previous failed checks"
    notify "The platform is answering again."
  fi
  echo 0 >"$failures_file"
else
  count=$((previous + 1))
  echo "$count" >"$failures_file"
  log "health check failed ($count in a row)"
  if ((count == 2 || (count > 2 && count % 12 == 2))); then
    notify "The platform is not answering. In Terminal run: ~/business-platform/current/tools/release/laptop-compose.sh ps"
  fi
fi

# Free space on the startup disk, as a whole percentage of its size.
free_percent="$(df -Pk / | awk 'NR == 2 && $2 > 0 { printf "%d", ($4 * 100) / $2 }')"
today="$(date +%Y-%m-%d)"
if [[ "$free_percent" =~ ^[0-9]+$ ]] && ((free_percent < 20)); then
  if [[ "$(cat "$disk_file" 2>/dev/null || true)" != "$today" ]]; then
    echo "$today" >"$disk_file"
    log "disk space low: $free_percent % free"
    notify "Less than 20 percent of the disk is free. Backups and the database need room."
  fi
fi
