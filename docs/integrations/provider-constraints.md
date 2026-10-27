# Provider constraints and verification log

Provider features change, so every claim here carries a check date and a source. "To verify" items must be checked against official documentation, and recorded here, before the integration is built.

## n8n (verified 2026-10-19)

- Version pinned: `n8nio/n8n:2.43.7` with `n8nio/runners:2.43.7`. npm dist-tag `stable` = 2.43.7 on 2026-10-19; runner and n8n versions must match.
- Community Edition excludes custom variables, environments, Git source control, external secrets, external binary storage, log streaming, multi-main, projects, SAML/LDAP SSO, and workflow/credential sharing. Free registration unlocks folders, debug in editor and custom execution data. Source: https://docs.n8n.io/hosting/community-edition-features/
- Default `NODES_EXCLUDE` = `["n8n-nodes-base.executeCommand","n8n-nodes-base.localFileTrigger"]`. `N8N_COMMUNITY_PACKAGES_ENABLED` defaults to `true`, so we set it to `false`. Source: https://docs.n8n.io/hosting/configuration/environment-variables/nodes/
- `N8N_BLOCK_ENV_ACCESS_IN_NODE` defaults to `false`, so we set it to `true`. `N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES` defaults to `true`. `N8N_SECURE_COOKIE` defaults to `true`. Source: https://docs.n8n.io/hosting/configuration/environment-variables/security/
- Task runners: from 2.0 there's no need to set `N8N_RUNNERS_ENABLED`. Internal mode isn't recommended for production; use `N8N_RUNNERS_MODE=external` with the `n8nio/runners` sidecar, `N8N_RUNNERS_AUTH_TOKEN` and `N8N_RUNNERS_BROKER_LISTEN_ADDRESS=0.0.0.0`. Source: https://docs.n8n.io/hosting/configuration/task-runners/
- Licence: Sustainable Use License. Internal business use is the intended case. **Reassess before any external SaaS offering.** Still to verify: the current licence text at https://docs.n8n.io/sustainable-use-license/.

## To verify before each integration phase

| Provider | What to verify | Phase | Source |
|---|---|---|---|
| Shopify | Current stable Admin GraphQL version; app creation path (custom app in admin vs dev dashboard) and token type; required scopes (`read_orders`, `read_customers`, `read_products`; `read_all_orders` for history beyond 60 days); protected customer data requirements; webhook HMAC and delivery semantics; throttling cost model | 2 | https://shopify.dev/docs/api/admin-graphql/latest |
| PrestaShop | Installed version on the real shop; Webservice availability, key permissions per resource; HTTPS; filters for `date_upd` polling; no built-in webhooks assumed | 2 | https://devdocs.prestashop-project.org/9/webservice/ (pick the installed version) |
| PrintNode | API auth, printers and computers endpoints, `printjobs` options (copies, paper, tray), idempotency header and its dedupe window, job states (`done` ≠ paper out), PDF delivery by base64 vs URI | 2 | https://www.printnode.com/en/docs/api/curl |
| Svelta / EasyCourier | Whether an API exists, access terms, export/import formats; else a manual workflow | 2 | provider contact |
| Cyprus Post ePost | Integration method (portal/export), customs data requirements (CN22/CN23) | 2 | provider contact |
| Microsoft Graph mail | Delegated vs application permissions; shared mailbox access; change notifications need application permissions for shared mailboxes; Exchange RBAC for Applications scoping; Send As vs Send on Behalf; delta queries | 3 | https://learn.microsoft.com/en-us/graph/outlook-share-messages-folders, https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user, https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac |
| Entra ID (staff login) | ID token claims for MFA (`amr`/`acrs`) in v2 tokens, optional claims config; guest/unlicensed sign-in | 1 (doc) / live when tenant available | Microsoft identity platform docs |
| EU / Cyprus VAT invoicing | Mandatory invoice fields, simplified invoices, credit notes, retention, e-invoicing timelines (ViDA) | 3 | https://taxation-customs.ec.europa.eu/taxation/vat/vat-businesses/invoicing_en, Cyprus Tax Department |
| Brevo | Contacts/lists API, consent and suppression semantics, campaign API, transactional vs marketing separation, sender domain authentication | 4 | https://developers.brevo.com/ |
| Meta (Facebook/Instagram) | Page and IG professional account publishing permissions, app review, business verification, token lifetimes | 4 | https://developers.facebook.com/docs/ |
| LinkedIn | Community Management API access tiers, organisation page posting, review requirements; no general inbox access | 4 | https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access |
