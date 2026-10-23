# Permission matrix

Source of truth in code: `packages/domain/src/authz/permissions.ts` (catalogue) and `role-templates.ts`. This document must match them, and a unit test checks that it does.

- Roles are **configurable permission bundles per company**. When a company is created, the templates below are copied into it as editable roles.
- An assignment is `(membership, role, scope)`, where scope is `company` (everything in the company) or `store:<id>`, `location:<id>`, `mailbox:<id>` or `integration_account:<id>`. A scoped assignment grants a permission only for resources carrying that scope. For example, a store-scoped `order.view` covers only that store's orders and grants nothing for invoices.
- **Scope semantics:** each catalogue entry declares which scope types it supports (`scopableBy`). For example, `order.*`, `document.download`, `print.*` and `shipment.manage` are scopable by store and location, `store.view` by store, and `mailbox.*` by mailbox. A scoped assignment grants **only** the role's permissions that are scopable by that assignment's scope type, limited to that scope. The role's other permissions are not granted through a scoped assignment, so a store-scoped admin role can never grant company-wide `member.manage`. Company-wide basics for scoped staff come from a separate company-wide assignment of the **BASE** template.
- **BASE ("staff baseline")** is a template with `company.view` and `catalog.view` only. Seed users with scoped operational roles also get BASE company-wide.
- Platform-owner capabilities are **not** permissions. They come from `user_account.is_platform_owner`, which only the seed or CLI can set. A platform owner has every company permission in every company, and their actions are still audited.

Legend:
- ✓ granted company-wide
- **s** granted, intended to be scoped (store or location for orders, mailbox for mail)
- blank: not granted

Templates:
- CA: company administrator
- OM: operations manager
- FS: fulfilment staff
- FIN: finance/accountant
- MKT: marketing
- CS: customer support
- AUD: read-only auditor

## Company and people

| Permission | Meaning | Phase | CA | OM | FS | FIN | MKT | CS | AUD |
|---|---|---|---|---|---|---|---|---|---|
| company.view | View company profile and settings | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| company.manage | Edit company profile, brands, locations, stores metadata | 1 | ✓ | | | | | | |
| company.bank.view | View bank details | 1 | ✓ | | | ✓ | | | ✓ |
| company.bank.manage | Change bank details | 1 | ✓ | | | | | | |
| member.view | List members and their roles | 1 | ✓ | ✓ | | | | | ✓ |
| member.invite | Invite employees | 1 | ✓ | | | | | | |
| member.manage | Change roles, suspend, reactivate, remove | 1 | ✓ | | | | | | |
| member.sessions.revoke | Revoke another member's sessions | 1 | ✓ | | | | | | |
| role.manage | Create and edit role bundles | 1 | ✓ | | | | | | |
| audit.view | View the audit log | 1 | ✓ | ✓ | | ✓ | | | ✓ |

## Clients, catalogue and invoicing

| Permission | Meaning | Phase | CA | OM | FS | FIN | MKT | CS | AUD |
|---|---|---|---|---|---|---|---|---|---|
| client.view | View clients, contacts, addresses | 1 | ✓ | ✓ | | ✓ | | ✓ | ✓ |
| client.manage | Create, edit, archive clients | 1 | ✓ | | | ✓ | | | |
| client.import | CSV import | 3 | ✓ | | | ✓ | | | |
| client.export | CSV export (formula-injection safe) | 3 | ✓ | | | ✓ | | | |
| catalog.view | View products and services | 1 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| catalog.manage | Edit products and services | 1 | ✓ | ✓ | | ✓ | | | |
| tax.manage | Edit tax codes | 1 | ✓ | | | ✓ | | | |
| invoice.view | View invoices and quotes, download their PDFs | 1 | ✓ | ✓ | | ✓ | | ✓ | ✓ |
| invoice.draft | Create and edit draft quotes and invoices | 1 | ✓ | | | ✓ | | | |
| invoice.issue | Issue (allocate number, freeze snapshot) | 3 | ✓ | | | ✓ | | | |
| invoice.credit | Create credit notes and corrections | 3 | ✓ | | | ✓ | | | |
| invoice.send | Email invoices and statements | 3 | ✓ | | | ✓ | | | |
| invoice.export | Accountant export | 3 | ✓ | | | ✓ | | | |
| invoice.series.manage | Configure invoice series | 3 | ✓ | | | | | | |
| payment.record | Record payments and allocations (not bank transfers) | 3 | ✓ | | | ✓ | | | |
| report.finance.view | Receivables and ageing reports | 3 | ✓ | | | ✓ | | | ✓ |

## Orders, documents and printing

| Permission | Meaning | Phase | CA | OM | FS | FIN | MKT | CS | AUD |
|---|---|---|---|---|---|---|---|---|---|
| order.view | View orders, including customer and recipient data | 1 | ✓ | ✓ | s | ✓ | | ✓ | ✓ |
| order.edit | Add notes, correct operational fields | 1 | ✓ | ✓ | s | | | ✓ | |
| order.claim | Assign an order to yourself | 1 | ✓ | ✓ | s | | | | |
| order.assign | Assign orders to anyone | 1 | ✓ | ✓ | | | | | |
| order.transition | Operational transitions (not cancel) | 1 | ✓ | ✓ | s | | | | |
| order.cancel | Cancel operationally | 1 | ✓ | ✓ | | | | | |
| order.refund | Initiate refunds (at the store; later, with approval) | later | ✓ | | | ✓ | | | |
| shipment.manage | Courier export, tracking, handover | 2 | ✓ | ✓ | s | | | | |
| document.download | Download packing slips and gift-message PDFs | 1 | ✓ | ✓ | s | ✓ | | ✓ | ✓ |
| print.submit | Print a document for the first time | 1 | ✓ | ✓ | s | ✓ | | | |
| print.reprint | Intentional, audited reprint with a reason | 1 | ✓ | ✓ | s | ✓ | | | |
| print.confirm | Confirm physical output, or mark failed | 1 | ✓ | ✓ | s | ✓ | | | |
| printer.manage | Printer discovery, mapping, test print | 1 | ✓ | ✓ | | | | | |

## Integrations and automation

| Permission | Meaning | Phase | CA | OM | FS | FIN | MKT | CS | AUD |
|---|---|---|---|---|---|---|---|---|---|
| store.view | View store connections and their health | 1 | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ |
| store.manage | Create and edit store connections and credentials | 2 | ✓ | | | | | | |
| integration.view | Integration health dashboard | 1 | ✓ | ✓ | | | | | ✓ |
| integration.manage | Configure other integrations and their credentials | 2 | ✓ | | | | | | |
| automation.view | Jobs, workflow activity, switches | 1 | ✓ | ✓ | | | | | ✓ |
| automation.manage | Toggle company outbound switches | 1 | ✓ | | | | | | |
| automation.replay | Release held jobs, replay failed ones | 1 | ✓ | ✓ | | | | | |
| service_identity.manage | Create and revoke automation tokens | 1 | ✓ | | | | | | |
| approval.view | View approval requests | 3 | ✓ | ✓ | | ✓ | ✓ | | ✓ |
| approval.decide | Approve or reject (also needs the domain permission) | 3 | ✓ | ✓ | | ✓ | | | |

## Mail, marketing and social

| Permission | Meaning | Phase | CA | OM | FS | FIN | MKT | CS | AUD |
|---|---|---|---|---|---|---|---|---|---|
| mailbox.read | Read a specific mailbox | 3 | ✓ | s | | s | | s | |
| mailbox.send | Send from a specific mailbox (separate from read) | 3 | ✓ | s | | s | | s | |
| mailbox.manage | Configure mailboxes and signatures | 3 | ✓ | | | | | | |
| marketing.contacts.view | View marketing contacts and consent | 4 | ✓ | | | | ✓ | | |
| marketing.contacts.manage | Edit lists and contacts (never undo suppression) | 4 | ✓ | | | | ✓ | | |
| campaign.draft | Draft campaigns and approved test sends | 4 | ✓ | | | | ✓ | | |
| campaign.send | Schedule or send approved campaigns | 4 | ✓ | | | | | | |
| social.draft | Draft and schedule social posts | 4 | ✓ | | | | ✓ | | |
| social.publish | Publish approved posts | 4 | ✓ | | | | | | |
| content.approve | Approve content versions | 4 | ✓ | | | | | | |

## Automation-only permissions (service identities only, never in human roles)

| Permission | Meaning | Phase |
|---|---|---|
| store.events.ingest | Post store events (webhook relay or poll results) to a store connection's inbox | 1 |
| store.sync.trigger | Ask the app to run a sync or reconciliation for a connection | 2 |

Only someone holding `service_identity.manage` can create a service identity. That person can grant it automation-only permissions. They can also grant it ordinary permissions (for example `order.view`), but only ones they hold themselves.

## Escalation and safety rules (enforced in the backend, tested)

1. To assign a role or edit its permissions, the actor must hold every permission in it at the same or a broader scope.
2. Actors can't change their own roles or membership status. Only a platform owner can.
3. Platform owners can't be targeted by `member.manage` from company admins.
4. Only a platform owner can remove or suspend the last active member holding `member.manage`, so a company can't lock itself out.
5. Suspension, removal and role changes take effect on the next request, because permissions load per request. `member.sessions.revoke` also deletes sessions.
6. Authorisation denials return 404 for objects in other companies or out of scope, and 403 for an in-scope permission miss. Both are audited with outcome `denied`.

## Examples from the brief, mapped

- Fulfilment can view their stores' orders and print packing documents. They get no `mailbox.*`, `company.bank.manage` or `order.refund`.
- Marketing can `campaign.draft`. Sending requires `campaign.send`, which only CA holds by default, plus an approval.
- Finance manages invoices with no `integration.manage`, `store.manage` or `service_identity.manage`, so no infrastructure credentials.
- A company admin can't grant platform-owner capabilities (they aren't a permission) and has no membership in other companies.
