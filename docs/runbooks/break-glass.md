# Break-glass recovery (live laptop)

What to do when something important is lost or compromised (Release 0, step R0-F). Each case has the exact commands and the audit events to check afterwards. `lc` means `~/business-platform/current/tools/release/laptop-compose.sh` (see `laptop-host.md`).

Keep these in your password manager, apart from the laptop: the age backup secret key, `APP_MASTER_KEYS`, `N8N_ENCRYPTION_KEY`, the Entra client secret, and the emergency Microsoft admin account's sign-in.

## 1. Your Microsoft account is lost, locked or replaced

On the laptop:

```sh
lc --profile ops run --rm owner-cli enrol --email you@your-domain --name "Your Name" \
  --origin https://localhost:8443 --entra-oid <Object ID of the working account> --relink
```

This removes the old Microsoft link, signs you out everywhere, and prints a new one-time link (30 minutes). Open it on the laptop and sign in with the working account.

**Check afterwards:** `lc --profile ops run --rm owner-cli list` shows `microsoft: linked`. In the audit log (Admin, Audit), look for:
- `platform.owner_enrolment_created`;
- `platform.owner_enrolled`;
- an `auth.login` success.

**Rehearse this once** before going live, and record it in `docs/releases/r0-report.md`.

## 2. A session may be compromised (a lost browser, a shared screen)

```sh
lc --profile ops run --rm owner-cli revoke-sessions --email you@your-domain
```

Every session of that owner ends. Sign in again with Microsoft.

**Check afterwards:** `platform.owner_sessions_revoked` in the audit log, and only your new sign-in after it.

## 3. The laptop is lost, stolen or dead

1. Follow **Disaster recovery** in `laptop-host.md` section 9. In short: install the tools, unpack the release with `deploy-laptop.sh --unpack-only`, create the env files with the **old** `APP_MASTER_KEYS` and `N8N_ENCRYPTION_KEY` from your password manager, then restore the newest backup:

   ```sh
   ~/business-platform/current/infra/backup/laptop-restore.sh "<backup folder>/business-platform/<newest>" \
     --project business-platform-live
   ```

2. The restore turns every company automation switch off. Check the queued print jobs (Admin, Automation) before turning them on again there.
3. Trust the local certificate and install the login agents (`laptop-host.md` steps 5 and 7), and set up backups again (section 8).

4. Rotate everything the old laptop held, because it held them on disk (encrypted, but the laptop is gone):
   - the PrestaShop Webservice key: create a new one in PrestaShop, delete the old one, and enter the new one on the Integrations screen;
   - the PrintNode API key: create a new one at printnode.com, delete the old one, and enter it on the Integrations screen;
   - the Entra client secret: create a new secret for the app registration, put it in `api.env`, recreate the API with `lc up -d --force-recreate api worker`, check that you can sign in, and only then delete the old secret;
   - your Microsoft sessions: sign out of other sessions in your Microsoft account.
5. Re-enrol yourself if the restore did not bring your Microsoft link (case 1).

**Check afterwards:** the restore printed the expected row counts; the Integrations status shows both connections set; the audit log shows `integration.credential_replaced` for each key.

## 4. Microsoft 365 is locked for every admin

This is why a second, **emergency admin account** is recommended:
- cloud-only, with a long random password;
- a hardware security key or an authenticator app;
- kept offline, and used only in an emergency, as Microsoft advises.

With it, sign in to the Entra admin center, restore access to your normal account, then follow case 1 if needed. Without it, recovery goes through Microsoft support, which can take days. The platform keeps running meanwhile; only new sign-ins are blocked.

## 5. A deploy went wrong

Deploy the previous bundle again (`deploy-laptop.sh` with the older `bp-<tag>.tar` in `~/business-platform-src/var/releases`). If that deploy fails because the newer version changed the database, restore the backup that the newer deploy took just before it started, **with the older release's own restore script**, so the older images and migrations are used:

```sh
~/business-platform/releases/<older tag>/infra/backup/laptop-restore.sh \
  "<backup folder>/business-platform/<time of the newer deploy>" \
  --project business-platform-live --replace
ln -sfn ~/business-platform/releases/<older tag> ~/business-platform/current
```

`--replace` proves the key opens the backup, backs up the current data, asks you to type the project name, and turns every company automation switch off after the restore. The `ln` line points `current` (the login agent and `lc`) back at the older release.
