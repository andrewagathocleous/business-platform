# Release 1 plan: PrestaShop orders and printing

Owner: planner (Claude Code). Implementer: Cursor CLI. Reviewer: Codex CLI.
Written 2026-10-23. The code can be built before R0 is live; it goes live on the R0 base, which is a dedicated laptop for now. Every call in R1 is outbound, so the laptop works as the host.

**Goal.** New orders from the PrestaShop shop appear in the platform within a few minutes, with the gift message exactly as the customer typed it. Staff print the gift card and the packing slip on the shop's HP LaserJet M209dw through PrintNode. Shopify orders join the same flow in R3.

**Known about the shop (user, 2026-10-23).**
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
| U6 | A PrintNode account. The PrintNode client installed on the shop's Windows desktop PC that drives the M209dw, and the hours that PC is on | before R1-D live checks |
| U7 | The gift-card size, how cards are fed (tray or manual slot), and a few blank cards for tests | before R1-F |
| U4 | A new Webservice key, **GET only**, on `orders`, `customers`, `addresses`, `countries`, `carriers`, `order_states` and `currencies`. Nothing else, and never `configurations`. The user types it into the platform's settings screen, never into chat | at R1-H |
| — | The shop's timezone (Localization → Configuration) | at R1-H |
| — | Which order states mean "paid" and which mean "cancelled". The settings screen lists the shop's states once the key works | at R1-H |

The `customers` resource also carries the password hash and secure key. The client asks for `display=[id,firstname,lastname,email]` only, so those fields are never transferred.

## R1-A. Outbound HTTP client (P2-05)

`packages/integrations/src/http/safe-fetch.ts`. Every connector uses it; nothing else calls `fetch` for providers.

- HTTPS only. Resolve the host first and reject loopback, private, link-local, CGNAT, multicast, unspecified, IPv6 unique-local and IPv4-mapped forms of those.
- Connect to the address that was checked: an undici `Agent` with a `lookup` that returns the validated address. A DNS answer cannot change between the check and the connection.
- `redirect: 'manual'`. At most 3 redirects, each re-validated, never from HTTPS to HTTP. Credentials are dropped on a cross-origin redirect.
- Timeouts for connect and total time, and a response size cap (default 10 MB). Clear typed errors: `BlockedDestination`, `TimeoutBeforeSend`, `TimeoutAfterSend`, `ResponseTooLarge`, `HttpStatus`.
- No credential in a URL; a URL with userinfo is refused. The logger redacts `authorization` and every header named in the call's `secretHeaders`.
- **Tests (unit):**
  - every blocked range;
  - a DNS answer that changes between lookups;
  - a redirect to a private address;
  - HTTPS to HTTP;
  - the size cap;
  - redaction.

  Local test servers need `allowLoopbackForTests`, which is accepted only when `APP_ENV=test`. A test proves the flag is refused otherwise.

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

## R1-C. PrestaShop reader (P2-04)

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

## R1-F. Gift-card template (P2-11)

With the real card size and feed from U7, set the template's page size, margins, fonts and minimum font size. Match a PrintNode paper name, creating a custom paper on the PC driver if the card size is not listed.

The first physical print needs the user's explicit approval. Then print one card per test message:
- a short Greek message;
- a long English message near the overflow limit;
- line breaks.

Record photos or notes in the R1 report.

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

## R1 acceptance

1. A new order placed in PrestaShop appears in the platform within 2 poll intervals, with an exact gift message.
2. Editing that order in PrestaShop updates the platform's source fields only. A gift-message change after printing sends it to review.
3. The poll never sends the key in a URL and never writes to the shop.
4. A gift card and a packing slip print on the M209dw through PrintNode. The job shows "sent to printer (not confirmed)" until a person confirms it.
5. A second first print is refused, and a reprint needs a reason.
6. With `printing` off, a job is held, not printed.
7. The health screen shows the last sync and turns red when the poll stops.
8. Every new route passes the isolation sweep. Unit, integration and e2e tests pass. The Codex review has no open P0 or P1 finding.
