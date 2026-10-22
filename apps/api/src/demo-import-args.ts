export const PRESTASHOP_MILESTONE_EXTERNAL_ID = 'milestone-prestashop-1';
export const PRESTASHOP_MILESTONE_NUMBER = '#P-1001';

export type DemoCompany = 'A' | 'B';

export type DemoArgs = {
  company: DemoCompany;
  prestashopOrder: boolean;
};

/**
 * The inbox processor rejects a PrestaShop connection (`unsupported_provider`),
 * so the milestone's out-of-scope order cannot be created through the HTTP import.
 * `--with-prestashop-order` inserts one fictional order on Company A's PrestaShop
 * store. The milestone script then checks it through the HTTP API.
 */
export function parseDemoArgs(argv: readonly string[]): DemoArgs {
  const inline = argv.find((arg) => arg.startsWith('--company='));
  const index = argv.indexOf('--company');
  const value = index >= 0 ? argv[index + 1] : inline?.slice('--company='.length);
  if (value !== 'A' && value !== 'B') {
    throw new Error('usage: pnpm demo:import-fixtures --company A|B [--with-prestashop-order]');
  }
  const prestashopOrder = argv.includes('--with-prestashop-order');
  if (prestashopOrder && value !== 'A') {
    throw new Error('--with-prestashop-order is only for company A');
  }
  return { company: value, prestashopOrder };
}
