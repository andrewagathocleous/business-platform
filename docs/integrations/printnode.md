# PrintNode

Phase 1 does not call PrintNode. The only provider is the mock in `packages/integrations/src/printing/`. Its `provider` field is `mock` and its label is `Simulated — no physical printing`. No API key is configured.

## What Phase 1 has

The contract is `PrintProvider` in `packages/integrations/src/printing/provider.ts`. Methods: `listPrinters`, `submit`, `getJobState`. The mock's own states are `submitted` and `done` (`ProviderJobState`). `MockPrintProvider` in `packages/integrations/src/printing/mock.ts` writes a PDF under `MOCK_PRINT_ROOT/<companyId>/<printJobId>.pdf` and a JSON state file beside it.

The catalogue is three fictional printers:

<!-- prettier-ignore -->
| External id | Behaviour |
| --- | --- |
| `mock-laserjet-online` | Writes the PDF. The next `getJobState` moves `submitted` to `done` |
| `mock-offline` | Throws `PrinterOffline` and writes no PDF |
| `mock-flaky` | Throws `ProviderTimeout` and writes no PDF |

The worker in `apps/api/src/printing/print.processor.ts` is what the staff API talks to. Print-job statuses in Postgres (`print_job_status`) are `queued`, `held`, `submitting`, `submitted`, `delivered_to_printer`, `done_reported`, `confirmed_printed`, `not_printed`, `failed`, `uncertain` and `cancelled`.

A successful mock submit is stored as `submitted`. A later refresh maps provider `submitted` to `delivered_to_printer` and provider `done` to `done_reported`. `done_reported` means the provider reported done. It does not mean paper came out. The label in `apps/api/src/printing/print-label.ts` says `Sent to printer (provider reported done — not confirmed)`. A person confirms `confirmed_printed` or `not_printed`.

**Switch check at execution.** `switchesOn` runs when the worker claims the print, not when the job was queued. It requires the global `outbound.all` row to be enabled and the company's `printing` row to be enabled. If either is missing or off, the print job becomes `held` with `printing_disabled` and the provider is not called. Turning the switch off after queueing still holds the job. Release can print later if the switches are on at that execution.

The seed turns `outbound.all` on and company A's `printing` on. Company B's `printing` is off. `compose.prod.yml` does not run the seed, so a production database has neither row until a platform owner creates them. The worker then holds the job.

**Idempotency.** The print-job row uses idempotency key `pj_<printJobId>` (`apps/api/src/printing/print.service.ts`). The mock stores that key in the state file. A second submit of the same print job and the same key returns the existing provider job id and does not write the PDF again. A different key for an existing state file throws `ProviderRejected` (`idempotency_key_mismatch`). One non-reprint job per order and document type is also enforced by the partial unique index `print_job_one_first_print_key` in `packages/db/prisma/migrations/20261018234900_rls/migration.sql` (statuses `failed`, `cancelled` and `not_printed` are excluded).

**Uncertain.** `PrinterOffline` becomes `failed` (`printer_offline`). `ProviderRejected` becomes `failed` (`provider_rejected`). `ProviderTimeout` becomes `uncertain` (`provider_timeout`). Any other provider error becomes `uncertain` (`provider_unknown`). `uncertain` is written from `submitting`. The worker does not submit that job again. A later confirm or cancel is a person's decision. Reclaim of a print job that is already `submitting` sets the print job and the queue job to `uncertain` rather than queueing another submit.

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

## What Phase 2 must verify

**Planned (Phase 2), not implemented.** There is no PrintNode HTTP client in this repository. Before building one, record the checks from [provider-constraints.md](provider-constraints.md) (source checked as a to-do, not as a passed integration):

- API auth, the printers and computers endpoints, and `printjobs` options (copies, paper, tray).
- The idempotency header and its dedupe window.
- Job states, including that `done` does not mean the paper came out. Phase 1 already refuses to treat mock `done` as confirmed printed. The live provider has to be checked the same way.
- PDF delivery by base64 versus URI.

Backlog item P2-06 in [docs/BACKLOG.md](../BACKLOG.md): account setup, printer discovery, the idempotency header, state polling or webhooks, PDF delivery, and a test print that needs explicit approval. P2-11 is gift-card stock and a physical test print, also with explicit approval.

`PrintSlot.provider` in `print-label.ts` allows the string `printnode` next to `mock`. No code path sets a live PrintNode provider. Discovery and submit in Phase 1 always use the mock.

## Credentials

**Planned (Phase 2), not implemented.** A PrintNode API key will live in the credential vault from plan step C7: `CredentialVault` in `apps/api/src/vault/credential-vault.ts`, AES-256-GCM, keys from `APP_MASTER_KEYS`. See [docs/adr/0007-credentials-and-outbound-safety.md](../adr/0007-credentials-and-outbound-safety.md).

No route calls the vault. Phase 1 stores no PrintNode credential. The mock does not read an API key.
