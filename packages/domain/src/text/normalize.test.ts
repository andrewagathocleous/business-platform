import { describe, expect, it } from 'vitest';
import { foldForComparison, normalizeForDuplicateCheck } from './normalize';

describe('foldForComparison', () => {
  it('folds sharp s so Straße matches STRASSE', () => {
    expect(foldForComparison('Straße-1')).toBe('STRASSE-1');
    expect(foldForComparison('STRASSE-1')).toBe(foldForComparison('Straße-1'));
  });

  it('folds both Greek sigma forms to capital sigma', () => {
    expect(foldForComparison('ΟΣ-1')).toBe('ΟΣ-1');
    expect(foldForComparison('οσ-1')).toBe('ΟΣ-1');
    expect(foldForComparison('ος-1')).toBe('ΟΣ-1');
  });

  it('keeps accented Greek distinct from unaccented', () => {
    expect(foldForComparison('ά')).toBe('Ά');
    expect(foldForComparison('α')).toBe('Α');
    expect(foldForComparison('ά')).not.toBe(foldForComparison('α'));
  });

  it('folds Latin case', () => {
    expect(foldForComparison('Receipt')).toBe('RECEIPT');
    expect(foldForComparison('abc')).toBe('ABC');
  });

  it('applies NFKC before upper case, including the fi ligature', () => {
    expect(foldForComparison('\uFB01')).toBe('FI');
    expect(foldForComparison('\u2126')).toBe('Ω');
  });
});

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
    expect(normalizeForDuplicateCheck('ΝΙΚΟΣ')).toBe('νικος');
    expect(stored).toEqual(before);
    expect(stored.giftMessage).toBe('Χρόνια πολλά, Μαρία!\n\nΜε αγάπη,\nΓιώργος');
  });
});
