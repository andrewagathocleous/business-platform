# Shopify

Phase 1 does not call Shopify. Orders enter through a mock inbox contract. The mapper's API version is the string `unverified; check in Phase 2` (`SHOPIFY_ORDER_API_VERSION` in `packages/integrations/src/shopify/map-order.ts`). No shop token is configured.

## What Phase 1 has

### Mapper

`mapShopifyOrder` reads a fixture shaped like a Shopify Admin GraphQL order. Money fields are strings. A JSON number in a money field throws `ShopifyMapError`. `displayFinancialStatus` maps to the platform payment status (`PENDING`, `AUTHORIZED`, `PARTIALLY_PAID`, `PAID`, `PARTIALLY_REFUNDED`, `REFUNDED`, `VOIDED`; anything else is `unknown`). Delivery comes from `shippingLine.code` or `title` through the store's `deliveryMethodMap`. An unknown method is `unknown`.

Fixtures live in `packages/integrations/shopify/fixtures/`. Each file's `_meta.apiVersion` is `unverified; check in Phase 2`. Company A fixtures used by `apps/api/src/demo-import-fixtures.ts`:

- `order-1001-paid-greek-gift.json`
- `order-1001-updated-later.json`
- `order-1001-updated-earlier.json`
- `order-1002-pending-international.json`
- `order-1003-emoji-gift.json`

Company B uses `order-2001-company-b.json` on the Olive Grove Demo Shopify store.

### Gift message, byte for byte

`mapGiftMessage` returns the first matching `customAttributes` value whose key is in the store's `giftMessageKeys`. The schema default is `Gift Message`, `gift_message` and `Gift message` (`packages/db/prisma/schema.prisma`). The value is returned as the string Shopify sent. The mapper does not trim it.

The inbox processor stores that string on the order. `sameText` in `apps/api/src/automation/inbox.processor.ts` compares UTF-8 bytes, so a later import can see a real change, including a trailing space. The stored column is `sales_order.gift_message`. The order `#1001` fixture uses the key `Gift Message` and includes Greek text, a blank line and a trailing space. The integration test compares those bytes with the stored value.

### Inbox import

`POST /api/automation/v1/c/:companyId/store-connections/:connectionId/events` (`apps/api/src/automation/automation.controller.ts`) accepts `eventId`, `topic`, `occurredAt` and `payload`. `topic` is `orders/create` or `orders/updated`. The body is zod (`eventBody`). `payload` is the order object: the demo import posts the fixture file as-is. The route requires permission `store.events.ingest` and a bearer service token. A staff session on an automation route is `401` with audit reason `automation_requires_bearer`.

`InboxService.ingest` inserts `integration_inbox` in the same transaction as the `inbox.process` job. The conflict target is `(company_id, connection_id, external_event_id)`. A repeat increments `duplicate_count` and returns `duplicate` instead of inserting a second row. The connection must be `active` and `mode` `mock`. Anything else is 404 (`connection_not_found`, `connection_not_active` or `connection_not_mock`).

`inbox.process` (`apps/api/src/automation/inbox.processor.ts`) maps only `platform === 'shopify'`. Any other platform fails the inbox row with `unsupported_provider`. That is why `pnpm demo:import-fixtures --company A --with-prestashop-order` inserts the fictional PrestaShop order `#P-1001` through `TenantDb` and not through this route. The default import does not.

A newer `sourceUpdatedAt` updates the order. An older one leaves the order and marks the inbox row `stale`. `max_attempts` for `inbox.process` is 5.

### Service token

Service identities are company-wide. The token is `bps_<id>.<secret>` (`apps/api/src/tenancy/service-identity.service.ts`). Only the SHA-256 of the secret is stored (`secret_hash`). The plaintext is returned once. Automation routes accept `Authorization: Bearer bps_…` and reject a staff cookie. The demo import writes the token to `var/demo-service-identities.json` (mode `0600`) and does not print it.

`GET /api/automation/v1/c/:companyId/ping` checks the token and returns `{ "ok": true }`. It does not ingest.

### How it was tested

Mock-tested and integration-tested against real Postgres. Not sandbox-tested and not live-tested. No Shopify shop is called.

<!-- prettier-ignore -->
| Test | Level | What it shows |
| --- | --- | --- |
| `packages/integrations/src/shopify/map-order.test.ts` `documents the financial status table and the unverified API version` | unit | The version string stays unverified |
| `packages/integrations/src/shopify/map-order.test.ts` `keeps the Greek gift message bytes, including the trailing space` | unit | Gift text is not trimmed |
| `packages/integrations/src/shopify/map-order.test.ts` `falls back to unknown delivery and rejects a JSON number in a money field` | unit | Money stays decimal strings |
| `packages/integrations/src/shopify/map-order.test.ts` `marks every fixture with the unverified API version` | unit | Every fixture file |
| `apps/api/src/orders.integration.test.ts` `imports a fixture once, counts a duplicate, and keeps the gift message bytes` | integration | Dedupe and stored bytes |
| `apps/api/src/orders.integration.test.ts` `applies a newer source update and leaves a stale one untouched` | integration | `sourceUpdatedAt` ordering |
| `apps/api/src/orders.integration.test.ts` `imports the other fixtures and isolates companies, stores and service identities` | integration | Company B's token does not read company A |
| `apps/api/src/tenancy.integration.test.ts` `creates, limits, expires and revokes service tokens` | integration | Token lifetime and revocation |
| `apps/api/src/tenancy.integration.test.ts` `rejects a staff cookie on the automation ping route` | integration | Bearer only |

`node tools/smoke-dist.mjs` maps one order through the built `packages/integrations` package. That does not call Shopify.

There is no Shopify webhook route and no HMAC check. `captureRawBody` in `apps/api/src/http/configure-http.ts` keeps the raw JSON body on each request. The test `captures the raw body for webhook routes` in `apps/api/src/http.integration.test.ts` posts to a probe controller defined in that test file (`/api/probe/raw`). It is not a Shopify endpoint.

## What Phase 2 must verify

**Planned (Phase 2), not implemented.** Record these against Shopify's docs before writing a client, from [provider-constraints.md](provider-constraints.md):

- The current stable Admin GraphQL version. The code's version string is still `unverified; check in Phase 2`.
- App creation path (custom app in the admin, or the dev dashboard) and the token type.
- Scopes `read_orders`, `read_customers`, `read_products`, and `read_all_orders` for history beyond 60 days.
- Protected customer data requirements.
- Webhook HMAC and delivery semantics. Phase 1 does not verify HMAC.
- The throttling cost model.

Backlog: P2-01 records those checks, P2-02 is the read-only connector, P2-03 is webhooks with raw-body HMAC into the inbox plus a reconciliation job. P2-05, the SSRF-safe HTTP client, is required before that connector calls the network. None of those exist in the code.

## Credentials

**Planned (Phase 2), not implemented.** The Admin API token and the webhook secret will live in the credential vault (`CredentialVault` in `apps/api/src/vault/credential-vault.ts`), per connection, under `APP_MASTER_KEYS`. See [docs/adr/0007-credentials-and-outbound-safety.md](../adr/0007-credentials-and-outbound-safety.md). The webhook secret is verified by the API. The worker will call Shopify.

No route calls the vault. Phase 1 stores no Shopify credential. Inbox ingest accepts only `mode: mock`.
