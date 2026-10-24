# PrestaShop

R1-C reads orders from a PrestaShop 1.7.7.2 Webservice and imports them through the existing inbox. It does not write to the shop. The client and mapper (R1-C1) are unit-tested against a fake server. The poller, the company trigger and the inbox dispatch (R1-C2) are integration-tested against real Postgres and a fake PrestaShop on loopback. R1-B stores the connection, the key and the maps, and tests the shop. None of this is live-tested.

Where this document differs from the outline in `docs/plan/release-1.md`, this document is the contract.

## What it relies on

Checked against PrestaShop 1.7.7.2 (`classes/webservice/WebserviceRequest.php`, `classes/order/Order.php`, `classes/ObjectModel.php` at tag `1.7.7.2`):

- `gift` and `gift_message` are on `GET /api/orders`. Gift text is stored byte-for-byte.
- `filter[date_upd]=[from,to]` is an inclusive `BETWEEN`, and the request must send `date=1`.
- Sort is `sort=[date_upd_ASC,id_ASC]`. Limit is `limit=<offset>,<count>`. The poll always sends offset `0`.
- JSON needs the header `Output-Format: JSON`. The client never sends `output_format` or `ws_key`.
- The key is 32 letters or digits. It is the HTTP Basic user, with an empty password.
- `customers` is requested with `display=[id,firstname,lastname,email]` only, so the password hash and `secure_key` are not transferred.

Shop timestamps have no zone. They are wall times in the connection's IANA timezone. `wallTimeInZoneToInstant` takes the earlier instant when a local hour repeats, and the first valid instant when one is skipped. A repeated hour cannot be told apart in the shop's own timestamp, so "minus 10 minutes" uses that earlier instant. `instantToWallTimeInZone` is the inverse, `YYYY-MM-DD HH:mm:ss`.

The state map's `payment` value is a platform `PaymentStatus` (`pending`, `authorized`, `paid`, `partially_paid`, `refunded`, `partially_refunded`, `voided`, `unknown`). There is no `cancelled` payment status. Cancellation is the map's boolean.

## Settings and the key

`store_connection.settings` for a PrestaShop store:

| Field                 | Rule                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`             | `https` URL with no query, fragment or userinfo. One trailing slash is removed. `http` is accepted only for a loopback host, the same rule as the client, so tests can use a fake server. |
| `timezone`            | IANA zone                                                                                                                                                                                 |
| `firstImportFrom`     | `YYYY-MM-DD HH:mm:ss`, shop-local                                                                                                                                                         |
| `pollIntervalSeconds` | Integer, minimum 120, default 180                                                                                                                                                         |
| `stateMap`            | Shop state id to `{ payment, cancelled }`                                                                                                                                                 |

The carrier map is `store.delivery_method_map`, keyed by carrier `id_reference`. Values that are not platform delivery methods are ignored.

The key is an `integration_credential` with `provider = 'prestashop'` and `label = 'webservice_key'`, referenced by `store_connection.credential_id`. The poll reads that row in one transaction and decrypts it in another. A missing, revoked, wrong-type or undecryptable key is `credential_unavailable`. The shop is not called. The decrypt failure's message is not copied.

The key is GET-only on `orders`, `customers`, `addresses`, `countries`, `carriers`, `order_states` and `currencies`. It is never granted `configurations`.

Key values, hints and lengths never appear in responses, logs or audit details. Credential ids are opaque UUIDs, not secrets: the vault logs them by design, so encrypt and decrypt can be traced.

## Owner setup

The Integrations screen is `/c/:companyId/admin/integrations` (`integration.view`). Saving, testing, mapping and starting or pausing sync need `integration.manage`.

1. In the shop, create a GET-only Webservice key for those seven resources. Do not grant `configurations`.
2. Pick a non-archived PrestaShop store and save the shop URL, the key, the shop timezone and the first import time (`YYYY-MM-DD HH:mm:ss`). Then test the connection. The test uses the saved key and URL, with a 15 second timeout, and calls the seven resources in the order above. It stops at the first failure. The result is `ok`, or an error class plus the resource name. It is recorded only when that credential and shop URL are still the ones that were tested.
3. After a passed test, load order states and carriers from the shop and save the maps. A state id maps to a payment status and a cancelled flag. A carrier `id_reference` maps to a delivery method. The name kept for a reference is the carrier with the highest numeric id. A failed lookup is HTTP 502 with `{ errorClass }` only.
4. Start sync. That requires the last test result to be `ok`.

A new connection is paused, read-only, and does not write back to the shop. It pauses again when the owner pauses it (`integration.connection_paused`, `reason: manual`) and when a saved key or shop URL changes (`reason: settings_changed`). A shop 401 or 403 during a poll sets `auth_failed` and audits `store.connection_paused` with `reason: auth_failed`. Starting sync from `paused` or `auth_failed` sets `active` and re-enqueues every inbox row for that connection that is still `received`. Archiving the store does not change the connection status. The sync trigger skips an archived PrestaShop store. The first import time cannot change once a checkpoint exists.

The key is encrypted before the connection row is updated. If that update fails, the new credential is revoked. The screen and the API return whether a key is set and when, never the key, a hint, or the credential id. Request bodies are not logged, so the logging redaction list was not given a `key` field.

## Polling

n8n W0 (`workflows/n8n/exports/w0-store-sync.json`) is an inactive schedule, every minute. It POSTs `http://api:3000/api/automation/v1/c/REPLACE_WITH_COMPANY_ID/store-sync`. The company id is replaced after import. The Header Auth credential `bp store-sync token` is not in the export.

`POST /api/automation/v1/c/:companyId/store-sync` accepts only a bearer token with `store.sync.trigger`. It has no body. For each connection in that company:

- A store that is not PrestaShop is not counted.
- An archived PrestaShop store counts as `skipped`. Archiving the store does not change the connection status.
- `status` other than `active` counts as `skipped`.
- `mode` other than `live` is not counted.
- Active live settings that do not parse count as `skipped`.
- A live active connection is due when `last_sync_at` is null or at least `pollIntervalSeconds` old.
- A due connection inserts `prestashop.poll` with payload `{ connectionId }`, idempotency key `prestashop.poll:<connectionId>:<floor(epochSeconds / pollIntervalSeconds)>`, and `ON CONFLICT (idempotency_key) DO NOTHING`.

The response is `202 { queued, notDue, skipped }`. `queued` is the number of rows inserted. A second trigger in the same interval returns `queued: 0`.

**The trigger writes no audit row.** It runs every minute and changes no business state. The queue job is the record.

The worker is external, concurrency 1, `max_attempts` 1. `retryable` is true so an unexpected throw or a job timeout becomes `failed` rather than `uncertain`. The next interval is the retry. The job timeout is 240 seconds.

1. Lease. `sync_locked_until = now() + 5 minutes` where the connection is `active` and the lease is null or expired. No row means the job succeeds with no shop call. The lease is cleared in a `finally` transaction only when this run acquired it, and only when the stored timestamp is still the one this run wrote, so a newer lease is left alone.
2. Load settings and the key. `credential_unavailable` sets `last_error_class` and `last_error_at`, leaves `status` at `active`, and finishes the job as `failed`. It does not audit `store.sync_failed`.
3. Window. The checkpoint is `{ dateUpd }` in shop-local time. The first run starts at `firstImportFrom`. A stored checkpoint is read with `wallTimeInZoneToInstant`. A missing checkpoint is the first run. A value that is not `{ dateUpd: 'YYYY-MM-DD HH:mm:ss' }`, or whose calendar date is not real, is invalid: the run sets `last_error_class` to `checkpoint_reset` when that class is new, audits `store.sync_failed` with that class, clears the stored checkpoint, and continues from `firstImportFrom`. The invalid text is removed because it can sort after a real shop time and block every later checkpoint write. `from` is that start minus 10 minutes. `to` is now plus 24 hours, both through the domain helpers.
4. Order states are loaded once per run.
5. Pages. No offsets. Each call is `listOrdersUpdatedBetween({ from, to, offset: 0, limit: 100 })`. The page's customers, addresses, countries, carriers and currencies are loaded in batches. Each order is inserted in its own transaction: provider `prestashop`, topic `orders/updated`, `external_event_id` `order:<id>:<date_upd>`, and `ON CONFLICT DO UPDATE duplicate_count`. A fresh insert also enqueues `inbox.process` in that transaction. The poll does not audit `inbox.duplicate`. After the page commits, the checkpoint moves to the page's last `date_upd` only when that value is later than the stored checkpoint, or later than `firstImportFrom` when nothing is stored. The next `from` is that last `date_upd` even when the stored checkpoint did not move. Rows in the same second are fetched again and deduplicated. A page shorter than 100 stops the run. A page whose last `date_upd` is after the checkpoint this run started with counts toward a cap of 20. Pages at or before that checkpoint are the overlap and do not count. The run also stops after 20 counted pages; that partial run is still a success, and the next run continues from the checkpoint. Fifty pages that never move past the starting checkpoint stop with `last_error_class = 'overlap_too_large'`, leave the checkpoint where it is, and do not set `last_sync_at`. The pages already read stay committed. If a full page's last `date_upd` equals the `from` it was asked for, the run stops with `last_error_class = 'too_many_in_one_second'`, does not move the checkpoint, and does not set `last_sync_at`. The page's inbox rows are already committed. The next run reads that second again. That stop is not skipped.

On success, `last_sync_at` is now and both error columns are cleared. A run succeeds when a page has fewer than 100 rows, or after at least one counted page (the 20-page cap). If at least one inbox row was new, the poll audits `store.sync_imported` with `{ connectionId, newEvents, duplicates }` as the system actor `prestashop.poll`. A `checkpoint_reset` recorded earlier in that run is cleared with the other error columns. The audit row remains.

## Errors and audits

| Case                               | Connection                                     | Job                   | Audit                                                                                                          |
| ---------------------------------- | ---------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| Success with new inbox rows        | `last_sync_at` set, errors cleared             | succeeded             | `store.sync_imported`, outcome success                                                                         |
| Success with nothing new           | same                                           | succeeded             | none                                                                                                           |
| `credential_unavailable`           | stays `active`, error class set                | failed                | none for `store.sync_failed`                                                                                   |
| `PrestashopAuthFailed`             | `status = auth_failed`                         | succeeded             | `store.connection_paused` with `{ reason: 'auth_failed' }`, only when the status changed, outcome success      |
| Any other shop, map or build error | error class set, checkpoint unchanged          | failed                | `store.sync_failed` with `{ connectionId, errorClass }`, outcome failure, only when `last_error_class` changes |
| More than 100 orders in one second | `too_many_in_one_second`, checkpoint unchanged | failed                | `store.sync_failed` when the class changes                                                                     |
| 50 pages inside the overlap        | `overlap_too_large`; checkpoint and `last_sync_at` stay | failed          | `store.sync_failed` when the class changes                                                                     |
| Checkpoint is not a real date      | `checkpoint_reset`, checkpoint cleared, then the run continues. Success clears the error columns | the run's outcome | `store.sync_failed` with `checkpoint_reset` when that class is new                                      |
| Abort or timeout                   | lease released, no shop error class            | the runner settles it | none from the poller                                                                                           |
| Superseded: the connection was paused, or its key or settings changed, during the run (including while it was being opened) | nothing written: no inbox row, checkpoint, `last_sync_at`, error class or status | succeeded | none. One info log line, `prestashop poll superseded`, with the connection id |

Before each write (an inbox row, the checkpoint, `last_sync_at`, an error class or `auth_failed`), the poll locks the connection row and checks it is still `active` with the credential and settings the run read, before it parsed them or decrypted the key. A failure while opening (for example, the old key no longer decrypts) is checked the same way. Saving a changed state map also changes the settings, so it supersedes a run in progress; the next interval polls again. The carrier map lives on the store and is applied when `inbox.process` imports an order, not during the poll, so saving it does not affect a running poll. A settings save, a pause or an activation locks the same row `FOR UPDATE`, so the two serialise. Inbox rows committed earlier in a superseded run stay: they were received with a working key. A 401 for a replaced key therefore never marks the new setup `auth_failed`.

`auth_failed` stays skipped by the trigger until the owner starts sync again, which sets `active` and re-enqueues inbox rows that are still `received`. Inbox rows already received are still imported while the status is `auth_failed`: they were accepted while the key worked. Other poll failures stay `active`, so the next interval can retry. Response bodies are not stored and not logged. The poller does not log the key or the `Authorization` header.

`inbox.process` maps live PrestaShop when the connection status is `active` or `auth_failed`, with the connection timezone, state map and carrier map. Any other status leaves the inbox row `received` and fails the queue job as `connection_not_importable` without marking the row `failed`. R1-B's reactivation re-enqueues those `received` rows. Invalid settings fail that inbox row as `settings_invalid`. A `PrestashopMapError` fails the row with its message. Shopify `mock` still requires `active` and still fails the inbox row. A non-Shopify mock connection stays `unsupported_provider`.

## How it was tested

Integration-tested in `apps/api/src/prestashop.integration.test.ts` against real Postgres and a fake PrestaShop on loopback (`OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS=true`). The connection, test, maps, activation and key handling are integration-tested in `apps/api/src/integration-settings.integration.test.ts` against the same kind of fake server. Not live-tested. The Shopify mock import tests are unchanged.
