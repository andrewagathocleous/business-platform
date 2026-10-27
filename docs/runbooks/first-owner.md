# First platform owner

How the first owner gets into a fresh production database, and how to recover if their Microsoft account changes. Release 0, step R0-A.

A fresh production database has no staff user, and an unknown Microsoft sign-in is denied. Only the owner CLI can make someone a platform owner. It runs with the owner database URL from `migrate.env`; the API and the worker never get that URL.

All commands below run from the deploy directory with the same `BP_ENV_DIR` and `BP_IMAGE_TAG` as the stack. The `ops` profile keeps `owner-cli` out of `docker compose up`.

## Enrol the first owner

```sh
docker compose --profile ops run --rm owner-cli enrol \
  --email owner@your-domain.example \
  --name "Owner Name" \
  --origin https://localhost:8443 \
  --entra-oid 00000000-0000-0000-0000-000000000000
```

- `--origin` is the address you open the platform at: `https://localhost:8443` on the laptop, or the server's `https://` address later.
- `--entra-oid` is recommended for Microsoft 365. It is the owner's **Object ID**: in the Microsoft Entra admin center, go to Users, open the owner, and copy Object ID. With it, the link accepts only that Microsoft account, whatever the email claims say.
- Without `--entra-oid`, the link needs a **verified** `email` claim equal to `--email`. Microsoft does not always send `email_verified`, and a `preferred_username` match is never accepted for an owner.
- The command prints a one-time link. It works once and expires after 30 minutes. Only its SHA-256 hash is stored.
- Open the link in the browser on the host and sign in with that Microsoft account.
- Running `enrol` again for the same person revokes their earlier open link.
- The `owner-cli` service has no Docker log driver, so the printed link is shown in your terminal but not kept in Docker's logs.

The link is a credential until it is used or expires. Do not paste it into chat, email or a ticket.

## Check

```sh
docker compose --profile ops run --rm owner-cli list
```

This shows each owner's email, name, status, whether a Microsoft sign-in is linked, and the last login. It never shows links or hashes.

## Microsoft account changed (re-link)

If the owner's Microsoft account is replaced, `enrol` refuses because a sign-in is already linked. Re-link:

```sh
docker compose --profile ops run --rm owner-cli enrol \
  --email owner@your-domain.example --name "Owner Name" \
  --origin https://localhost:8443 --relink
```

This removes the old Microsoft link, signs the owner out everywhere, and prints a new one-time link.

## Sign an owner out everywhere

```sh
docker compose --profile ops run --rm owner-cli revoke-sessions --email owner@your-domain.example
```

## Disable an owner

```sh
docker compose --profile ops run --rm owner-cli disable --email owner@your-domain.example
```

This disables the account, signs it out and revokes its open links. It refuses to disable the last active owner: enrol a second owner first (the emergency admin account, see R0-F).

## What the application cannot do

The database refuses, for the application role, to make an account a platform owner, to remove the flag, or to change a platform owner's status (trigger `user_account_owner_guard`). Only this CLI, which uses the owner database role, can. Owner commands run one at a time under an advisory lock.

## Audit

Every command writes one audit event with actor `cli`, refusals included:
- `platform.owner_enrolment_created`;
- `platform.owners_listed`;
- `platform.owner_sessions_revoked`;
- `platform.owner_disabled`.

A completed link writes `platform.owner_enrolled`. A refused sign-in writes `auth.login` with outcome `denied` and a reason, such as `enrolment_unavailable` or `enrolment_email_mismatch`.

Exit codes: 0 done, 1 refused, 2 bad arguments.
