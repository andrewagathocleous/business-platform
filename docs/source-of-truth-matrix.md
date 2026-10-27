# Source-of-truth matrix

Status: initial defaults, 2026-10-19. Changing any row needs a decision recorded here and, for write-back, acceptance tests. **All write-back is off initially.**

| Data | Authoritative system (initial) | Platform behaviour | Write-back | Conflict rule |
|---|---|---|---|---|
| Product titles and descriptions | Each store | Read-only import, linked by `(connection, external id)` and SKU | Off | Store wins; the platform never overwrites |
| Product prices (store) | Each store | Read-only | Off | Store wins |
| Invoice catalogue prices | Platform catalogue | Owned by the platform; may be seeded from the store once, with a copy marker | n/a | Platform wins for invoices |
| Inventory and stock | Each store, independently | Not synchronised. Bidirectional sync stays **off** until ownership, SKU/location mapping, reservations and conflict handling are designed | Off | n/a |
| Store customer details | Each store | Imported as order customer and recipient snapshots on the order | Off | A newer source `updated_at` wins for source fields |
| Business clients (invoicing) | Platform | Created and edited in the platform; optionally linked to store customers | n/a | Platform wins |
| Order existence, items, payment status | Store | Imported; source status kept in raw form alongside the normalised payment status | Off | Newer source `updated_at` wins; older events are recorded as stale and ignored |
| Operational fulfilment status | Platform | Platform state machine: new → … → completed | Off (Phase 2+: optional "fulfilled" write-back per store after acceptance) | The platform never takes operational status from the source. A source cancellation moves the order to `review_required` |
| Gift message text | Store (customer input) | Stored byte-for-byte; never rewritten | Off | A later source change shows as a changed field for review, not a silent overwrite of an already printed message |
| Staff notes and assignment | Platform | Platform only | n/a | Optimistic concurrency (`version`) |
| Tax invoice for a store sale | **Undecided per store** (`invoice_authority`) | `undecided` blocks platform issuance for that store's orders; `store` means link the store invoice; `platform` means the platform issues | n/a | Exactly one authoritative tax invoice per sale (unique constraint per order) |
| Platform invoices, credit notes, payments | Platform | Owned and numbered by the platform | n/a | Immutable once issued |
| Tracking numbers | Platform (manual entry or export result) | Recorded without claiming a shipment was booked unless a provider confirmed it | Off | Platform wins |
| Marketing consent and suppression | Brevo plus the platform's consent provenance | Suppression always wins; sync never resubscribes | Phase 4 | Unsubscribe, bounce or complaint anywhere means suppressed everywhere |
| Mailbox contents | Microsoft 365 | Synced metadata and bodies for authorised mailboxes only | Sends only, per permission and approval | M365 wins |
