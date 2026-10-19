export const ROLE_KEYS = ['CA', 'OM', 'FS', 'FIN', 'MKT', 'CS', 'AUD'] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export type GrantLevel = 'company' | 'scoped';

export type PermissionPhase = 1 | 2 | 3 | 4 | 'later';

export type ScopableScope = 'store' | 'location' | 'mailbox' | 'integration_account';

export type PermissionDefinition = {
  key: string;
  meaning: string;
  phase: PermissionPhase;
  automationOnly: boolean;
  /** Scope types a non-company assignment may grant this permission for. */
  scopableBy: readonly ScopableScope[];
  grants: Partial<Record<RoleKey, GrantLevel>>;
};

function grants(pattern: string): Partial<Record<RoleKey, GrantLevel>> {
  const cells = pattern.split(/\s+/);
  if (cells.length !== ROLE_KEYS.length) {
    throw new Error(`permission pattern must have ${String(ROLE_KEYS.length)} cells: ${pattern}`);
  }
  const result: Partial<Record<RoleKey, GrantLevel>> = {};
  cells.forEach((cell, index) => {
    const role = ROLE_KEYS[index];
    if (!role) {
      throw new Error(`missing role at index ${String(index)}`);
    }
    if (cell === '.') {
      return;
    }
    if (cell === 'Y') {
      result[role] = 'company';
      return;
    }
    if (cell === 's') {
      result[role] = 'scoped';
      return;
    }
    throw new Error(`unknown grant cell "${cell}" in ${pattern}`);
  });
  return result;
}

function scopableBy(key: string): readonly ScopableScope[] {
  if (
    key.startsWith('order.') ||
    key === 'document.download' ||
    key.startsWith('print.') ||
    key === 'shipment.manage'
  ) {
    return ['store', 'location'];
  }
  if (key.startsWith('mailbox.')) {
    return ['mailbox'];
  }
  return [];
}

function perm(
  key: string,
  meaning: string,
  phase: PermissionPhase,
  pattern: string,
): PermissionDefinition {
  return { key, meaning, phase, automationOnly: false, scopableBy: scopableBy(key), grants: grants(pattern) };
}

function automation(key: string, meaning: string, phase: PermissionPhase): PermissionDefinition {
  return { key, meaning, phase, automationOnly: true, scopableBy: scopableBy(key), grants: {} };
}

/**
 * Permission catalogue. Role cells are CA OM FS FIN MKT CS AUD.
 * Y is company-wide, s is intended to be scoped, . is not granted.
 * The "s" marker is the default assignment shape. It is not a cap:
 * the same role can be assigned company-wide (fulfilment in company B).
 * docs/security/permission-matrix.md must match this list. A unit test checks it.
 */
export const PERMISSIONS: readonly PermissionDefinition[] = [
  perm('company.view', 'View company profile and settings', 1, 'Y Y Y Y Y Y Y'),
  perm('company.manage', 'Edit company profile, brands, locations, stores metadata', 1, 'Y . . . . . .'),
  perm('company.bank.view', 'View bank details', 1, 'Y . . Y . . Y'),
  perm('company.bank.manage', 'Change bank details', 1, 'Y . . . . . .'),
  perm('member.view', 'List members and their roles', 1, 'Y Y . . . . Y'),
  perm('member.invite', 'Invite employees', 1, 'Y . . . . . .'),
  perm('member.manage', 'Change roles, suspend, reactivate, remove', 1, 'Y . . . . . .'),
  perm('member.sessions.revoke', "Revoke another member's sessions", 1, 'Y . . . . . .'),
  perm('role.manage', 'Create and edit role bundles', 1, 'Y . . . . . .'),
  perm('audit.view', 'View the audit log', 1, 'Y Y . Y . . Y'),

  perm('client.view', 'View clients, contacts, addresses', 1, 'Y Y . Y . Y Y'),
  perm('client.manage', 'Create, edit, archive clients', 1, 'Y . . Y . . .'),
  perm('client.import', 'CSV import', 3, 'Y . . Y . . .'),
  perm('client.export', 'CSV export (formula-injection safe)', 3, 'Y . . Y . . .'),
  perm('catalog.view', 'View products and services', 1, 'Y Y Y Y Y Y Y'),
  perm('catalog.manage', 'Edit products and services', 1, 'Y Y . Y . . .'),
  perm('tax.manage', 'Edit tax codes', 1, 'Y . . Y . . .'),
  perm('invoice.view', 'View invoices and quotes, download their PDFs', 1, 'Y Y . Y . Y Y'),
  perm('invoice.draft', 'Create and edit draft quotes and invoices', 1, 'Y . . Y . . .'),
  perm('invoice.issue', 'Issue (allocate number, freeze snapshot)', 3, 'Y . . Y . . .'),
  perm('invoice.credit', 'Create credit notes and corrections', 3, 'Y . . Y . . .'),
  perm('invoice.send', 'Email invoices and statements', 3, 'Y . . Y . . .'),
  perm('invoice.export', 'Accountant export', 3, 'Y . . Y . . .'),
  perm('invoice.series.manage', 'Configure invoice series', 3, 'Y . . . . . .'),
  perm('payment.record', 'Record payments and allocations (not bank transfers)', 3, 'Y . . Y . . .'),
  perm('report.finance.view', 'Receivables and ageing reports', 3, 'Y . . Y . . Y'),

  perm('order.view', 'View orders, including customer and recipient data', 1, 'Y Y s Y . Y Y'),
  perm('order.edit', 'Add notes, correct operational fields', 1, 'Y Y s . . Y .'),
  perm('order.claim', 'Assign an order to yourself', 1, 'Y Y s . . . .'),
  perm('order.assign', 'Assign orders to anyone', 1, 'Y Y . . . . .'),
  perm('order.transition', 'Operational transitions (not cancel)', 1, 'Y Y s . . . .'),
  perm('order.cancel', 'Cancel operationally', 1, 'Y Y . . . . .'),
  perm('order.refund', 'Initiate refunds (at the store; later, with approval)', 'later', 'Y . . Y . . .'),
  perm('shipment.manage', 'Courier export, tracking, handover', 2, 'Y Y s . . . .'),
  perm('document.download', 'Download packing slips and gift-message PDFs', 1, 'Y Y s Y . Y Y'),
  perm('print.submit', 'Print a document for the first time', 1, 'Y Y s Y . . .'),
  perm('print.reprint', 'Intentional, audited reprint with a reason', 1, 'Y Y s Y . . .'),
  perm('print.confirm', 'Confirm physical output, or mark failed', 1, 'Y Y s Y . . .'),
  perm('printer.manage', 'Printer discovery, mapping, test print', 1, 'Y Y . . . . .'),

  perm('store.view', 'View store connections and their health', 1, 'Y Y . Y Y Y Y'),
  perm('store.manage', 'Create and edit store connections and credentials', 2, 'Y . . . . . .'),
  perm('integration.view', 'Integration health dashboard', 1, 'Y Y . . . . Y'),
  perm('integration.manage', 'Configure other integrations and their credentials', 2, 'Y . . . . . .'),
  perm('automation.view', 'Jobs, workflow activity, switches', 1, 'Y Y . . . . Y'),
  perm('automation.manage', 'Toggle company outbound switches', 1, 'Y . . . . . .'),
  perm('automation.replay', 'Release held jobs, replay failed ones', 1, 'Y Y . . . . .'),
  perm('service_identity.manage', 'Create and revoke automation tokens', 1, 'Y . . . . . .'),
  perm('approval.view', 'View approval requests', 3, 'Y Y . Y Y . Y'),
  perm('approval.decide', 'Approve or reject (also needs the domain permission)', 3, 'Y Y . Y . . .'),

  perm('mailbox.read', 'Read a specific mailbox', 3, 'Y s . s . s .'),
  perm('mailbox.send', 'Send from a specific mailbox (separate from read)', 3, 'Y s . s . s .'),
  perm('mailbox.manage', 'Configure mailboxes and signatures', 3, 'Y . . . . . .'),
  perm('marketing.contacts.view', 'View marketing contacts and consent', 4, 'Y . . . Y . .'),
  perm('marketing.contacts.manage', 'Edit lists and contacts (never undo suppression)', 4, 'Y . . . Y . .'),
  perm('campaign.draft', 'Draft campaigns and approved test sends', 4, 'Y . . . Y . .'),
  perm('campaign.send', 'Schedule or send approved campaigns', 4, 'Y . . . . . .'),
  perm('social.draft', 'Draft and schedule social posts', 4, 'Y . . . Y . .'),
  perm('social.publish', 'Publish approved posts', 4, 'Y . . . . . .'),
  perm('content.approve', 'Approve content versions', 4, 'Y . . . . . .'),

  automation(
    'store.events.ingest',
    "Post store events (webhook relay or poll results) to a store connection's inbox",
    1,
  ),
  automation(
    'store.sync.trigger',
    'Ask the app to run a sync or reconciliation for a connection',
    2,
  ),
];

const byKey = new Map(PERMISSIONS.map((permission) => [permission.key, permission]));

export function permissionByKey(key: string): PermissionDefinition | undefined {
  return byKey.get(key);
}

export function isAutomationOnly(key: string): boolean {
  return byKey.get(key)?.automationOnly === true;
}
