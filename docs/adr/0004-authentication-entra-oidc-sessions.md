# ADR-0004: Staff authentication through Entra ID OIDC with server-side sessions

- Status: accepted (Entra tenant details still to confirm, U2)
- Date: 2026-10-19

## Decision

- Staff sign in with Microsoft Entra ID over OIDC, using `openid-client` 6: Authorization Code with PKCE, state and nonce. Users are matched by `(issuer, tid, oid)`, never by email alone.
- Staff accounts are invitation-only. An invitation (hashed token, expiry, roles) is bound to the identity that signs in when the invitee accepts it.
- Staff without Microsoft 365 licences get unlicensed cloud-only accounts or B2B guest accounts in the tenant. The platform stores no passwords and implements no TOTP of its own.
- MFA is enforced in Entra (Security Defaults or Conditional Access). Where token claims show the authentication method (to verify: `amr`/`acrs`), the app also requires MFA for platform owners and company admins. If it can't be verified, that's recorded as a documented gap and not assumed.
- Sessions are server-side in the `user_session` table: a random 32-byte token in the cookie with only its SHA-256 hash stored, idle timeout 8 h, absolute timeout 7 days (configurable), and revocation per session, per user or globally. Suspending a membership or changing roles takes effect on the next request, because permissions load per request.
- Security-relevant behaviour depends on `APP_ENV` (`development`, `test`, `uat` or `production`), not on `NODE_ENV`. Images always run with `NODE_ENV=production`. The API refuses to start if `APP_ENV` is missing or invalid.
- A dev login (fictional seed users) is available only when `APP_ENV` is `development` or `test` **and** `AUTH_DEV_LOGIN_ENABLED=true`. If `APP_ENV` is `uat` or `production` and dev login is enabled, the API refuses to start. A test covers this.
- A large standalone auth server (Keycloak and similar) is not used.

## Consequences

- Staff login depends on the Entra tenant. The recovery runbook covers break-glass access: one platform-owner account with a hardware key or authenticator, stored offline.
- Phase 1 exercises the full OIDC code against a local mock OIDC provider in tests. A live Entra test waits on tenant access.
