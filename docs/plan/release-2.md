# Release 2 plan: invoicing and receivables

Owner: planner (Claude Code). Implementer: Cursor CLI (Claude Code while Cursor is at its weekly limit). Reviewer: Codex CLI.
Written 2026-10-27, on the local branch `r2-invoices`. Nothing from R2 is pushed until the user has promoted Release 1 to `deploy_prod` (user, 2026-10-27). Revised the same day after a Codex plan review: 11 P0 and 4 P1 findings, all addressed below.

**Goal.** The company issues real, correctly numbered invoices and credit notes from the platform, records payments against them, sees what is unpaid and how old it is, and hands the accountant a clean export. Every step is in the strict "money, tax and invoice issuance" area: every review finding blocks, and reviews run at `xhigh`.

**Already built (Phase 1).**
- Clients with contacts and addresses; products.
- Tax codes and invoice series, created by the seed only.
- Draft quotes and invoices: lines, discounts, shipping lines and backend totals (`docs/finance/rounding.md`).
- A draft PDF, and `POST /invoices/preview-totals`.
- Permissions `invoice.issue`, `invoice.credit`, `invoice.export`, `invoice.series.manage`, `payment.record`, `report.finance.view`, `tax.manage`, `company.bank.manage`, `client.import` and `client.export`. They are catalogued, mostly unused.
- The company switch `invoice.issue_real`, off.
- `store.invoice_authority`, `company_bank_account` and `stored_file.sha256`.

**Not in R2.**
- Emailing invoices, statements and reminders (R5, with P3-05).
- **Invoices built from shop orders** (R2-02, backlog). The stored order lines lose price precision (the raw `0.3333 × 3` becomes `0.33`, with a line total of `1.00`) and carry no tax code. Building them needs answer A1, retained raw prices and a tax mapping.
- **Currencies other than the company currency.**
- General ledger, bank feeds, reconciliation, payroll and statutory returns.
- Document-level discounts, cash rounding, OSS returns, and logos on PDFs.

## What the user and the accountant provide (U1)

Ask the accountant these before R2-C goes live. The code is built and tested with fictional data first. The answers become configuration, not code, wherever possible.

| # | Question | Needed for |
|---|---|---|
| A1 | Which sales get an invoice **from the platform**? For example business clients only, while PrestaShop keeps issuing its own invoices for web orders. This sets each store's invoice authority | R2-F |
| A2 | Series and number format: one series per document type, or per brand? Prefix (for example `INV-2026-`)? Does numbering restart each year? | R2-B |
| A3 | Which VAT rates and treatments the business needs: standard 19 %, reduced rates for food, shipping, zero-rated exports outside the EU, intra-EU business sales (reverse charge), EU consumer distance sales (OSS) | R2-B |
| A4 | The exact legal note wording, in Greek and English, for exempt, zero-rated and reverse-charge lines | R2-B |
| A5 | Credit notes: partial credits allowed? Any wording required on them? | R2-D |
| A6 | Invoice language: Greek, English or both on one document? | R2-C |
| A7 | Which bank account(s) appear on invoices; default payment terms | R2-B |
| A8 | How long invoices must be kept (the regulation says 6 years), in what form, and whether the encrypted backups in a cloud folder, possibly on servers outside Cyprus, need prior notification to the Tax Department (regs. 11Γ–11Ε) | R2-A |
| A9 | Which accounting software the accountant uses, and the export format it can import | R2-G |
| A10 | Sign-off: the accountant checks the sample documents (R2-I) and the checklist in `docs/finance/invoice-requirements.md` | R2-I |

## Cross-cutting rules (apply to every step)

**Lock order.** Every transaction that takes more than one of these locks takes them in this order. Integration tests run issue, credit-note issue, allocation, refund, void, company edits and tax-code edits concurrently, and none deadlocks.
1. The `company` row: `FOR SHARE` to issue, and `FOR UPDATE` to edit company settings.
2. The switch rows, `FOR SHARE`.
3. `tax_code` rows, by id: `FOR SHARE` when a draft is saved, and `FOR UPDATE` to edit a code.
4. `payment` rows, by id.
5. `invoice` rows, invoices and credit notes alike, in **one** statement ordered by id (`WHERE id IN (…) ORDER BY id FOR UPDATE`). A credit note used as an allocation or refund source is locked in this statement, together with its targets, never before it.
6. The `invoice_series` row.

**MFA.** `invoice.issue`, `invoice.credit`, `invoice.series.manage`, `tax.manage`, `payment.record`, `invoice.export`, `client.import` and `client.export` join `PRIVILEGED_PERMISSIONS` (`apps/api/src/identity/mfa-policy.ts`) in R2-B. A test proves a session without MFA is refused each one.

**EUR only.** Cyprus reg. 12(4) needs the VAT due stated in euro, so in R2 a document is issued only in **EUR**, and only by a company whose currency is EUR (422 `currency_not_supported`). This is checked under the company row lock.
- Once any document is issued, the company currency cannot change (409 `currency_locked`).
- The "nothing issued" check runs under the company's `FOR UPDATE`, so it serialises with an issue's `FOR SHARE`.
- Reports still group by currency.

**Verified PDF reads.** One shared reader serves every stored document: downloads (including `GET /files/:id`), invoice PDFs, printing and exports.
- It reads the complete file, up to 20 MB, and checks its SHA-256 **before** sending any byte.
- On a mismatch it sends nothing and audits `file.integrity_failed`.

**Business dates** are in the company's IANA timezone. Every effective date (issue, payment, allocation, reversal, refund) is a business date stored as `date`, with the UTC timestamp stored beside it.

## R2-A. Invoice requirements and checklist (P3-01)

Research only, no code. Write `docs/finance/invoice-requirements.md` from current official sources, each fact with its source and the date checked:
- EU VAT Directive 2006/112/EC: full invoice contents (Article 226), simplified invoices (226b), credit notes as amending documents (219), issue deadlines (222), storage (233, 244–249), reverse-charge wording (226(11a)).
- The Cyprus Tax Department's VAT guidance: rates, invoice requirements, record retention.

The output is (1) a field checklist the accountant signs, and (2) the configurable rules R2-C validates at issue. The platform never claims compliance from a PDF template alone.

## R2-B. Settings: tax codes, series, bank accounts, terms (R2-01)

Every write is audited, versioned (`expectedVersion`, 409 `version_conflict`) and covered by the isolation sweep. This step also adds the MFA permissions above.

- **Tax codes** (`tax.manage`): create, edit and deactivate, with notes in English and Greek (A4). `code` is unique per company.
  - **Once any invoice line uses a code, draft or issued**, its rate, kind and notes are locked (409 `tax_code_in_use`). Create a new code instead.
  - An edit locks the code `FOR UPDATE` and checks usage under that lock.
  - Saving a draft locks its codes `FOR SHARE`, so the two serialise.
  - A line's rate therefore always equals its code's rate. Issuing still re-checks this, and refuses with 409 `tax_code_changed`.
  - Each code has a **deadline rule**, `days_30` (the default) or `next_month_15` (Cyprus reg. 11(5) and 11(6)). The accountant sets it.
- **Clients** get `accepts_e_invoices`, false by default (reg. 11A(1)(γ)). It is versioned and audited like the other client fields.
- **Series** (`invoice.series.manage`): create, edit and deactivate, one document type each.
  - Every change locks the series row `FOR UPDATE` and re-checks, under that lock, whether anything was issued from it.
  - `prefix` and `padding` are locked once a number is issued.
  - `next_number` can only be raised, and only while nothing is issued.
  - Issuing bumps the series `version`, so a settings form opened before an issue gets 409 instead of overwriting.
  - A used series is never deleted.
- **Bank accounts** (`company.bank.manage`): create, edit and deactivate `company_bank_account` rows. Add `version`. Validate the IBAN with the mod-97 check, and the BIC format if given. One account is marked "shown on invoices".
- **Terms and defaults** (`company.manage`):
  - new `company.invoice_terms_en` and `invoice_terms_el`;
  - the default series per document type;
  - document language (A6).
- **Editing guards on the existing draft routes.**
  - The generic `PATCH /invoices/:id` refuses changes to `document_type`, and refuses any change to a credit-note draft (R2-D has its own route).
  - Only drafts in the company currency can be created.

## R2-C. Issuing (P3-02)

`POST /c/:companyId/invoices/:id/issue` with `expectedVersion` (`invoice.issue`, MFA). In one transaction, with locks in the order above:

1. **Company and switches at execution time.** Lock the company row `FOR SHARE`, so its currency and settings cannot change during the issue. The global `outbound.all` and the company's `invoice.issue_real` must both be on. Otherwise 409 `issuance_disabled`, audited as a denial. Both are off by default, and a restore turns the company switch off.
2. **Lock the invoice.** Credit notes lock themselves and their original together, by id. The document must be a `draft` of type `invoice` or `credit_note`, at `expectedVersion`, in the company currency.
3. **Recalculate the totals** from the lines with `packages/domain/money`, and store them. Client-sent totals are never used. Credit notes follow R2-D's rules instead.
4. **Validate** against the R2-A rules. Failures are 422 with a list of field codes. Examples:
   - seller legal name, address and VAT number;
   - buyer name and address;
   - the buyer's VAT number when a line is reverse charge;
   - the legal note on exempt and reverse-charge lines;
   - at least one line, and an invoice total of zero or more.
5. **Number.** Lock the series `FOR UPDATE`. It must be active and match the document type. The number is `prefix` + `next_number` padded to `padding`.
   - Store `number` and `number_seq`, then increment `next_number` and `version`.
   - Unique indexes on `(company_id, series_id, number_seq)` and `(company_id, number)`.
   - The number is allocated in the same transaction, so a rollback consumes nothing and leaves no gap.
6. **Dates.**
   - `issue_date` is today's business date.
   - `due_date` is the issue date plus the client's payment terms, or the company's.
   - `supply_date`, the time of supply in Cyprus reg. 12(1)(β), is a new draft field that defaults to the issue date. It may not be after the issue date. The PDF **always** prints it.
   - The **delivery deadline** is computed from the supply date and the strictest deadline rule among the lines' tax codes. It is stored on the document: 30 days, or the 15th of the following month.

**Delivery.** The deadlines in reg. 11(5) and 11(6) are for delivering the invoice to the customer, so delivery is recorded separately from issuing.
- `POST …/invoices/:id/deliveries` (`invoice.issue`) records `delivered_on` and a method: `handed_over`, `posted`, `emailed_outside_platform` or `other`. It records it in a new `invoice_delivery` table, because issued rows are immutable. It is audited.
- If the client does not accept electronic invoices, an electronic method is refused (409 `e_invoice_not_accepted`), and the document is printed for paper delivery.
- **Paper delivery.** Printing for paper delivery prints two copies, one for the client and one for the company's file (reg. 11Γ(4)). Recording a `handed_over` or `posted` delivery needs `paper_copy_kept = true`.
- The receivables screen lists issued documents that are not yet delivered, with their deadline, and warns when it is near or past.
- Issuing a late invoice is warned about, never refused: refusing would make a late invoice impossible instead of merely late.
- See `docs/finance/invoice-requirements.md` sections 2 and 5.
7. **Snapshot everything the document shows.** Later edits never change an issued document.
   - New JSONB columns `seller_snapshot`, `buyer_snapshot` and `bank_snapshot`, plus `terms_snapshot`.
   - Per line and per tax-summary row: the tax code, its name, its kind, and the legal note in both languages.
   - `render_version`, the PDF template version.
8. **Render the PDF inside the issue.** The issued template prints:
   - every particular in `docs/finance/invoice-requirements.md` section 3, including the supply date and total VAT;
   - on tax-inclusive documents, the derived VAT-exclusive unit price: unit price × 100 / (100 + rate), half-up to 4 decimals. A unit test checks that €11.90 at 19 % prints €10.00.

   Then: Render it from the snapshot with the current template, write it through the storage adapter under a new, write-once key, and store its SHA-256 in a `stored_file` row. That file is the legal document.
   - If the transaction then rolls back, the written object is an orphan. A cleanup job deletes objects with no `stored_file` row after a day.
   - Rendering under the series lock serialises issues for about 100 ms each, which is fine at this scale.
9. Set `status = issued`, `issued_at`, `issued_by` and `pdf_file_id`. Audit `invoice.issued` with the number and total.

**Immutability, enforced by the database.** These triggers work like `owner_flag_guard`:
- **Issued documents.** `bp_app` cannot update an issued invoice or credit note, and cannot insert, update or delete its lines or tax summary. Issued documents are never deleted, and `cancelled` applies to drafts only.
- **Their PDFs.** A `stored_file` row referenced by an issued document cannot be updated or deleted. The reference is same-company: `(company_id, pdf_file_id)` points to `stored_file (company_id, id)`.
- **Serving a PDF.** `GET …/pdf` of an issued document returns the stored file through the verified reader (cross-cutting rules). It never re-renders.
- **Drafts.** Draft PDFs carry "DRAFT – not a tax document" in both languages.

**Printing.** "Print" on an issued document queues its stored PDF to the printer mapped to document type `invoice` (the HP), with the existing first-print and reprint rules.

**Tests (integration, real Postgres).**
- 20 concurrent issues in one series give numbers 1 to 20, each exactly once.
- Two concurrent issues of the same draft: exactly one succeeds.
- A failure forced after allocation leaves `next_number` unchanged.
- A switch turned off just before the call refuses it.
- A series edit racing an issue gets 409.
- `bp_app` cannot change an issued document, its lines or its `stored_file` row.
- Editing the client, company, tax code or bank account after issue changes neither the snapshot nor the PDF bytes.
- A tampered stored file is refused when served.
- A USD draft for a EUR company cannot be issued.
- A session without MFA cannot issue.

## R2-D. Credit notes and quote conversion (P3-03)

**Creating.** `POST …/invoices/:id/credit-notes` (`invoice.credit`, MFA) creates a **draft** credit note against an issued invoice:
- The body is either `{ full: true }` or lines `{ invoiceLineId, quantity }`, plus a required reason.
- Client, currency, pricing mode, prices, discounts and tax rates all come from the original and cannot be edited.
- Each line keeps `credited_line_id`.
- `PATCH …/credit-notes/:id` may change only the reason and the quantity of existing lines.

**Quantities.** For each original line, the quantities on issued credit notes, plus this one, must not exceed the line's quantity. Two lines of the same credit pointing at the same original line count together. Otherwise 409 `over_credit`.

**Amounts: cumulative differences.** VAT is rounded per tax-code group on invoices (`rounding.md`), so credits are calculated the same way. All of it uses the original's snapshotted prices, discounts and rates.
- **Line amounts.** Each credit line's rounded total is the line's own total at its cumulative credited quantity, minus its total at the quantity credited before. That is the gross with tax-inclusive pricing, and the net with tax-exclusive. A single line's rounded total only grows with quantity, so this is never negative, and it only involves lines in this credit.
- **Group tax.** For each tax-code group, the credit's tax is the group's tax at the cumulative credited quantities, minus its tax at the quantities credited before.
- **Tax-inclusive groups.** The credit's group net (gross minus tax) is split across this credit's own lines with the same largest-remainder rule invoices use. It is never spread over lines the credit does not contain, because the invoice's per-line split is not monotone.
- **The result.** The credits added up always equal what one document with the total credited quantity would show. Once everything is credited, they equal the original exactly.
- **Example:** three tax-inclusive €0.99 lines at 19 % (VAT €0.47 on the invoice) credited one at a time reverse VAT €0.16, €0.16 and €0.15.
- **Example:** four tax-exclusive €0.03 items at 19 % (VAT €0.02) credited one at a time reverse VAT €0.01, €0.00, €0.01 and €0.00 (the cumulative VAT is €0.01, €0.01, €0.02 and €0.02), so no valid return is refused.
- **Example:** tax-inclusive lines of €11.93 and €11.92 credited one at a time never put a negative amount on either credit.
- These three examples are unit tests against `packages/domain/money`.
- **Defence in depth:** the credited net, tax and gross per tax-code group must not exceed the original group's (409 `over_credit`).

**Issuing.** On issue, with the credit note and its original locked by id, R2-C applies with its own series. The issue also re-derives every credit line from its source line and refuses a mismatch. Then the credit note is applied to the original (R2-E): it is allocated against the original's open balance, and any excess remains as the credit note's unapplied amount, which is client credit.

**Storage and quotes.**
- Credit amounts are stored positive, with `document_type = credit_note`. Reports subtract them.
- Quotes are never tax documents. `POST …/quotes/:id/convert` (`invoice.draft`) creates a new draft invoice with the quote's lines and `source_quote_id`. A quote converts once (409 `already_converted`).

## R2-E. Payments, allocations, refunds and balances (P3-04)

Recording a payment never moves money, and the UI says so.

**Sources** are what can settle an invoice: a recorded **payment**, or an issued **credit note**.
- `payment`: client, `received_on` (business date), amount (`Decimal(19,2)`, greater than 0), currency, method (`bank_transfer`, `card`, `cash`, `store`, `other`), reference, notes, `status` (`recorded`, `voided`), `voided_on`, void reason, created by, version.

**Allocations** (`allocation`) are rows with these fields:
- a source, either `payment_id` or `credit_note_id`, exactly one;
- an `invoice_id` and an amount;
- `effective_on`: the earliest date, no earlier than the source's date and the invoice's issue date, from which **both** of these hold on every later date:
  - the invoice's as-of open balance stays at zero or more;
  - the source's as-of usage (allocations and refunds counted on that date) stays within the source amount.

  Both only change on allocation, reversal and refund dates, so only those dates need checking. Usually this is simply the payment date. Examples:
  - A replacement for a payment voided in March becomes effective in March, not on its original receipt date.
  - Credit moved from invoice A (reversed in March) to invoice B becomes effective on B in March, so no past date counts the same euros twice;
- `reversed_on` and a reversal reason.

They are never edited or deleted. They are only reversed, with a date.

**Refunds** (`refund`) record money paid back:
- the source (a payment or a credit note), an amount, `refunded_on`, method, reference and status;
- it is not a refund instruction to a bank.
- A refund is accepted only if the source's as-of usage stays within its amount on every date from `refunded_on` on.

**Amounts are positive everywhere.** Payment, allocation and refund amounts must be greater than 0, checked by validation and by a database `CHECK` constraint. A signed string like `"-100.00"` is refused.

**No duplicate records on retry.** Recording a payment, a refund or an allocation needs an `Idempotency-Key` header.
- A company-scoped `idempotency_record` keeps the operation, the key, a hash of the request and the result.
- The same key with the same request returns the original result and creates nothing.
- The same key with a different request is 409 `idempotency_key_reused`.
- **Test:** a refund whose response is lost and is then retried exists once.

**Rules.** Each runs under the shared lock order. A payment source is locked at step 4. A credit-note source is locked at step 5, in the same sorted statement as its target invoices.
- An allocation needs:
  - an amount greater than 0;
  - a source and target belonging to the **same client**, in the **same currency**;
  - a target that is an **issued** document of type `invoice`;
  - a source that is a recorded payment or an issued credit note.
- **Per source:** active allocations plus active refunds must not exceed the source amount. Otherwise 409 `over_allocation`.
- **Per invoice:** active allocations must not exceed the total. Otherwise 409 `over_allocation`.
- **Voiding a payment** reverses its allocations with `reversed_on` as the void date. It is refused while the payment has an active refund (409 `payment_refunded`).
- **The order of events is enforced.** Refunding a payment's unallocated €100 leaves nothing to allocate. Two concurrent €80 refunds from one €100 source: exactly one succeeds.

**Balances**, derived, not stored:
- **Invoice open balance** = total minus active allocations.
- **Client credit** = the unallocated, unrefunded remainder of the client's payments and credit notes.
- **Payment status** (`unpaid`, `partially_paid`, `paid`) comes from the open balance.

**As of a date.** The open balance on date D counts only allocations with `effective_on ≤ D` that were not reversed by D (`reversed_on` empty or after D). So a payment received in February and voided in March still counts in February's ageing.

**Tests:**
- Concurrent allocations that together over-allocate: exactly one succeeds.
- A €40 credit after a €100 invoice was fully paid leaves €40 of client credit that can settle another invoice or be refunded.
- Allocating client A's payment to client B's invoice, or to a draft, is refused.
- A void restores the balance today but not in earlier as-of reports.

## R2-F. Store invoice authority (P3-06)

Order-to-invoice conversion is deferred (R2-02), so in R2 this step is a guard only:
- **No order links.** The API refuses to set `source_order_id` on any invoice.
- **One invoice per sale.** A partial unique index allows one non-cancelled invoice per `(company_id, source_order_id)`, ready for R2-02.
- **Authority is stable.** A store's authority cannot change from `platform` once an invoice was issued for one of its orders. The store screen explains the choice (A1).

## R2-G. Reports and accountant export (P3-07)

`report.finance.view`, business dates, grouped by currency, and every figure labelled with its basis:
- **Invoiced (by issue date):** invoices minus credit notes, net, tax and gross per tax code, for a period.
- **Collected (by payment date):** payments minus refunds, by method, for a period.
- **Unpaid and ageing (by due date, as of a date):** per client, using the as-of balance from R2-E, in buckets current, 1–30, 31–60, 61–90 and over 90 days. Client credit is shown separately.

**Accountant export** (`invoice.export`, MFA, audited): a ZIP of CSV files for a period:
- invoices and credit notes, lines, tax summary, payments, allocations and refunds;
- optionally, the stored PDFs.
- The column layout follows A9. Until A9 is answered, use a documented generic layout.

**CSV safety.** Text cells starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'`. Numbers are written as plain decimal strings. The output is UTF-8 with a BOM, so Excel shows the Greek correctly. R2-H shares this writer.

**Test:** the worked examples agree across invoiced, collected, open balances and ageing.

## R2-H. Client CSV import and export (P3-12)

- **Export:** `client.export` (MFA), audited.
- **Import:** `client.import` (MFA).
  - An upload gives a dry-run preview: per row, new, duplicate (the existing normalised name, email or VAT match) or error.
  - Confirm applies only that preview, by its id, once.
  - The maximum is 5,000 rows, and every confirmed import is audited.
- **Tests:** a role with `client.manage` but not `client.import` cannot import, and a role with `client.view` and `invoice.export` but not `client.export` cannot export.

## R2-I. Live checks

On the laptop after R1 is live. Sample documents never enter the real company's books.

1. **A fictional sample company.** Create "Sample Company (fictional)" with fictional details, and turn `invoice.issue_real` on for it only. There, issue an invoice, a partial credit note and a partial payment, and run the reports and the export.
2. **The real company's layout, without issuing.** Prepare a draft in the real company with its real settings (A2–A7). Its draft PDF, marked "DRAFT – not a tax document", shows the real seller details and layout.
3. **Accountant sign-off.** The accountant reviews both sets and signs the checklist (A10).
4. **Go live.** Set the real series' starting numbers, switch on `invoice.issue_real` for the real company, and issue the first real invoice.
5. **Report.** Record everything in `docs/releases/r2-report.md`, with document numbers only and no client data.

## Build order and estimate

One step at a time (implement, verify, review at `xhigh`, fix):

| Step | Days |
|---|---|
| R2-A | 0.5 |
| R2-B | 1 |
| R2-C | 1.5 |
| R2-D | 1 |
| R2-E | 1.5 |
| R2-F | 0.25 |
| R2-G | 1 |
| R2-H | 0.5 |
| **Total** | **about 7–8 days** |

Screens for each step land with that step.

## R2 acceptance

1. Concurrent issues never duplicate or skip a number, and a failed issue consumes none.
2. An issued document, its lines and its stored PDF never change, enforced by the database and checked when the PDF is served. Corrections are credit notes only.
3. Credits never exceed the original's line quantities or tax-code groups. Credit amounts are cumulative differences, so their sum always matches one document with the total credited quantity.
4. No over-allocation, double refund or cross-client allocation under concurrency or on retry, no negative amounts, and no deadlock between issue, credit, allocation, refund and void. No past date counts the same source or invoice amount twice.
5. Balances, as-of ageing, and the invoiced and collected reports agree with the rounding rules and with each other on the worked examples.
6. Issuance is refused while `outbound.all` or `invoice.issue_real` is off, checked at execution time, and without MFA.
7. No document is issued in a currency other than the company's, and the company currency is locked once one is issued.
8. A store with authority `store` can never get a platform invoice for its orders.
9. CSV exports neutralise formulas and keep Greek text intact. Client import and export need their own permissions.
10. Every new route passes the isolation sweep. Unit, integration and e2e tests pass, and the Codex review has no open finding.
