# Accountant export: generic layout (R2-G2)

This is the generic layout pending answer **A9** (the accountant's software and import format) in [release-2.md](../plan/release-2.md). It is not a software-specific import or a statutory return. Screens are R2-G3.

`GET /api/c/:companyId/exports/accountant?from=YYYY-MM-DD&to=YYYY-MM-DD&pdfs=false` requires `invoice.export` and the existing privileged MFA policy. Dates are inclusive business dates, with `from <= to` and at most 366 days. Invalid dates return 422 `invalid_date`. `pdfs` defaults to `false`; only literal `true` and `false` are accepted. The response is `application/zip`, downloaded as `accountant-export-<from>-<to>.zip`.

All database reads use one repeatable-read tenant snapshot. Every archive includes a root `README.txt` in plain UTF-8 that names the inclusive period, files and every CSV column, with the VAT-group and positive-credit-note conventions below. CSVs always exist, even when they contain only their header. Drafts, quotes and cancelled documents are excluded. Payments and refunds include voided records; allocations include reversed records. These are reconciliation records with their current status, rather than netted report totals. An item selected by either of two dates appears once. Related documents outside the period are referenced by number without adding their lines or PDFs to the export.

## CSV format and values

- UTF-8 with a BOM in **each** CSV, comma delimiters and CRLF record endings. Fields containing a comma, double quote, CR or LF are double-quoted; embedded quotes are doubled (RFC 4180).
- Text beginning with `=`, `+`, `-`, `@`, tab or carriage return has a leading apostrophe added for spreadsheet safety. This is the only change to customer text, apart from CSV quoting. Greek, embedded CR/LF, punctuation and whitespace are preserved. Consumers needing the original text should remove that safety apostrophe only when followed by one of those characters.
- Decimal cells are plain decimal strings, never spreadsheet-prefixed and never converted through JavaScript numbers. Money has 2 fractional digits; quantities, unit prices and tax rates have 4; discount percentages have 2. Use a dot as the decimal separator and no grouping separator.
- Credit-note amounts are positive. Use `document_type` to subtract credits from invoices; allocation and refund amounts are also positive. Unit prices follow the document's `prices_include_tax` setting.
- Dates are `YYYY-MM-DD` company business dates. `issued_at` is a UTC ISO timestamp ending in `Z`. Missing optional values are empty cells. UUIDs, document numbers, positions and boolean `true`/`false` values are text cells.
- Buyer details and tax labels come from the frozen issued snapshots. Payment client names and series codes are their current values. No storage keys, internal paths, credential data, email addresses or bank details are exported.

Columns below appear in the exact listed order.

## `invoices.csv`

One row per issued invoice or credit note with `issue_date` inside the period.

| Column                    | Meaning                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `id`                      | Document UUID.                                                          |
| `document_type`           | `invoice` or `credit_note`.                                             |
| `number`                  | Issued document number.                                                 |
| `series_code`             | Current code of the series used to issue the document.                  |
| `issue_date`              | Issue business date; selection basis.                                   |
| `supply_date`             | Supply business date.                                                   |
| `due_date`                | Stored due business date; credit notes store their issue date here.     |
| `client_id`               | Client UUID.                                                            |
| `buyer_name`              | Snapshotted legal name, or display name when there is no legal name.    |
| `buyer_vat_number`        | Snapshotted buyer VAT number, empty if absent.                          |
| `currency`                | Document currency code.                                                 |
| `prices_include_tax`      | `true` or `false`; interpretation of the stored unit prices.            |
| `net`                     | Document net total, 2 decimals.                                         |
| `tax`                     | Document tax total, 2 decimals.                                         |
| `total`                   | Document gross total, 2 decimals.                                       |
| `credited_invoice_number` | Original invoice number for a credit note; otherwise empty.             |
| `credit_reason`           | Original credit reason, with the CSV text safety rule; otherwise empty. |
| `issued_at`               | Exact issuance timestamp in UTC ISO format.                             |

## `invoice_lines.csv`

Lines of the exported documents, ordered by document, then position and line UUID.

| Column                 | Meaning                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document_number`      | Parent document number.                                                                                                                                                                                                                               |
| `position`             | Stored line position, an integer represented as text.                                                                                                                                                                                                 |
| `description`          | Original description, with CSV text safety.                                                                                                                                                                                                           |
| `quantity`             | Quantity, 4 decimals.                                                                                                                                                                                                                                 |
| `unit`                 | Stored unit text.                                                                                                                                                                                                                                     |
| `unit_price`           | Stored unit price, 4 decimals; includes VAT only when the parent flag says so.                                                                                                                                                                        |
| `discount_percent`     | Percentage discount, 2 decimals.                                                                                                                                                                                                                      |
| `tax_code`             | Code from the line's frozen tax snapshot.                                                                                                                                                                                                             |
| `tax_rate`             | Stored tax percentage, 4 decimals (for example `19.0000`).                                                                                                                                                                                            |
| `line_net`             | Stored line amount excluding tax after discount, 2 decimals.                                                                                                                                                                                          |
| `line_amount_incl_vat` | Line amount including VAT after discount, 2 decimals, populated only when the parent document has `prices_include_tax=true`; empty otherwise. VAT is calculated and rounded per tax-code group: use `tax_summary.csv` for VAT and group gross totals. |

## `tax_summary.csv`

One stored tax-code group per exported document, ordered by document then tax-code UUID.

| Column            | Meaning                                    |
| ----------------- | ------------------------------------------ |
| `document_number` | Parent document number.                    |
| `tax_code`        | Code from the group's frozen tax snapshot. |
| `tax_name`        | Name from the group's frozen tax snapshot. |
| `tax_rate`        | Stored tax percentage, 4 decimals.         |
| `net`             | Group net total, 2 decimals.               |
| `tax`             | Group tax total, 2 decimals.               |
| `gross`           | Group gross total, 2 decimals.             |

## `payments.csv`

Payments with `received_on` inside the period, ordered by that date then UUID. A payment received outside the period is not selected solely because it was voided in the period.

| Column        | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `id`          | Payment UUID.                                                         |
| `client_id`   | Client UUID.                                                          |
| `client_name` | Client's current display name.                                        |
| `received_on` | Receipt business date; selection basis.                               |
| `amount`      | Recorded payment amount, 2 decimals.                                  |
| `currency`    | Payment currency code.                                                |
| `method`      | Recorded method: `bank_transfer`, `cash`, `card`, `store` or `other`. |
| `reference`   | Original reference, with CSV text safety.                             |
| `status`      | Current `recorded` or `voided` status.                                |
| `voided_on`   | Void business date, empty while recorded.                             |
| `void_reason` | Original void reason, with CSV text safety; empty while recorded.     |

## `allocations.csv`

Allocations with `effective_on` **or** `reversed_on` inside the period, ordered by effective date then UUID. Separate source columns avoid ambiguity: exactly one of `payment_id` and `credit_note_number` is populated.

| Column               | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `id`                 | Allocation UUID.                                                    |
| `source_type`        | `payment` or `credit_note`.                                         |
| `payment_id`         | Source payment UUID, empty for a credit-note source.                |
| `credit_note_number` | Source credit-note number, empty for a payment source.              |
| `invoice_number`     | Target invoice number.                                              |
| `amount`             | Allocated amount, 2 decimals.                                       |
| `effective_on`       | Allocation effective business date; first selection basis.          |
| `reversed_on`        | Reversal business date; second selection basis; empty while active. |
| `reversal_reason`    | Original reversal reason, with CSV text safety; empty while active. |

## `refunds.csv`

Refunds with `refunded_on` **or** `voided_on` inside the period, ordered by refund date then UUID. Exactly one source column is populated, as for allocations.

| Column               | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `id`                 | Refund UUID.                                                          |
| `source_type`        | `payment` or `credit_note`.                                           |
| `payment_id`         | Source payment UUID, empty for a credit-note source.                  |
| `credit_note_number` | Source credit-note number, empty for a payment source.                |
| `amount`             | Refund amount, 2 decimals.                                            |
| `refunded_on`        | Refund business date; first selection basis.                          |
| `method`             | Recorded method: `bank_transfer`, `cash`, `card`, `store` or `other`. |
| `reference`          | Original reference, with CSV text safety.                             |
| `status`             | Current `recorded` or `voided` status.                                |
| `voided_on`          | Void business date; second selection basis; empty while recorded.     |

## PDFs, limits and audit

With `pdfs=true`, each exported document also has `pdfs/<number>.pdf`. The number is percent-encoded as a single path component (`encodeURIComponent`), so a legal number such as `INV/00001` becomes `pdfs/INV%2F00001.pdf`; decoding the filename recovers the exact number. No filename is derived from a storage key. Every file is read through the shared size/SHA-256 verified reader and its original stored bytes are exported. A failed integrity check aborts the entire export with 409 `file_integrity_failed` and records the existing `file.integrity_failed` audit event as well as the export failure. PDFs are read, verified and compressed one at a time; only compressed entries are retained. Every PDF and ZIP limit is checked before the response begins, then prepared chunks are streamed without concatenating a complete archive buffer. No partial archive or temporary archive is written.

Before reading any PDF, the export sums the selected documents' `stored_file.size_bytes`. More than 150 MiB (157,286,400 bytes) returns 422 `export_too_large`, suggesting a shorter period or an export without PDFs. Exactly 150 MiB is allowed. The 1,000-PDF limit also remains: more than 1,000 requested PDFs returns the same code, suggesting a shorter period. CSV-only exports have neither PDF limit. The built-in ZIP writer uses DEFLATE, CRC-32 and UTF-8 names, with no ZIP64. It refuses more than 65,535 entries or an archive, entry or aggregate uncompressed content reaching the classic ZIP 4 GiB limit; the route returns `export_too_large`.

Once every file is verified and the ZIP is ready, `invoice.export_prepared` records success with the period, whether PDFs were requested, the selected PDF byte total (`pdfSizeBytes`, zero without PDFs), the complete ZIP size (`totalSizeBytes`), file counts (`csv`, `pdfs`, `total`, including the README in `total`), and row counts for all six CSVs. Preparation does not mean the download completed.

Exactly one subsequent `invoice.exported` event records the transfer outcome: success after the response finishes sending, or failure if it closes, errors or the client disconnects before completion. Both retain the preparation details. An interrupted transfer adds `reason: transfer_interrupted` and `bytesSent`, the body bytes in completed writes (excluding headers and any unfinished write, bounded to 64 KiB). These events use their own short tenant transaction after the response event, with the original actor and correlation id.

Refusals before streaming retain the existing `invoice.exported` failure audit and have no `invoice.export_prepared`; file counts remain zero because no archive was prepared. Invalid or repeated date parameters are recorded as null when they cannot safely be represented as a date string; arbitrary query content and adapter error messages are never copied into the audit. Permission, MFA and foreign-company refusals are recorded by the existing guard as `authorization.denied`, without a preparation event.
