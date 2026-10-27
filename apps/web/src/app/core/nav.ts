import type { Grant } from './models';

export type NavItem = {
  path: string;
  permission: string;
  labelKey: string;
  admin: boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { path: 'orders', permission: 'order.view', labelKey: 'nav.orders', admin: false },
  { path: 'clients', permission: 'client.view', labelKey: 'nav.clients', admin: false },
  { path: 'invoices', permission: 'invoice.view', labelKey: 'nav.invoices', admin: false },
  { path: 'admin/members', permission: 'member.view', labelKey: 'nav.members', admin: true },
  {
    path: 'admin/automation',
    permission: 'automation.view',
    labelKey: 'nav.automation',
    admin: true,
  },
  { path: 'admin/audit', permission: 'audit.view', labelKey: 'nav.audit', admin: true },
  { path: 'admin/printers', permission: 'printer.manage', labelKey: 'nav.printers', admin: true },
  { path: 'admin/company', permission: 'company.view', labelKey: 'nav.company', admin: true },
  { path: 'admin/stores', permission: 'store.view', labelKey: 'nav.stores', admin: true },
  { path: 'admin/gift-cards', permission: 'company.manage', labelKey: 'nav.giftCards', admin: true },
  {
    path: 'admin/integrations',
    permission: 'integration.view',
    labelKey: 'nav.integrations',
    admin: true,
  },
];

export function visibleNav(grants: readonly Pick<Grant, 'permission'>[]): NavItem[] {
  const held = new Set(grants.map((grant) => grant.permission));
  return NAV_ITEMS.filter((item) => held.has(item.permission));
}

/** Show an action the member holds, including one withheld until MFA so the refusal stays visible. */
export function canAttempt(
  grants: readonly Pick<Grant, 'permission'>[],
  withheld: readonly string[],
  mfaStepUpRequired: boolean,
  permission: string,
): boolean {
  if (holdsPermission(grants, permission)) {
    return true;
  }
  return mfaStepUpRequired && withheld.includes(permission);
}

export function holdsPermission(
  grants: readonly Pick<Grant, 'permission'>[],
  permission: string,
): boolean {
  return grants.some((grant) => grant.permission === permission);
}

/** First section this grant set can open, or null when the nav would be empty. */
export function firstAllowedPath(
  companyId: string,
  grants: readonly Pick<Grant, 'permission'>[],
): string | null {
  const first = visibleNav(grants)[0];
  if (!first) {
    return null;
  }
  return `/c/${companyId}/${first.path}`;
}

export function landingCompanyPath(companies: readonly { id: string }[]): string {
  const first = companies[0];
  return first ? `/c/${first.id}` : '/not-found';
}
