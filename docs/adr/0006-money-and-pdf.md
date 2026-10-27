# ADR-0006: Decimal money arithmetic and server-side PDF rendering

- Status: accepted
- Date: 2026-10-19

## Money

- All money and quantity arithmetic uses `decimal.js` through `packages/domain/money`. Postgres stores money as `numeric(19,2)` and unit prices and quantities as `numeric(19,4)`. Amounts travel through the API as strings matching `^-?\d+(\.\d+)?$`.
- The rounding rules and tax-inclusive and tax-exclusive algorithms are in `docs/finance/rounding.md`, and the domain tests encode them. Phase 1 supports currencies with at most 2 minor digits (EUR by default).
- The backend computes totals. Client-provided totals are ignored, and LLMs never compute or alter totals.

## PDF

- `pdfmake` (0.3.x, on top of PDFKit) renders server-side in the worker or API. It needs no headless browser, which keeps memory low on a small VPS.
- Fonts are Noto Sans Regular, Bold and Italic as TTF, licensed SIL OFL 1.1, committed under `packages/documents/assets/fonts` with the licence file. They cover Latin and Greek.
- Gift messages render from the stored text exactly, with line breaks kept. Page size is the template's physical size in millimetres. If the text overflows, the font shrinks down to a minimum size; past that, the document is flagged `review_required` instead of being cut off.
- Draft invoices carry a visible watermark that says it isn't a tax invoice, in English and Greek.

## Consequences

- Layout is less flexible than HTML-to-PDF, which is acceptable for invoices, slips and cards. If complex layouts are needed later, a bounded HTML renderer can be added behind the same interface.
