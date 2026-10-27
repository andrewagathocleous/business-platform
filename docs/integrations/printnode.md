# PrintNode

The mock provider remains for development and tests. Its `provider` field is `mock` and its label is `Simulated — no physical printing`. It does not read an API key. R1-D adds a PrintNode client. That client is mock-tested and integration-tested against a fake server. It is not live-tested and not sandbox-tested. No physical printer is attached.

## What Phase 1 has

The contract is `PrintProvider` in `packages/integrations/src/printing/provider.ts`. Methods: `listPrinters`, `submit`, `getJobState`. `MockPrintProvider` in `packages/integrations/src/printing/mock.ts` writes a PDF under `MOCK_PRINT_ROOT/<companyId>/<printJobId>.pdf` and a JSON state file beside it. The file's states are `submitted` and `done` (`ProviderJobState`). `getJobState` writes `done` before it returns, so the first refresh already receives `{ state: 'done' }` and the job becomes `done_reported`. The public status type is `ProviderJobStatus`: `pending`, `delivered`, `done` and `failed`. The worker maps `delivered` to `delivered_to_printer` and keeps polling, and `done` to `done_reported`.

The catalogue is three fictional printers:

<!-- prettier-ignore -->
| External id | Behaviour |
| --- | --- |
| `mock-laserjet-online` | Writes the PDF. The next `getJobState` moves `submitted` to `done` |
| `mock-offline` | Throws `PrinterOffline` and writes no PDF |
| `mock-flaky` | Throws `ProviderTimeout` and writes no PDF |

The worker in `apps/api/src/printing/print.processor.ts` is what the staff API talks to. Print-job statuses in Postgres (`print_job_status`) are `queued`, `held`, `submitting`, `submitted`, `delivered_to_printer`, `done_reported`, `confirmed_printed`, `not_printed`, `failed`, `uncertain` and `cancelled`.

A successful mock submit is stored as `submitted`. The first refresh then becomes `done_reported`, because the mock has already moved its file to `done`. `done_reported` means the provider reported done. It does not mean paper came out. The label in `apps/api/src/printing/print-label.ts` says `Sent to printer (provider reported done — not confirmed)`. A person confirms `confirmed_printed` or `not_printed`. PrintNode `done` is the same: the job reached the operating-system queue, not the paper.

**Switch check at execution.** `switchesOn` runs when the worker claims the print, not when the job was queued. It requires the global `outbound.all` row to be enabled and the company's `printing` row to be enabled. If either is missing or off, the print job becomes `held` with `printing_disabled` and the provider is not called. Turning the switch off after queueing still holds the job. Release can print later if the switches are on at that execution.

The seed turns `outbound.all` on and company A's `printing` on. Company B's `printing` is off. `compose.prod.yml` does not run the seed, so a production database has neither row until a platform owner creates them. The worker then holds the job.

**Idempotency.** The print-job row uses idempotency key `pj_<printJobId>` (`apps/api/src/printing/print.service.ts`). The mock stores that key in the state file. A second submit of the same print job and the same key returns the existing provider job id and does not write the PDF again. A different key for an existing state file throws `ProviderRejected` (`idempotency_key_mismatch`). One non-reprint job per order and document type is also enforced by the partial unique index `print_job_one_first_print_key` in `packages/db/prisma/migrations/20261018234900_rls/migration.sql` (statuses `failed`, `cancelled` and `not_printed` are excluded).

**Uncertain.** `PrinterOffline` becomes `failed` (`printer_offline`). `ProviderRejected` becomes `failed` with `error.message` (the mock's default message is still `provider_rejected`). `ProviderTimeout` becomes `uncertain` (`provider_timeout`). `ProviderUncertain` becomes `uncertain` with its reason. Any other provider error becomes `uncertain` (`provider_unknown`). `uncertain` is written from `submitting`. The worker does not submit that job again. A later confirm or cancel is a person's decision. Reclaim of a print job that is already `submitting` sets the print job and the queue job to `uncertain` rather than queueing another submit.

### How it was tested

Mock-tested and integration-tested against real Postgres. Not sandbox-tested and not live-tested. No PrintNode account is configured.

<!-- prettier-ignore -->
| Test | Level | What it shows |
| --- | --- | --- |
| `packages/integrations/src/printing/mock.test.ts` `labels itself as simulated and writes the online printer PDF` | unit | The mock label and the PDF write |
| `packages/integrations/src/printing/mock.test.ts` `fails offline and times out the flaky printer without writing a PDF` | unit | Offline and timeout |
| `apps/api/src/printing.integration.test.ts` `prints a gift message once, reports done without calling it printed, and blocks a second first print` | integration | `done_reported` is not confirmed printed |
| `apps/api/src/printing.integration.test.ts` `lets ten concurrent first prints create exactly one job` | integration | First-print idempotency |
| `apps/api/src/printing.integration.test.ts` `fails an offline printer and leaves a timeout uncertain without a second submit` | integration | `failed` versus `uncertain` |
| `apps/api/src/printing.integration.test.ts` `holds a job when printing is switched off after queueing, then prints on release` | integration | Switch check at execution |
| `apps/api/src/printing.integration.test.ts` `holds company B jobs because printing is off` | integration | Company B stays held |
| `apps/api/src/printing.integration.test.ts` `settles a hanging submit as uncertain within the timeout and records the late result` | integration | A lost reply stays `uncertain` |

`node tools/smoke-dist.mjs` submits one PDF through `MockPrintProvider` after `pnpm build`. That is a smoke check of the built package, not a PrintNode call.

## What R1-D adds

`PrintNodeProvider` in `packages/integrations/src/printing/printnode.ts` calls PrintNode through the shared `createSafeFetch` client (`SAFE_FETCH`). The default origin is `https://api.printnode.com`. Every call sends `Authorization: Basic` with the API key as the username and an empty password. The key is not put on an error message, an error property, a return value or a log line.

The API loads the newest `integration_credential` row for the company with `provider = printnode`, `label = api_key` and `revoked_at` null, through `TenantDb`, then decrypts it with `CredentialVault.decrypt` in a separate transaction. No row means `ProviderRejected('not_configured')`, and that error is rethrown. Any other failure from the lookup, including a decrypt error, becomes `ProviderRejected('credential_unavailable')` before a request on list, submit and state. The original error is not copied into the message. The Integrations screen stores the key with `PUT /c/:companyId/print-accounts/printnode` (`printer.manage`). `GET` returns `{ keySet, keySetAt }` and does not call PrintNode. `POST …/test` calls `GET /whoami` with a 15 second timeout and returns `{ ok: true, email }` or `{ ok: false, errorClass }`. The audit records the class, not the email. No route returns the key. Discovery treats a non-revoked row as usable and does not decrypt it just to choose the provider.

`POST /printers/discover` takes an optional `provider` of `mock` or `printnode`. With no provider, a usable key selects PrintNode; otherwise the mock is used when this process is `development` or `test`. In `uat` and `production` `MOCK_PRINT_PROVIDER` is null, so no mock instance is constructed, and `get('mock')` throws `ProviderRejected('provider_unavailable')`. A requested provider the registry does not have is 400 `print_provider_unavailable`. No key and no mock is 409 `print_provider_not_configured`. Upsert uses the chosen provider. The `printer.discovered` audit names it. The web admin still omits `provider`.

### Printers

`GET /printers?limit=500`.

| `ListedPrinter`     | PrintNode                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `externalPrinterId` | `String(id)`                                                                                |
| `name`              | `name`                                                                                      |
| `description`       | `computer.name`, or `''`                                                                    |
| `paperSizes`        | `Object.keys(capabilities.papers ?? {})`                                                    |
| `status`            | `state === 'online'` is `online`; another non-empty state is `offline`; otherwise `unknown` |

401 or 403 is `ProviderRejected('auth_failed')`. A `SafeFetchError` with `sent: false` is `provider_unreachable`. Any other list failure is `bad_response`, because a read can be repeated.

### Submit

`POST /printjobs`, `content-type: application/json`, header `X-Idempotency-Key` set to the print job's `pj_<printJobId>`. The body is `printerId` (the numeric external id), `title` (document type and the order's external number, not a customer name), `contentType: "pdf_base64"`, `content` (the PDF in base64), `source: "business-platform"`, `options: { copies, paper }` and `expireAfter: 86400`. A non-numeric printer id is `bad_request` before any call.

| Outcome                             | Result                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 201 and a positive integer          | `{ providerJobId }`                                                                                              |
| 201 and any other body              | `ProviderUncertain('bad_response')`                                                                              |
| 400                                 | `ProviderRejected('bad_request')`                                                                                |
| 401 or 403                          | `ProviderRejected('auth_failed')`                                                                                |
| 404                                 | `ProviderRejected('printer_not_found')`                                                                          |
| 409                                 | `ProviderUncertain('idempotency_collision')`                                                                     |
| 429                                 | `ProviderRejected('rate_limited')`                                                                               |
| 5xx or any other status             | `ProviderUncertain('provider_status_<code>')`                                                                    |
| `SafeFetchError` with `sent: false` | `ProviderRejected('provider_unreachable')`                                                                       |
| `SafeFetchError` with `sent: true`  | `ProviderUncertain(error.code)`                                                                                  |
| `ProviderRejected` from `apiKeyFor` | rethrown, so PrintNode is not called                                                                             |
| any other error from `apiKeyFor`    | `ProviderRejected('credential_unavailable')` before a request. The original error is not copied into the message |
| anything else thrown while sending  | `ProviderUncertain('provider_unknown')`                                                                          |

`sent` is taken only from `error.sent`. Submit does not retry. `print.submit` stays non-retryable.

### Job states

`GET /printjobs/<id>/states`. The body may be an array of state objects or an array of arrays; one level is flattened. States for other job ids are ignored. The latest `createTimestamp` wins. `raw` is PrintNode's state string.

| PrintNode state            | `ProviderJobStatus`              | Print job                                                                                                               |
| -------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `new`                      | `pending`                        | stays `submitted` or `delivered_to_printer`; `provider_state` is the raw value; poll again                              |
| `sent_to_client`           | `delivered`                      | `delivered_to_printer`; poll again                                                                                      |
| `done`                     | `done`                           | `done_reported`; stop. Not confirmed printed                                                                            |
| `error`                    | `failed`, reason `printer_error` | `failed`. `last_error` is `printer_error` plus `: <message>` when the message survives cleaning, at most 240 characters |
| `expired`                  | `failed`, reason `expired`       | `failed`                                                                                                                |
| `deleted`                  | `failed`, reason `deleted`       | `failed`                                                                                                                |
| anything else, or no state | `pending`                        | poll again                                                                                                              |

Messages lose control characters, then trim, then keep at most 200 characters. A failed refresh audits `print_job.failed` with `{ provider, reason }` and does not enqueue another refresh.

401 or 403 on a state read is `ProviderRejected('auth_failed')`. Any other failure, including a network error, throws `ProviderRejected('bad_response')` or the `SafeFetchError`. The refresh job retries. A refresh error is not turned into `uncertain`.

### Refresh back-off

The refresh payload is `{ printJobId, refresh: n }`. The delay is `min(2s × 2^n, 300s)`. The first refresh, queued when submit succeeds, uses `n = 0` (2 seconds). Each follow-up uses `n + 1`. A payload without `refresh` is treated as `0`. The idempotency key of the first refresh stays `print.refresh:<printJobId>`. A follow-up uses `print.refresh:<printJobId>:<job id>`.

Before the provider is read, and again before a follow-up is queued, polling stops once `submitted_at` is more than 26 hours ago. PrintNode is not called, the status is left as it is, and the queue job finishes succeeded. The audit `print_job.refresh_stopped` is written once, with `{ provider }`.

### What was verified from the PrintNode docs

The checks that used to sit in "What Phase 2 must verify" are answered by the facts in [docs/plan/release-1.md](../plan/release-1.md) (checked 2026-10-23) and implemented as above. They are not live-tested:

- Auth is HTTP Basic with the API key as the username. The client sends that header. A live account is still U6.
- `GET /printers` returns `id`, `name`, `state`, `computer` and `capabilities.papers`. The client maps those fields. `options.paper` is the mapping's paper size, which must be one of those names. `PUT /printer-mappings` already rejects a paper size the printer does not list.
- `POST /printjobs` accepts `pdf_base64`, copies and paper. The client sends that body and `expireAfter: 86400` (the documented default is 14 days; this shorter expiry is the plan's stale-job limit).
- A duplicate `X-Idempotency-Key` is documented as 409, and keys can be reused after 24 hours. The client treats 409 as `uncertain` and does not submit again.
- States include `new`, `sent_to_client`, `done`, `error` and `expired`. `done` is the operating-system queue, not paper. The worker never stores that as `confirmed_printed`.
- PDF bytes go as base64. A URI upload is not used.

Still not done, and still not live-tested: a PrintNode account, the shop PC, and a physical test print (P2-11, U6, U7). The Integrations screen can store and test a key; that path is tested against a fake server, not a live account (U6). The printers page does not yet show the PrintNode computer's own state; that UI is outside this step. `GET /computers` is not called.

### How R1-D was tested

Mock-tested, and integration-tested against a fake PrintNode on `127.0.0.1` with real Postgres. Not sandbox-tested and not live-tested.

| Test                                                   | Level                    | What it shows                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/integrations/src/printing/printnode.test.ts` | unit                     | Mapping, the exact Basic header and submit body, status codes, a hang, a closed port, both state-list shapes, message cleaning, and that the key is absent from thrown errors                                                                                                                                                                                                       |
| `apps/api/src/printing/print-providers.test.ts`        | unit                     | `development` registers the mock; `production` and `uat` do not                                                                                                                                                                                                                                                                                                                     |
| `apps/api/src/config/env.test.ts`                      | unit                     | `PRINTNODE_BASE_URL` and `OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS` are refused unless `APP_ENV=test`                                                                                                                                                                                                                                                                                      |
| `apps/api/src/printing/refresh-delay.test.ts`          | unit                     | `min(2s × 2^n, 300s)`                                                                                                                                                                                                                                                                                                                                                               |
| `apps/api/src/printnode.integration.test.ts`           | integration, fake server | Discovery from a vault key, one submit with `pj_<printJobId>`, `sent_to_client` then `done` without `confirmed_printed`, a printer error that allows another first print, a 409 that stays `uncertain`, no key, a refresh older than 26 hours that does not call PrintNode, a decrypt failure that fails as `credential_unavailable`, and no mock instance in `production` or `uat` |

`PRINTNODE_BASE_URL` and `OUTBOUND_ALLOW_LOOPBACK_FOR_TESTS` are test-only. They are not in `.env.example`.

## What Phase 2 must verify

The provider facts above are implemented and still not live-tested. Before a real print (R1-H, U6):

- A PrintNode account and the client on the shop PC, with both printers visible.
- A key typed into the Integrations screen, never into chat or the repository.
- One approved test print of a gift card and one of a packing slip. `done_reported` stays "not confirmed" until a person confirms it.

P2-11 remains the physical test print and the card stock.

## Credentials

A PrintNode API key lives in the credential vault when a row is stored: `CredentialVault` in `apps/api/src/vault/credential-vault.ts`, AES-256-GCM, keys from `APP_MASTER_KEYS`. See [docs/adr/0007-credentials-and-outbound-safety.md](../adr/0007-credentials-and-outbound-safety.md). The loader is `PrintNodeCredentials` in `apps/api/src/printing/printnode-credentials.ts`. The Integrations screen writes the row. `GET` does not return the account email; the test does, and that email is not stored. No route returns the plaintext. The mock does not read a key. Storing and testing the key is integration-tested in `apps/api/src/integration-settings.integration.test.ts` against a fake PrintNode, not live-tested.
