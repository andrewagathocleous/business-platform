# n8n exports

Sanitised workflow JSON. No credential secrets and no pinned data.

## W0 PrestaShop poll

`w0-store-sync.json` is inactive. A Schedule Trigger runs every minute and POSTs `http://api:3000/api/automation/v1/c/REPLACE_WITH_COMPANY_ID/store-sync`. In `infra/compose/compose.prod.yml` the API service is named `api`, listens on port 3000, and shares the `internal` network with `n8n` (`n8nio/n8n:2.43.7`).

The HTTP Request node uses a Header Auth credential named `bp store-sync token`. That credential is not in this export. Create it in n8n after import. Its header name is `Authorization` and its value is `Bearer` plus a token from `POST /api/c/:companyId/service-identities` with permission `store.sync.trigger`.

Import:

1. `workflows/n8n/scripts/import.sh` copies this directory into the n8n container and runs `n8n import:workflow --separate`.
2. The importer is expected to read `*.json` only. This directory also contains this README and `.gitkeep`. If a non-JSON file makes the import fail, import `w0-store-sync.json` on its own.
3. In the n8n editor, replace `REPLACE_WITH_COMPANY_ID` with the company id. That replacement is a one-time manual step.
4. Create the Header Auth credential under the name `bp store-sync token` and select it on the HTTP Request node if the import did not bind the name.
5. Activate the workflow when that company should be polled. The export stays inactive so an import does not start polling.

The trigger writes no audit row. The queue job is the record. See `docs/integrations/prestashop.md`.

The sanitiser allows `nodes.<index>.type` when the value is `n8n-nodes-base.<name>`. A `type` property on any other path is checked. Those node names are longer than the entropy limit and are not credentials.
