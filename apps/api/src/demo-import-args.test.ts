import { describe, expect, it } from 'vitest';
import {
  PRESTASHOP_MILESTONE_EXTERNAL_ID,
  PRESTASHOP_MILESTONE_NUMBER,
  parseDemoArgs,
} from './demo-import-args';

describe('parseDemoArgs', () => {
  it('reads the company from either flag form', () => {
    expect(parseDemoArgs(['--company', 'A'])).toEqual({ company: 'A', prestashopOrder: false });
    expect(parseDemoArgs(['--company=B'])).toEqual({ company: 'B', prestashopOrder: false });
  });

  it('allows the PrestaShop order only for company A', () => {
    expect(parseDemoArgs(['--company', 'A', '--with-prestashop-order'])).toEqual({
      company: 'A',
      prestashopOrder: true,
    });
    expect(() => parseDemoArgs(['--company', 'B', '--with-prestashop-order'])).toThrow(
      '--with-prestashop-order is only for company A',
    );
  });

  it('rejects a missing company', () => {
    expect(() => parseDemoArgs([])).toThrow('usage:');
  });
});

describe('PrestaShop milestone order identity', () => {
  it('uses a stable fictional external id', () => {
    expect(PRESTASHOP_MILESTONE_EXTERNAL_ID).toBe('milestone-prestashop-1');
    expect(PRESTASHOP_MILESTONE_NUMBER).toBe('#P-1001');
  });
});
