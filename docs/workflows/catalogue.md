# n8n workflow catalogue

Every workflow is exported in sanitised form to `workflows/n8n/exports/<id>.json` (no credentials, no pinned data) for the pinned n8n version. The status column says honestly whether an export exists and how it was tested.

Common contract for every workflow:

- **Service identity:** one per company and workflow, holding the minimum permissions, stored in n8n as Header Auth.
- **Correlation id:** passed as `X-Correlation-Id` on every app call and echoed in notifications.
- **Validation:** the app validates all input with zod. n8n checks response status and schema version.
- **Retries:** bounded (3, exponential), and only on app calls marked idempotent (they use idempotency keys).
- **Timeout:** 30 s per HTTP node by default.
- **Rate limits:** the app returns `429` with `Retry-After`, which n8n honours.
- **Failure path:** an error workflow notifies the technical admin and records a failure through `POST /automation/v1/c/:companyId/workflow-failures`.
- **Manual replay:** re-run from the app's job or inbox screen (`automation.replay`), never by re-executing a partially completed n8n execution that already caused side effects.

| # | Workflow | Trigger | App APIs used | Side effects | Status |
|---|---|---|---|---|---|
| W0 | PrestaShop poll | Schedule every minute | `POST /api/automation/v1/c/:companyId/store-sync` | Queues `prestashop.poll`. No shop write | Exported inactive in `workflows/n8n/exports/w0-store-sync.json`. The company id is replaced after import. Not live-tested |
| W1 | Store order import | Webhook received by the app → app outbox → n8n webhook (internal). PrestaShop polling is W0 | `POST …/store-connections/:id/events` (Phase 1 mock contract) | Staff notification | Phase 1: app contract and mock fixture only. PrestaShop schedule is the W0 export |
| W2 | Order ready → documents → print | App outbox event `order.ready` | `POST …/orders/:id/print-requests` | Print (switch-gated) | planned (Phase 2) |
| W3 | Invoice issued → send | App outbox event `invoice.issued` | `POST …/invoices/:id/send-requests` | Email (switch- and approval-gated) | planned (Phase 3) |
| W4 | Mailbox event → match → assign | Graph notification received by the app, or schedule | `POST …/mailboxes/:id/sync`, `…/threads/:id/match` | Notification | planned (Phase 3) |
| W5 | Products → AI draft → approval → publish | Manual from app | `…/content-drafts`, `…/approvals` | Campaign/social (approval-gated) | planned (Phase 4) |
| W6 | Reconciliation, expiring credentials, failed jobs | n8n schedule | `…/reconciliation-runs`, `GET …/health/credentials`, `GET …/jobs?status=failed` | Notification | planned (Phase 2+) |
