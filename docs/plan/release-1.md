# Release 1 plan: PrestaShop orders and printing

Owner: planner (Claude Code). Implementer: Cursor CLI. Reviewer: Codex CLI.
Written 2026-10-23. The code can be built before R0 is live; it goes live on the R0 base, which is a dedicated laptop for now. Every call in R1 is outbound, so the laptop works as the host.

**Goal.** New orders from the PrestaShop shop appear in the platform within a few minutes, with the gift message exactly as the customer typed it. Staff print the gift card on the shop's Zebra label printer and the packing slip on its HP LaserJet, both through PrintNode. Shopify orders join the same flow in R3.

**Known about the shop (user, 2026-10-23).**
- One Windows 10 Enterprise desktop PC drives two printers:
  - **HP LaserJet M209dw** (A4 laser): packing slips and orders, and invoices from R2.
  - **Zebra ZD230 thermal-transfer label printer**, `ZD23042-30EC00EZ` (203 dpi, 104 mm print width, USB and Ethernet): gift cards and, from R4, courier labels, both **100 × 150 mm**.
- **Routing by document type is the platform's job, not PrintNode's.** One PrintNode account and one PrintNode client on the PC expose both printers. Discovery brings both into the platform, and the existing printer mappings (per location and document type: `gift_message`, `packing_slip`, `shipping_label`, `invoice`) choose the printer, paper size and copies. PrintNode prints wherever the platform tells it.
- PrestaShop 1.7.7.2, PHP 7.3.33, MariaDB 10.6.19, LiteSpeed, shared hosting (CloudLinux).
- The Webservice is already enabled.
- The gift message is PrestaShop's built-in one: it shows under the order's Carriers tab as "Gift message", not from a module.

**Not in R1.** No writes to PrestaShop (no status changes, no tracking numbers), no Shopify, no couriers, no invoices.

## Verified provider facts (sources checked 2026-10-23)

**PrestaShop 1.7.7.2 Webservice** (`classes/webservice/WebserviceRequest.php`, `classes/order/Order.php`, `classes/ObjectModel.php` at tag `1.7.7.2`):
- `Order` defines `gift` (bool) and `gift_message` (string, validator `isMessage`, which rejects `<`, `>`, `{` and `}`). `ObjectModel::getWebserviceParameters()` exposes every defined field, so both are in `GET /api/orders`. The PrestaShop 8 orders schema lists `gift_message` too.
- `associations.order_rows` exposes `product_id`, `product_attribute_id`, `product_quantity`, `product_name`, `product_reference`, `product_price`, `unit_price_tax_incl` and `unit_price_tax_excl`.
- Filtering on `date_add` or `date_upd` needs `date=1`; without it the API returns error 32. `filter[date_upd]=[a,b]` becomes `BETWEEN` (inclusive).
- Sort is `sort=[date_upd_ASC,id_ASC]`. Limit is `limit=<offset>,<count>`.
- JSON needs the header `Output-Format: JSON`, in capitals. Lowercase `json` silently returns XML.
- `display=full`, or `display=[field,…]` to fetch only the named fields.
- The key is 32 characters, sent as the HTTP Basic user with an empty password. PrestaShop also accepts `?ws_key=`; **we never use it, because the key would land in URLs and logs.**

**PrintNode** (`https://www.printnode.com/en/docs/api/curl`):
- Base `https://api.printnode.com`, HTTP Basic with the API key as the user.
- `POST /printjobs` with `printerId`, `contentType: "pdf_base64"`, `content`, `title`, `source`, `options` (`copies`, `paper`, `bin`, `rotate`, `fit_to_page` on Windows only), `expireAfter` (seconds, default 14 days) and `qty`. It returns `201` with the job id.
- `X-Idempotency-Key`: a duplicate key returns `409 Conflict`; keys can be reused after 24 hours.
- Body limit 50 MB. Rate limit 10 requests per second per account; above that, `429`.
- `GET /printjobs/<id>/states` returns `new`, `sent_to_client`, `done`, `error` and `expired`, and possibly other values. **`done` means delivered to the OS print queue, not printed on paper.**
- `GET /printers` lists `id`, `name`, `state`, `computer` and `capabilities.papers`; the `options.paper` value must be one of those keys. `GET /computers` gives each computer's `state`.

## What the user provides

| # | Item | When |
|---|---|---|
| U6 | A PrintNode account. The PrintNode client installed on the shop's Windows 10 Enterprise desktop PC, which drives both printers, and the hours that PC is on | before R1-D live checks |
| U7 | Gift cards print on the Zebra ZD230 at **100 × 150 mm** (2026-10-23). Still needed: the media (labels or tags, 0.08–0.19 mm thick), the ribbon, whether courier labels share the roll, and a few blanks for tests. See R1-F | before R1-F |
| U4 | A new Webservice key, **GET only**, on `orders`, `customers`, `addresses`, `countries`, `carriers`, `order_states` and `currencies`. Nothing else, and never `configurations`. The user types it into the platform's settings screen, never into chat | at R1-H |
| — | The shop's timezone (Localization → Configuration) | at R1-H |
| — | Which order states mean "paid" and which mean "cancelled". The settings screen lists the shop's states once the key works | at R1-H |

The `customers` resource also carries the password hash and secure key. The client asks for `display=[id,firstname,lastname,email]` only, so those fields are never transferred.

## R1-A. Outbound HTTP client (P2-05)

`packages/integrations/src/http/` (`createSafeFetch`, `isBlockedAddress`, typed errors). Every connector uses it. ESLint bans the global `fetch` and `http`/`https` imports elsewhere in `packages/integrations/src`.

- HTTPS only, on allowed ports (default 443), with no userinfo in the URL.
- **Address check.** The host is resolved once per hop. If any answer is in a blocked range, the request is refused. Blocked ranges:
  - IPv4: loopback, private, link-local, CGNAT, documentation, benchmarking, multicast and reserved;
  - IPv6: unspecified, loopback, discard, Teredo, documentation, unique-local, link-local and multicast;
  - IPv4 embedded in mapped, NAT64 or 6to4 addresses, judged as that IPv4.
- **No re-resolving.** The connection uses a per-hop undici `Agent` whose `lookup` returns only the checked addresses. TLS still verifies the hostname.
- **Redirects:** at most 3, for GET and HEAD only, each re-checked. Never from HTTPS to HTTP. `authorization`, `cookie` and `proxy-authorization` are dropped on a cross-origin hop. A redirect answering any other method is an error, and the body is never re-sent.
- **Timeouts and size:** a connect timeout, a total timeout, and a response size cap (default 10 MB).
- **Every HTTP status is returned, not thrown.** The call uses undici `request` with the per-hop agent, not `fetch`, so 407 and 421 come back as responses and a 421 is not sent again. Callers decide what 401, 409 or 429 mean.
- **Typed errors carry `sent`.** `sent` follows the connection stage only, never an error code or an abort reason. Before undici's connector returns a socket (after the TLS handshake, or the TCP connect for loopback HTTP in tests), nothing has been written. After it, anything may have been.
  - `sent: false` (safe to retry): `BlockedDestination`, `DnsFailure` (including a timeout or abort during resolution), and `ConnectFailure` (anything before the connection: refused, connect timeout, TLS handshake failure, or an abort).
  - `sent: true` (may have taken effect, so a side effect becomes `uncertain`): `RequestUncertain` (anything after the connection, including a TLS alert or an abort), `ResponseTooLarge`, `TooManyRedirects` and `UnexpectedRedirect`.
  - Only errors created for the current call are passed through unchanged. A `SafeFetchError` from an earlier call is classified by this call's connection stage, so it cannot make a sent request look retryable.
- Cleanup destroys the per-hop agent, so nothing outlives the total timeout. Response headers are a null-prototype record.
- Error messages contain only the code, method, origin and path: no headers, bodies, query values or userinfo. The module never logs.
- **Test mode:** `allowLoopbackForTests` allows loopback addresses and `http:` to loopback hosts. It is accepted only with `appEnv: 'test'`.
- Tested (unit): every range, embedded forms, pinning, blocked DNS answers, redirects, the POST redirect, timeout classification, the size cap, a reused error, HTTP 421 (POST, PUT, PATCH and DELETE) and HTTP 407, and that no secret appears in any error.

## R1-B. Integration settings (R1-01)

Uses the existing `CredentialVault`.

- PrestaShop connection, on a store whose platform is `prestashop` (`integration.manage` to write, `integration.view` to read):
  - `PUT /c/:companyId/stores/:storeId/prestashop-connection`: base URL (HTTPS), key, shop timezone (IANA), first-import date, poll interval (default 3 minutes, minimum 2). It creates or updates the `store_connection` with `mode = live`, `read_only = true` and `write_back_enabled = false`, and stores the key through the vault. A key change re-encrypts and audits `integration.credential_replaced`.
  - `POST …/prestashop-connection/test`: `GET /api/orders?display=[id]&limit=1`. It returns ok, or the error class (`auth_failed`, `not_found`, `blocked_destination`, `timeout`, `bad_response`), never the response body.
  - `GET …/prestashop-connection`: settings, `keySet: true|false`, the time the key was set, and the last test result. **Never the key.**
  - `GET …/prestashop-connection/order-states` and `…/carriers`: read live from the shop so the owner can fill two maps:
    - state id to `payment_status` (`paid`, `pending`, `refunded`, `cancelled`, `unknown`) and to a source status;
    - carrier **`id_reference`** to `delivery_method`. PrestaShop gives a carrier a new `id` each time it is edited; `id_reference` stays the same.

    The maps are stored on the connection (`sync_checkpoint` stays separate) and on `store.delivery_method_map`.
- PrintNode account (`printer.manage`):
  - `PUT /c/:companyId/print-accounts/printnode` stores the key in the vault.
  - `POST …/test` calls `GET /whoami` and returns ok or the error class.
  - `GET` returns `keySet` and the account email from `whoami`.
- Every write is audited without the secret. The isolation sweep covers every new route. Key values must never appear in logs: a logger spy test, as in the vault tests.
- Web: an "Integrations" admin screen with the PrestaShop connection form, the two maps, the PrintNode key form, and the test buttons.

Recorded when R1-B was implemented. The handoff is the contract where it differs from the bullets above:

1. The connection test probes `orders`, `customers`, `addresses`, `countries`, `carriers`, `order_states` and `currencies`, in that order, each with `GET <resource>?display=[id]&limit=1`. It stops at the first failure. The outline named only `GET /api/orders?display=[id]&limit=1`.
2. `GET /print-accounts/printnode` returns `{ keySet, keySetAt }`. It does not call `whoami`. `POST …/test` returns the account email.
3. The state map is `{ payment, cancelled }`, the R1-C settings schema. There is no separate source status. The displayed fulfilment status still comes from the state name in the mapper.
4. The outline did not specify `last_test_at` and `last_test_result`, activate and pause, the maps write, skipping an archived store, recording a test only when the credential and shop URL are unchanged, revoking a key whose connection write failed, or re-enqueuing `received` inbox rows on activation.
5. The poll interval stays a minimum of 120 seconds. The screen shows minutes, minimum 2, default 3.
6. `GET` returns `{ connection: null }` or `{ connection: { … } }`. The writes return `{ connection }` as well.
7. The PrintNode test uses a 15 second timeout, the same bound as the PrestaShop probe. `printNodeWhoami` still defaults to 20 seconds, as `listPrinters` does.
8. A failed order-state or carrier lookup is HTTP 502 with `{ errorClass }` only, not the standard error envelope.
9. Request bodies are not logged, so `key` was not added to `apps/api/src/logging/redact.ts`.
10. A `GET` that fails as `wrong_platform` is audited as `integration.connection_read`. That action name is not in the handoff.

Fix round 1 (review of R1-B):

11. A poll checks before every write that the connection is still `active` with the credential and settings it read before opening, under a row lock. That covers failures while opening too. If not, it stops as superseded and writes nothing. Settings saves, maps saves, activate and pause lock the connection row `FOR UPDATE`.
12. The clean-up handle for a new PrestaShop key is cleared only after the commit, so a failed commit revokes the new key.
13. `printNodeWhoami` no longer wraps errors. The PrintNode test returns the same classes as the PrestaShop test (`auth_failed`, `not_found`, `bad_response`, `blocked_destination`, `unreachable`, `timeout`).
14. The Integrations screen guards the PrintNode section with a company generation and the PrestaShop section with a store generation.
15. Decision: credential ids are opaque UUIDs, not secrets. The vault logs them by design. The secrets rule covers key values, hints and lengths.

## R1-C. PrestaShop reader (P2-04)

The implemented reader is [docs/integrations/prestashop.md](../integrations/prestashop.md). Where this outline differs, that document is the contract: the trigger is `POST /api/automation/v1/c/:companyId/store-sync` for every due connection in the company, one poll at a time uses the `sync_locked_until` lease, pages are 100 rows with no offsets, a run stops after 20 pages that move past the checkpoint it started with, pages at or before that checkpoint do not count and 50 of them stop with `overlap_too_large`, and a full page that does not move `date_upd` stops with `too_many_in_one_second`.

`packages/integrations/src/prestashop/`: client, mapper and fictional fixtures. Mark the fixtures "modelled on PrestaShop 1.7.7 JSON output; checked against the live shop at R1-H".

**Trigger.** Following ADR-0002, n8n owns schedules:

- A new n8n workflow, `W0 PrestaShop poll`, calls `POST /api/automation/v1/c/:companyId/store-connections/:connectionId/sync` on the connection's interval, with a service identity holding `store.sync.trigger`. That permission is already in the catalogue and unused.
- The endpoint enqueues one `prestashop.poll` job with idempotency key `prestashop.poll:<connectionId>:<interval bucket>`, so duplicate triggers do nothing.
- Export the workflow sanitised into `workflows/n8n/exports`, and add its import to the runbook.

**Worker `prestashop.poll`** (one at a time per connection: advisory lock on the connection id):

1. Read the checkpoint `{ dateUpd, lastId }`. Both are in the **shop's local time**, because PrestaShop stores dates without a zone. The first run starts from the first-import date.
2. Request the page:

   ```
   GET /api/orders?display=full&date=1
     &filter[date_upd]=[<checkpoint − 10 minutes>,<now in shop time + 1 day>]
     &sort=[date_upd_ASC,id_ASC]&limit=<offset>,50
   ```

   with `Output-Format: JSON`. The 10-minute overlap catches rows committed late. The upper bound is a day ahead because the shop clock can be ahead of ours.
3. For each order, fetch what it references, each at most once per run (cache by id):
   - `customers` with `display=[id,firstname,lastname,email]`;
   - the delivery and invoice `addresses`;
   - `countries` (ISO code);
   - `carriers` (`id_reference`, name);
   - `currencies` (ISO code).

   Build one normalised payload that contains only the fields the mapper uses.
4. In one transaction per order, insert `integration_inbox` with `external_event_id = order:<id>:<date_upd>` and `ON CONFLICT … DO UPDATE duplicate_count`, as the Shopify path does, plus its `inbox.process` job. An unchanged order seen again in the overlap is a duplicate and does nothing.
5. After a page commits, advance the checkpoint to the last `(date_upd, id)` of that page. Stop when a page has fewer than 50 rows. Update `last_sync_at`, and on failure `last_error_class` and `last_error_at` (add the columns).
6. Errors:
   - `auth_failed` stops the connection until the key is replaced, and shows on the health screen.
   - Timeouts and 5xx end the run. The next trigger tries again; reads are safe to repeat.
   - Nothing is ever written to PrestaShop.

**Mapper** `mapPrestashopOrder(payload, connectionConfig)`, called by `inbox.process` when the connection's store platform is `prestashop`. `inbox.process` today accepts only `mode = mock` and only the Shopify mapper; dispatch by platform and accept `live` for PrestaShop.

| Internal field | Source |
|---|---|
| `external_id` | `id` |
| `external_number` | `reference`, with `#<id>` searchable |
| source created / updated | `date_add` / `date_upd`, converted from the shop timezone to UTC with the IANA zone. Test a DST change |
| `payment_status`, `source_status` | `current_state` through the state map. An unmapped state gives `unknown`, so the order goes to `review_required` |
| `customer` | the customer's name and email |
| `recipient` | delivery address: names, company, `address1`, `address2`, postcode, city, country ISO, `phone`, `phone_mobile` |
| `billing_address` | invoice address |
| `gift_message` | `gift_message`, **byte-for-byte**, when non-empty. `gift` is kept as a flag |
| `delivery_method` | carrier `id_reference` through the map, else `unknown` (`review_required`) |
| lines | `order_rows`: name, reference, quantity, `unit_price_tax_incl` as decimal strings |
| total | `total_paid_tax_incl` as a decimal string |
| currency | currency ISO code |

The existing import rules apply unchanged: per-object advisory lock, `stale` for an older `date_upd`, source fields only on update, `gift_message_changed_after_print` and `cancelled_at_source` to review.

**Tests:**
- Mapper (unit):
  - a Greek gift message with line breaks, a trailing space and `«»`;
  - an emoji the font cannot draw, flagged;
  - an unmapped state;
  - an unknown carrier;
  - DST.
- Poller (integration, with a fake PrestaShop server on loopback):
  - pagination across 120 orders;
  - an order updated during the overlap, imported once;
  - an older update marked `stale`;
  - a crash after the inbox insert and before the checkpoint, with no loss and no double import;
  - two triggers at once, giving one run;
  - `auth_failed` stopping the connection;
  - the request never containing `ws_key`;
  - `customers` requested with `display=[id,firstname,lastname,email]` only.

## R1-D. PrintNode provider (P2-06)

`packages/integrations/src/printing/printnode.ts` implements the existing `PrintProvider` contract through `safeFetch`.

- `listPrinters`: `GET /printers`. Each printer is upserted with `provider = printnode`, external id, name, computer name, state and its `capabilities.papers` names.
- `submit`: `POST /printjobs` with:
  - `contentType: "pdf_base64"`;
  - `title` set to the print-job's neutral label (no customer name);
  - `source: "business-platform"`;
  - `options { copies, paper }`;
  - `expireAfter: 86400`, so a PC that is off for a day does not print a stale job later;
  - header `X-Idempotency-Key: pj_<printJobId>`.

  Responses:

  | Response | Meaning |
  |---|---|
  | `201` | `{ providerJobId }` |
  | `401`, `403`, `404` | `ProviderRejected` |
  | `429` | `ProviderRejected` (`rate_limited`); it was not accepted, so a person may retry |
  | `409` (idempotency collision) | `ProviderUncertain` (`idempotency_collision`): an earlier send probably succeeded, but we have no job id. The job goes to `uncertain`, and a person confirms |
  | timeout after send, 5xx, network error after send | `uncertain`, no retry, as today |
- `getJobState`: `GET /printjobs/<id>/states`, then the latest stable state:

  | PrintNode state | Platform status |
  |---|---|
  | `new` | stays `submitted` |
  | `sent_to_client` | `delivered_to_printer` |
  | `done` | `done_reported`, still labelled "not confirmed" |
  | `error` | `failed`, with PrintNode's message trimmed to 200 characters |
  | `expired` | `failed` (`expired`) |

  `print.refresh_status` handles only `submitted` and `done` today: add `failed` from refresh, and keep polling while the state is `new` or `sent_to_client` (back off to 5 minutes, stop after `expireAfter`).
- The processor chooses the provider from `printer.provider`. The mock stays, labelled, for tests and demos.
- `PUT /printer-mappings` validates `paperSize` against the discovered paper names for PrintNode printers.
- The UI shows the PrintNode computer state on the printers screen and on a print job. An offline computer still accepts the job, and it prints when the PC comes back within a day.
- **Tests:** a fake PrintNode server on loopback covers 201, 401, 404, 409, 429, a timeout after send, each state mapping, and `expired`. The API key never appears in logs or audit.

## R1-E. Integration health (P2-09, R1 part)

On the Integrations screen, for each connection:

- last successful sync, with a warning after 3 intervals and an error after 15 minutes;
- last error class and time;
- failed and review-required imports, with links;
- whether the key is set.

For PrintNode: account ok, computers online or offline, last refresh. Read-only, `integration.view`.

Implemented 2026-10-24 (planner-implemented while Cursor was at its weekly limit). The contract is `GET /c/:companyId/integrations/health` in [docs/integrations/prestashop.md](../integrations/prestashop.md). Differences from the bullets above:

1. Error after max(15 minutes, 5 intervals), not a flat 15 minutes, so a long poll interval does not show an error between two normal polls. Warning after 3 intervals, as planned.
2. PrintNode "account ok" and "computers online" are not a live call. Viewing the screen makes no provider call. It shows whether a key is set, each printer's state and when discovery last saw it, and the gift-card and packing-slip mappings. The PrintNode Test button (R1-B) checks the account itself.
3. Added: orders needing review per store, imports still waiting after 15 minutes, and print jobs that failed or became uncertain in the last 24 hours.

## R1-F. Printer set-up and gift-card template (P2-11)

**Mappings for the shop location:**

| Document type | Printer | Paper | From |
|---|---|---|---|
| `gift_message` | Zebra ZD230 | 100 × 150 mm label size | R1 |
| `packing_slip` | HP LaserJet M209dw | A4 | R1 |
| `shipping_label` | Zebra ZD230 | 100 × 150 mm | R4 |
| `invoice` | HP LaserJet M209dw | A4 | R2 |

**Zebra ZD230 limits** (Zebra's spec sheet, and a reseller listing for this part number):
- Thermal transfer with a ribbon, 203 dpi, black only.
- Maximum print width 104 mm; media up to about 112 mm wide.
- Media thickness **0.08–0.19 mm**. Thin tags and labels work; thick greeting-card stock does not.
- Media can be die-cut or continuous, labels or tag stock.

**Windows set-up:** in the ZDesigner driver, define a 100 × 150 mm label stock and the matching media type (thermal transfer, with gap or black mark). It then appears in PrintNode's `capabilities.papers` for the Zebra and can be mapped. Keep the HP on A4.

**Template:** set the gift-message template to a 100 × 150 mm page (portrait, unless the user wants landscape), with margins of at least 3 mm, black text only, and a minimum font size that is still legible at 203 dpi. Test with:
- a short Greek message;
- a long English message near the overflow limit;
- line breaks.

**One roll at a time.** If gift cards and courier labels use different media (for example tags versus shipping labels), staff swap the roll between them. Decide this with the user before R4.

The first physical print on each printer needs the user's explicit approval. Record photos or notes, with no customer text, in the R1 report.

**Implemented 2026-10-24** (planner-implemented while Cursor was at its weekly limit):
- A **Gift cards** admin page (`admin/gift-cards`, `company.manage`) edits the template.
- A "Use Zebra 100 × 150 mm" preset fills: 100 × 150 mm portrait, 5 mm margins, 16 pt falling to a minimum of 9 pt, line height 1.25, centred both ways.
- The page warns when a margin is under 3 mm, the minimum font is under 8 pt, or the page is wider than the Zebra's 104 mm.
- `POST /c/:companyId/gift-message-templates/:id/preview` renders sample text with the saved template and returns the PDF, with `X-Gift-Fits`. The page opens it in a new tab. The sample text is not stored or logged.
- Layout is unit-tested at 100 × 150 mm for: a short Greek message at full size with its line breaks; a long English message stepped down but at least 9 pt; an overflow that reports not fitting and still draws all the text.
- Still to do at R1-H: tune the card on the real Zebra with the real label stock.

## R1-G. Automatic printing (R1-02, deferred)

The user chose **manual printing** on 2026-10-23: staff press Print on the order, which exists today. Automatic printing is deferred. If it comes back, the design is: when an order is imported with `payment_status = paid` and a gift message, queue the gift card as the system actor through an `inbox.process` follow-up job, behind its own company switch `printing.auto` (off by default). The `printing` switch and the first-print rule still apply.

## R1-H. Live checks and go-live

On the live laptop after R0, with `printing` off. Real customer data stays on the live laptop, never on the development Mac.

1. The user creates the key (U4) and types it into the settings screen. Test connection.
2. Fill the state and carrier maps. Set the first-import date to a few days back.
3. Turn on the n8n poll. Compare 10 recent orders with the PrestaShop admin: number, customer, address, lines, total, and the gift message. **Check one Greek gift message with line breaks byte-for-byte against the admin page.** If the Webservice returns HTML entities where the admin shows plain characters, stop and decide with the user before changing the mapper.
4. PrintNode: set the key, discover printers, set mappings.
5. With the user's approval, turn on `outbound.all` and `printing`, then do one physical test print each of a gift card and a packing slip.
6. Record everything in `docs/releases/r1-report.md`, marked **live-tested** (PrestaShop read-only, PrintNode). Use no customer names or messages in the report: use order ids only.

## R1-I. Gift cards with emoji (R1-03, found at R1-H)

Found on the live laptop on 2026-10-28. A real order's gift message ended in ❤️ (U+2764 U+FE0F). `unsupportedGlyphs` (`packages/documents/src/glyphs.ts`) checks every code point against Noto Sans Regular only, which has neither code point, so:
- the import set `review_required` ("Characters the gift card cannot print"), and
- `POST /print-requests` refuses the gift card with 422 `gift_message_needs_review`, with no way to proceed (`apps/api/src/printing/print.service.ts`, the `rendered.review` check).

Any gift message with an emoji therefore cannot be printed. Emoji are common in gift messages, so this is **P1**, in a strict area (printing): every finding blocks and the review runs at `xhigh`. The stored message was correct byte-for-byte; only drawing and printing are affected.

1. **Fallback fonts, black only** (the Zebra prints one colour). Bundle Noto Sans Symbols 2 and Noto Emoji (monochrome), both SIL OFL, in `packages/documents/assets/fonts` with their licence. Drawing and measuring use Noto Sans first and fall back per run of characters. The fit and line-wrap calculation measures each run with the font that draws it.
2. **Invisible code points.** U+FE0E and U+FE0F (variation selectors) and U+200D (zero-width joiner) are not unsupported: skip them in the check and do not draw them. The stored message never changes.
3. **What still cannot be drawn: print after confirming** (the user's decision, 2026-11-13, option A).
   - The order still goes to review on import, with the code points it cannot draw.
   - Without confirmation, the gift-card request stays 422 `gift_message_needs_review`, now with `unsupportedChars` as code points (`U+XXXX`) in the error, never the message text.
   - With confirmation, the request carries `unprintableAcknowledged: true` and a reason of at least 5 characters (the reprint rule). The card is drawn without those characters, and the job is queued as usual, behind the same switches and the first-print rule.
   - Audit `print_job.requested` with `unprintableAcknowledged`, the code points and the reason. No message text in the audit or the logs.
   - The Print dialog names the number of characters that will be left out and asks for the reason.
   - A message that does not fit (`fits = false`) stays refused, as today. Out of scope here.
4. The import review rule and the print check use the same function, so both follow 1 and 2.
5. **No gift-card template on a real company (R1-05, found 2026-11-13).** There is no route that creates a template; `POST /api/platform/companies` does not create one, and only the fictional seed does. On the laptop's company the Gift cards page is empty and a gift-card print would fail with `template_not_found`. Fix:
   - `createCompany` creates the default template in the same transaction, with the Zebra 100 × 150 mm preset values (R1-F), and audits it.
   - A migration gives every existing company without a template that same default. It runs as `bp_owner`, writes one audit row per template, and does nothing when a company already has one.
   - The Gift cards page shows a clear message, instead of an empty page, if a company still has no template.
   - Tests: a new company has exactly one default template; the migration fills only companies that have none and is safe to run twice; the page's empty state.

Tests:
- Unit (`packages/documents`): ❤️, 😊, a Greek message with line breaks ending in ❤️, a ZWJ family emoji, a skin-tone emoji, and a character no bundled font has. Each reports `fits` and exactly the unsupported code points. At 100 × 150 mm the text stays inside the margins.
- Integration: an order whose message ends in ❤️ imports **without** review, and its gift card can be queued. A message with an undrawable character is 422 without confirmation, queues with it, and audits the code points and the reason. With `printing` off the job is held.
- Component: the Print dialog's confirmation and its reason field.

## R1 acceptance

1. A new order placed in PrestaShop appears in the platform within 2 poll intervals, with an exact gift message.
2. Editing that order in PrestaShop updates the platform's source fields only. A gift-message change after printing sends it to review.
3. The poll never sends the key in a URL and never writes to the shop.
4. A gift card prints on the Zebra and a packing slip on the HP, both through PrintNode and chosen by the printer mapping, not by hand. The job shows "sent to printer (not confirmed)" until a person confirms it.
5. A second first print is refused, and a reprint needs a reason.
6. With `printing` off, a job is held, not printed.
7. The health screen shows the last sync and turns red when the poll stops.
8. Every new route passes the isolation sweep. Unit, integration and e2e tests pass. The Codex review has no open P0 or P1 finding.
