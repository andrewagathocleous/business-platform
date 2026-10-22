import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { isCanonicalAutomationQuery, parseAutomationQuery } from './automation-query';

describe('parseAutomationQuery', () => {
  it('rejects a page above the API maximum instead of treating it as canonical', () => {
    const params = convertToParamMap({ jobPage: '1000001', printPage: '1000001' });
    expect(parseAutomationQuery(params).jobPage).toBe(1);
    expect(parseAutomationQuery(params).printPage).toBe(1);
    expect(isCanonicalAutomationQuery(params)).toBe(false);
  });

  it('rejects a digit string that is not a safe integer', () => {
    const params = convertToParamMap({ jobPage: `1${'0'.repeat(400)}` });
    const page = parseAutomationQuery(params).jobPage;
    expect(Number.isFinite(page)).toBe(true);
    expect(page).toBe(1);
    expect(isCanonicalAutomationQuery(params)).toBe(false);
  });
});
