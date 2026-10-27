#!/usr/bin/env bash
# Installs the live laptop's launchd agents for the logged-in user (R0-E).
#
#   ~/business-platform/current/tools/release/install-launchd.sh
#
# Renders every infra/launchd/*.plist.template of this release into
# ~/Library/LaunchAgents and (re)loads it. Run it again after a deploy that changes them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
release="$(cd "$here/../.." && pwd -P)"
BP_HOME="${BP_HOME:-$HOME/business-platform}"

# These are sed and XML special characters; reject them rather than escape them.
case "$BP_HOME$HOME" in
  *'#'* | *'&'* | *'<'* | *'>'* | *\\*)
    echo "install-launchd: BP_HOME and HOME must not contain # & < > or a backslash" >&2
    exit 2
    ;;
esac

agents="$HOME/Library/LaunchAgents"
mkdir -p "$agents" "$HOME/Library/Logs"
domain="gui/$(id -u)"
found=0
for template in "$release"/infra/launchd/*.plist.template; do
  [[ -f "$template" ]] || continue
  found=1
  label="$(basename "$template" .plist.template)"
  target="$agents/$label.plist"
  sed -e "s#__BP_HOME__#$BP_HOME#g" -e "s#__HOME__#$HOME#g" "$template" >"$target"
  chmod 644 "$target"
  plutil -lint "$target" >/dev/null
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$target"
  echo "install-launchd: loaded $label"
done
if ((found == 0)); then
  echo "install-launchd: no templates in $release/infra/launchd" >&2
  exit 1
fi
