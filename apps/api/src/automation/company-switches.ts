/**
 * Company switches a company admin may change with `automation.manage`.
 * `outbound.all` is not in this list: it is global, and only a platform owner
 * can change it at `PUT /api/platform/switches/outbound.all`.
 * A company `PUT` of `outbound.all` or any other unknown key is 404
 * `switch_not_in_company`, because the company route only addresses these rows.
 *
 * The seed keeps its own copy in `packages/db/src/seed/run.ts` (`SWITCH_KEYS`).
 */
export const COMPANY_SWITCH_KEYS = [
  'printing',
  'email.send',
  'store.write',
  'marketing.send',
  'social.publish',
  'shipment.book',
  'invoice.issue_real',
] as const;

export type CompanySwitchKey = (typeof COMPANY_SWITCH_KEYS)[number];

export function isCompanySwitchKey(key: string): key is CompanySwitchKey {
  return (COMPANY_SWITCH_KEYS as readonly string[]).includes(key);
}
