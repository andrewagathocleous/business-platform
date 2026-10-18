# ADR-0007: Credential vault, service identities and outbound safety switches

- Status: accepted
- Date: 2026-10-19

## Decision

- **Credential vault:** the `integration_credential` table stores ciphertext encrypted with AES-256-GCM from `node:crypto` (backed by OpenSSL; no homemade crypto). Each record gets a random 96-bit nonce and a key id. The master key (32 bytes) comes from `APP_MASTER_KEYS`, a key-id-to-key map loaded from a secret file or env. It lives outside the database and outside database backups and is backed up separately. Rotation re-encrypts records under a new key id. Plaintext credentials never reach the frontend, logs, audit details or API responses. Responses show only "configured" and a hint (for example the last 4 characters).
- **Service identities:** bearer tokens in the format `bps_<id>.<secret>`. Only the SHA-256 hash of the secret is stored, and the token is shown once. Each identity is bound to one company, carries a permission subset no larger than its creator's, has an expiry, and has `last_used_at` tracked. Revocation is immediate. They are accepted only on `/api/automation/v1/c/:companyId/...` routes.
- **Automation switches** (`automation_switch` table):
  - One global switch, `outbound.all`, for platform owners.
  - Per-company switches for each outbound capability: `printing`, `email.send`, `store.write`, `marketing.send`, `social.publish`, `shipment.book`, `invoice.issue_real`.
  - Every switch is **off by default**. Switches are checked at execution time by the worker and immediately before any synchronous outbound call. Every change is audited with its reason.

## Consequences

- Turning on a real integration is a deliberate, audited, two-step action: configure the connection, then enable the switch.
- The emergency stop takes effect even for actions already queued.
