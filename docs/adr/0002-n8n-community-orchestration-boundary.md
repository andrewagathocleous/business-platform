# ADR-0002: n8n Community for orchestration only

- Status: accepted
- Date: 2026-10-19

## Context

The brief chooses n8n Community Edition for automation. On 2026-10-19 we checked https://docs.n8n.io/hosting/community-edition-features/. Community Edition **does not include**:

- custom variables
- environments
- Git version control
- external secrets
- external binary-data storage
- log streaming
- multi-main mode
- projects
- SAML/LDAP SSO
- sharing of workflows and credentials ("only the instance owner and the user who creates them can access workflows and credentials")

Free registration unlocks folders, debug in editor and custom execution data.

Defaults verified in the n8n docs on the same date:

- `NODES_EXCLUDE` excludes only `executeCommand` and `localFileTrigger`.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE` defaults to `false`, so Code nodes can read environment variables.
- Task runners: internal mode isn't recommended for production. External mode uses the `n8nio/runners` image, whose version must match `n8nio/n8n`.

## Decision

- n8n owns triggers, schedules, branching, notifications and retries of *idempotent* application calls.
- The application owns business state and domain rules. Business-data connectors (store, print, mail, marketing and social providers) run in the app's worker, with per-company credentials in the app's encrypted credential vault. n8n calls authenticated, company-scoped application APIs through service identities. It never writes to business tables and never holds business-data provider credentials.
- This deviates from the brief's wording "n8n owns … connector calls", because Community Edition can't isolate credentials per company and connector logic must be tested and gated by kill switches. n8n may hold credentials for low-risk notification channels.
- Only trusted technical administrators use the editor, over an SSH tunnel or VPN. It's never embedded in the staff UI or exposed publicly.
- Hardening:
  - Pin `n8nio/n8n` and `n8nio/runners` to the same exact version.
  - Run task runners in external mode.
  - Set `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` and `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=true`.
  - Extend `NODES_EXCLUDE` to filesystem and SSH nodes.
  - Disable community packages unless reviewed.
  - Use its own Postgres database and least-privileged user.
  - Limit execution retention, and back up the encryption key.
- Workflows go in Git as sanitised exports (pinned data stripped, no credentials), using the CLI `export:workflow` and `import:workflow` through scripts. Paid Git integration is not assumed.

## Consequences

- Workflows are thin, and changing domain behaviour never requires editing a workflow Code node.
- Each n8n workflow needs a service identity per company and purpose, which means more tokens to manage. The app tracks their expiry and alerts on it.
- Licensing has to be reassessed before any external SaaS use.
