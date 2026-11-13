/** Self-contained UTF-8 guide shipped with every export, including empty periods. */
export function exportReadme(from: string, to: string, pdfs: boolean): Buffer {
  return Buffer.from(
    `Accountant export - generic layout (pending accountant software/import format)
Period: ${from} to ${to}, inclusive company business dates.
PDFs included: ${pdfs ? 'yes' : 'no'}.

Files: README.txt (this guide), invoices.csv, invoice_lines.csv, tax_summary.csv,
payments.csv, allocations.csv, refunds.csv${pdfs ? ', and pdfs/<number>.pdf' : ''}.
All six CSVs exist even when they contain only column headers.
Drafts, quotes and cancelled documents are excluded.
Related documents outside the period are referenced without exporting their rows.

CSV conventions
UTF-8 with a BOM, comma-separated, CRLF records, RFC 4180 quoting.
Text starting with =, +, -, @, tab or carriage return gets a leading apostrophe
for spreadsheet safety. Remove it only when followed by one of these characters
if original text is needed. Otherwise customer text and whitespace are preserved.
Decimals use a dot without grouping: money 2 digits; quantity, unit price and tax
rate 4 digits; discount percent 2 digits. Missing values are empty cells.
Dates are YYYY-MM-DD company business dates; issued_at is a UTC ISO timestamp.
Unit prices include VAT only when invoices.csv prices_include_tax is true.
VAT is calculated and rounded per tax-code group, reported in tax_summary.csv.
Use its net, tax and gross columns for VAT reconciliation, not per-line VAT.
Credit notes are positive amounts to subtract from invoices, identified by
document_type=credit_note. Allocation and refund amounts are also positive.
Voided payments/refunds and reversed allocations are included for reconciliation;
use their current status and reversal/void dates, rather than summing all rows.
Buyer and tax labels are frozen issued snapshots. Client names on payments and
series codes are current values. Currency for lines/tax groups comes from their
parent document; allocations/refunds inherit the source currency.

invoices.csv - issued invoices and credit notes selected by issue_date
id: Document UUID.
document_type: invoice or credit_note.
number: Issued document number.
series_code: Current code of the series used for issuance.
issue_date: Issue business date; selection basis.
supply_date: Supply business date.
due_date: Stored due business date; credit notes store their issue date here.
client_id: Client UUID.
buyer_name: Snapshotted legal name, falling back to display name.
buyer_vat_number: Snapshotted VAT number, empty if absent.
currency: Document currency code.
prices_include_tax: true or false; whether unit prices include VAT.
net: Document total excluding VAT.
tax: Document VAT total.
total: Document total including VAT.
credited_invoice_number: Original invoice number for credit notes; empty otherwise.
credit_reason: Original credit reason with CSV text safety; empty otherwise.
issued_at: Exact issuance timestamp in UTC ISO format.

invoice_lines.csv - lines of the exported documents, ordered by position then UUID
document_number: Parent document number.
position: Stored line position, an integer represented as text.
description: Original line description with CSV text safety.
quantity: Quantity, 4 decimals.
unit: Stored unit text.
unit_price: Stored unit price, 4 decimals; follows prices_include_tax.
discount_percent: Percentage discount, 2 decimals.
tax_code: Code from the line's frozen tax snapshot.
tax_rate: Stored VAT percentage, 4 decimals.
line_net: Stored line amount excluding VAT after discount, 2 decimals.
line_amount_incl_vat: Line amount including VAT after discount, 2 decimals, ONLY
  for documents with prices_include_tax=true; empty on tax-exclusive documents.
  VAT on tax-exclusive documents is available per group in tax_summary.csv.

tax_summary.csv - one stored tax-code group per exported document
document_number: Parent document number.
tax_code: Code from the group's frozen tax snapshot.
tax_name: Name from the group's frozen tax snapshot.
tax_rate: Stored VAT percentage, 4 decimals.
net: Group total excluding VAT, 2 decimals.
tax: Group VAT total, calculated/rounded at tax-code-group level, 2 decimals.
gross: Group total including VAT, 2 decimals.

payments.csv - payments selected by received_on, including voided payments
id: Payment UUID.
client_id: Client UUID.
client_name: Client's current display name.
received_on: Receipt business date; selection basis (not voided_on).
amount: Recorded payment amount, 2 decimals.
currency: Payment currency code.
method: bank_transfer, cash, card, store or other.
reference: Original reference with CSV text safety.
status: Current recorded or voided status.
voided_on: Void business date, empty while recorded.
void_reason: Original void reason with CSV text safety, empty while recorded.

allocations.csv - selected once by effective_on OR reversed_on in the period
id: Allocation UUID.
source_type: payment or credit_note; exactly one source reference is populated.
payment_id: Source payment UUID, empty for credit-note sources.
credit_note_number: Source credit-note number, empty for payment sources.
invoice_number: Target invoice number.
amount: Allocated amount, 2 decimals.
effective_on: Allocation effective business date; first selection basis.
reversed_on: Reversal business date; second selection basis, empty while active.
reversal_reason: Original reversal reason with CSV text safety, empty while active.

refunds.csv - selected once by refunded_on OR voided_on in the period
id: Refund UUID.
source_type: payment or credit_note; exactly one source reference is populated.
payment_id: Source payment UUID, empty for credit-note sources.
credit_note_number: Source credit-note number, empty for payment sources.
amount: Refund amount, 2 decimals.
refunded_on: Refund business date; first selection basis.
method: bank_transfer, cash, card, store or other.
reference: Original reference with CSV text safety.
status: Current recorded or voided status.
voided_on: Void business date; second selection basis, empty while recorded.

pdfs/<number>.pdf - optional original stored PDF for each exported document
The document number is percent-encoded as one filename component (for example,
INV/00001 becomes pdfs/INV%2F00001.pdf); decode it to recover the number.
Every PDF is size/SHA-256 verified before any archive bytes are sent.
`,
    'utf8',
  );
}
