#!/bin/sh
# Sets the bp_owner, bp_app and n8n login passwords from BP_OWNER_PASSWORD, BP_APP_PASSWORD
# and N8N_DB_PASSWORD, after roles.sql has created the roles.
#
#   set-passwords.sh [psql connection arguments]
#
# psql's \password reads each password from standard input, hashes it on the client
# (SCRAM-SHA-256) and sends only the verifier. So a plaintext password never appears in
# SQL, a server log, pg_stat_activity or a process argument. printf is a shell builtin.
set -eu

# With a controlling terminal, \password would read /dev/tty instead of the pipe, so the
# environment passwords would be ignored. Refuse; run it without a TTY (compose exec -T).
if (exec 3</dev/tty) 2>/dev/null; then
  echo "set-passwords: run this without a terminal, for example 'docker compose exec -T postgres ...'" >&2
  exit 1
fi

for name in BP_OWNER_PASSWORD BP_APP_PASSWORD N8N_DB_PASSWORD; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name is required" >&2
    exit 1
  fi
done

set_password() {
  role="$1"
  password="$2"
  shift 2
  printf '%s\n%s\n' "$password" "$password" |
    psql -X -q -v ON_ERROR_STOP=1 "$@" -c "\\password $role" ||
    {
      echo "set-passwords: could not set the password for $role" >&2
      exit 1
    }
}

set_password bp_owner "$BP_OWNER_PASSWORD" "$@"
set_password bp_app "$BP_APP_PASSWORD" "$@"
set_password n8n "$N8N_DB_PASSWORD" "$@"
echo "set-passwords: set the bp_owner, bp_app and n8n passwords"
