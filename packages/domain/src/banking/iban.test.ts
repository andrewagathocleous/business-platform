import { describe, expect, it } from 'vitest';
import { isValidBic, isValidIban, normalizeBic, normalizeIban } from './iban';

describe('IBAN', () => {
  it('accepts the registry example IBANs once normalised', () => {
    expect(normalizeIban(' cy17 0020 0128 0000 0012 0052 7600 ')).toBe(
      'CY17002001280000001200527600',
    );
    expect(isValidIban(normalizeIban('CY17 0020 0128 0000 0012 0052 7600'))).toBe(true);
    expect(isValidIban(normalizeIban('GR16 0110 1250 0000 0001 2300 695'))).toBe(true);
    expect(isValidIban(normalizeIban('GB82 WEST 1234 5698 7654 32'))).toBe(true);
    expect(isValidIban(normalizeIban('DE89 3704 0044 0532 0130 00'))).toBe(true);
  });

  it('accepts the registry example IBAN of every SEPA country it checks', () => {
    const examples = [
      'AD1200012030200359100100',
      'AT611904300234573201',
      'BE68539007547034',
      'BG80BNBG96611020345678',
      'CH9300762011623852957',
      'CY17002001280000001200527600',
      'CZ6508000000192000145399',
      'DE89370400440532013000',
      'DK5000400440116243',
      'EE382200221020145685',
      'ES9121000418450200051332',
      'FI2112345600000785',
      'FR1420041010050500013M02606',
      'GB82WEST12345698765432',
      'GI75NWBK000000007099453',
      'GR1601101250000000012300695',
      'HR1210010051863000160',
      'HU42117730161111101800000000',
      'IE29AIBK93115212345678',
      'IS140159260076545510730339',
      'IT60X0542811101000000123456',
      'LI21088100002324013AA',
      'LT121000011101001000',
      'LU280019400644750000',
      'LV80BANK0000435195001',
      'MC5811222000010123456789030',
      'MT84MALT011000012345MTLCAST001S',
      'NL91ABNA0417164300',
      'NO9386011117947',
      'PL61109010140000071219812874',
      'PT50000201231234567890154',
      'RO49AAAA1B31007593840000',
      'SE4550000000058398257466',
      'SI56263300012039086',
      'SK3112000000198742637541',
      'SM86U0322509800000000270100',
      'VA59001123000012345678',
    ];
    expect(examples.filter((iban) => !isValidIban(iban))).toEqual([]);
  });

  it('refuses a checksum-valid IBAN whose bank code has letters where the country needs digits', () => {
    expect(isValidIban('CY61AAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('refuses a wrong check digit, a mistyped digit, a wrong length or a bad format', () => {
    expect(isValidIban('CY18002001280000001200527600')).toBe(false);
    expect(isValidIban('CY17002001280000001200527601')).toBe(false);
    expect(isValidIban('CY1700200128000000120052760')).toBe(false);
    expect(isValidIban('GB82WEST1234569876543')).toBe(false);
    expect(isValidIban('cy17002001280000001200527600')).toBe(false);
    expect(isValidIban('CY17-0020-0128-0000-0012-0052-7600')).toBe(false);
    expect(isValidIban('')).toBe(false);
    expect(isValidIban('CY00DEMO')).toBe(false);
  });
});

describe('BIC', () => {
  it('accepts 8 and 11 characters and refuses other shapes', () => {
    expect(normalizeBic(' abcdcy2n ')).toBe('ABCDCY2N');
    expect(isValidBic('ABCDCY2N')).toBe(true);
    expect(isValidBic('ABCDCY2NXXX')).toBe(true);
    expect(isValidBic('ABCD1Y2N')).toBe(false);
    expect(isValidBic('ABCDCY2NXX')).toBe(false);
    expect(isValidBic('abcdcy2n')).toBe(false);
  });
});
