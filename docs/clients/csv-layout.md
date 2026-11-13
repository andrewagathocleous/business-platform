# Client CSV layout (R2-H1)

`GET /api/c/:companyId/clients/export.csv` requires `client.export` and privileged MFA.
It exports all company clients, including archived clients, in one repeatable-read
snapshot, read in id-ordered batches of 500. At most 20,000 clients and 64 MiB of
encoded CSV; a larger export receives 422 `export_too_large` before any file bytes
are sent. Prepared chunks are streamed with bounded writes.
The download is `clients-YYYY-MM-DD.csv`, dated in the company timezone.

Export and import share these columns, in this export order:

| Column               | Value / validation                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| kind                 | Required: `organisation` or `person`. `person` maps to the existing database/API `individual` kind.                              |
| display_name         | Required, at most 500 characters; must contain a non-whitespace name.                                                            |
| legal_name           | Optional, at most 500 characters.                                                                                                |
| vat_number           | Optional, at most 40 characters, matching the existing client form. The form does not impose a jurisdiction-specific VAT syntax. |
| tax_id               | Optional, at most 40 characters.                                                                                                 |
| email                | Optional, valid email, at most 320 characters.                                                                                   |
| phone                | Optional, at most 80 characters.                                                                                                 |
| website              | Optional, at most 300 characters.                                                                                                |
| notes                | Optional, at most 20,000 characters. Greek, whitespace and line breaks are preserved.                                            |
| default_currency     | Optional, three uppercase letters, e.g. `EUR`.                                                                                   |
| default_language     | Optional: `en` or `el`; blank inherits the company default.                                                                      |
| payment_terms_days   | Optional, whole days from 0 to 3650. Zero means due on receipt and round-trips through export/import.                            |
| accepts_e_invoices   | Optional: `true` or `false`; blank means false.                                                                                  |
| billing_line1        | Default billing address, at most 300 characters. Required when any billing field is given.                                       |
| billing_line2        | Optional, at most 300 characters.                                                                                                |
| billing_city         | Default billing city, at most 160 characters. Required when any billing field is given.                                          |
| billing_region       | Optional, at most 160 characters.                                                                                                |
| billing_postal_code  | Optional, at most 40 characters.                                                                                                 |
| billing_country_code | Two letters, required when any billing field is given.                                                                           |

Export appends `archived` (`true` or `false`). Import accepts and ignores that column;
import never archives or updates an existing client. Only the default billing
address is transferred; contacts and other addresses are outside this layout.

CSV is UTF-8. Export uses the shared R2-G2 writer: BOM, CRLF record separators,
RFC 4180 quoting, and a leading apostrophe on text starting with `=`, `+`, `-`,
`@`, tab or CR to prevent spreadsheet formulas. Import accepts an optional BOM,
CRLF or LF records, quoted commas, doubled quotes and quoted line breaks. It
removes exactly one apostrophe only before those formula-leading characters.
No other customer text is trimmed, rewritten or case-normalised. Empty optional
text cells become null, empty terms become null, and an entirely empty billing
address creates no address. NUL is refused because PostgreSQL cannot store it.

A header is required. Import column order is free. Only `kind` and `display_name`
headers are mandatory; omitted optional columns behave like empty cells. Unknown
columns are refused with 422 `unknown_columns` and all their names. Repeated
headers, malformed quoting, bare unquoted CR and inconsistent column counts are
also refused. Row numbers are logical CSV record numbers (header is 1), so a
quoted line break does not advance the number.

## Preview and confirm API

1. `POST /api/c/:companyId/clients/imports`, permission `client.import` with
   privileged MFA, takes `{ fileName, content }`. Only this route accepts JSON up
   to 4 MiB; every other route keeps its 1 MiB limit. Maximum 5,000 data rows
   (422 `too_many_rows`). File name is 1–255 characters. The SHA-256 is over the
   original UTF-8 CSV text, including a BOM and its original line endings.
2. The response is `{ import: { id, status, fileName, sha256, rowCount, counts,
rows, createdAt, appliedAt, appliedCount } }`. Each row has `number`, `status`
   (`new`, `duplicate` or `error`), `values` keyed by column name and `messages`
   with `field`, `code` and readable `message`. Validation errors take precedence.
   Duplicates use the same normalised name, email and VAT keys as client duplicate
   checking, including archived clients and all earlier file rows, even invalid
   ones. Messages identify only the client id or earlier row number, never copy
   the matched client's or row's field values. Each field is bounded by its client
   schema limit (scalar CSV spellings: kind 12, currency 3, language 2, terms 4,
   boolean 5, country 2 characters). An oversized field is a `too_long` row error;
   lengths use UTF-16 units, matching the client schema, and the stored error preview
   ends before a code point that would cross the limit. An uploaded unpaired high
   or low surrogate is an `invalid_unicode` row error; its preview representation
   uses U+FFFD so it can be stored in JSONB, and the row cannot be imported.
   Valid customer text is preserved exactly. A stored rows JSON payload above
   16 MiB, including UTF-8 bytes and JSON escapes, is refused with 422
   `preview_too_large` before saving a preview.
3. `GET /api/c/:companyId/clients/imports/:id`, permission `client.import`,
   returns the stored preview in the same wrapper for a page reload.
4. `POST /api/c/:companyId/clients/imports/:id/confirm`, permission `client.import`
   with privileged MFA, takes `{ expectedSha256 }`. It locks the preview, refuses
   an applied preview with 409 `already_applied`, expires previews older than 24
   hours with 409 `preview_expired`, and refuses a different hash with 409
   `preview_changed`. Expiry is stored even though confirm is refused.
5. Confirm rechecks initially new rows against current clients, serialised with
   company client creates/edits and other imports. Newly discovered duplicates are
   skipped and saved as duplicates. Initially duplicate/error rows stay skipped.
   The remaining new rows are created through the shared client-service creation
   path with a default billing address. One transaction applies every row and marks
   the preview applied. The result is `{ appliedCount, counts: { new, duplicate,
error } }`; `new` is the number actually created. Applied previews keep those
   rows classified `new`, and show `status: applied` and `appliedCount`.

Export audits `client.export_prepared` once the file is ready, then exactly one
`client.exported`: success when the last byte is sent, or failure with reason
`transfer_interrupted` and the count of flushed bytes on close, error or disconnect.
Both include the row count and total encoded size. The transfer audit runs in its
own short tenant transaction with the original correlation id.

Other audit actions are `client.import_previewed`
(row count and classification counts), and `client.imported` (applied count,
classification counts and the count accepting e-invoices). Applied imports use
one summarising audit instead of up to 5,000 `client.created` events. The stored
preview retains each row's consent value and the creating/applying actor and time.
Business refusals are audited with their reason and request correlation id;
authorisation refusals use the existing `authorization.denied` path. JSON-parser
refusals (for example 413) follow the existing global HTTP error path.

The `client_import` table has forced tenant RLS, a `(company_id, id)` key, a
company foreign key and global user-account actor foreign keys. It references no
other tenant object. `bp_app` can insert, select and update; it cannot delete or
truncate. Another company's preview id is 404.
