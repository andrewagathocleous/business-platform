import { parseAmount } from '@bp/domain';
import { describe, expect, it } from 'vitest';
import { decimalCell, textCell, writeCsv } from './csv';

describe('shared CSV writer', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('prefixes text starting with %j', (first) => {
    const value = `${first}Ελληνικά`;
    const expected = first === '\r' ? `"'${value}"` : `'${value}`;
    expect(writeCsv([[textCell(value)]]).toString('utf8')).toBe(`\uFEFF${expected}\r\n`);
  });

  it('writes a UTF-8 BOM, empty cells, Greek and exact customer whitespace', () => {
    const bytes = writeCsv([[textCell(''), textCell(null), textCell('Καλημέρα  κόσμε  ')]]);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toBe('\uFEFF,,Καλημέρα  κόσμε  \r\n');
  });

  it('quotes commas, quotes and embedded CR, LF and CRLF without rewriting text', () => {
    expect(
      writeCsv([
        [textCell('a,b'), textCell('a"b'), textCell('a\rb'), textCell('a\nb'), textCell('a\r\nb')],
        [textCell('plain')],
      ]).toString('utf8'),
    ).toBe('\uFEFF"a,b","a""b","a\rb","a\nb","a\r\nb"\r\nplain\r\n');
  });

  it('never prefixes a negative decimal and keeps fixed digits without converting to numbers', () => {
    expect(
      writeCsv([
        [
          decimalCell(parseAmount('-123.40', 2), 2),
          decimalCell(parseAmount('999999999999999.9999', 4), 4),
        ],
      ]).toString('utf8'),
    ).toBe('\uFEFF-123.40,999999999999999.9999\r\n');
  });

  it.each(['1e3', '=1', 'NaN', 'Infinity', ' 1.00', '1,00'])(
    'rejects non-plain decimal %s',
    (value) => {
      expect(() => writeCsv([[{ type: 'decimal', value }]])).toThrow('plain decimal');
    },
  );
});
