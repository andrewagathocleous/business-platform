import { describe, expect, it } from 'vitest';
import { normalizeForDuplicateCheck } from './normalize';

describe('normalizeForDuplicateCheck', () => {
  it('folds case, compatibility characters and legal suffixes without touching stored text', () => {
    const stored = {
      displayName: '  Acme   Ltd.  ',
      giftMessage: 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη,\nΓιώργος',
    };
    const before = { ...stored };
    expect(normalizeForDuplicateCheck(stored.displayName)).toBe('acme');
    expect(normalizeForDuplicateCheck('Acme Limited')).toBe('acme');
    expect(normalizeForDuplicateCheck('Acme, Ltd')).toBe('acme');
    expect(normalizeForDuplicateCheck('Limited Edition Nuts')).toBe('limited edition nuts');
    expect(normalizeForDuplicateCheck('\u2126 Mega')).toBe('ω mega');
    expect(stored).toEqual(before);
    expect(stored.giftMessage).toBe('Χρόνια πολλά, Μαρία!\n\nΜε αγάπη,\nΓιώργος');
  });
});
