import { describe, expect, it } from 'vitest';
import { calculateCreditTotals, type CreditSourceLine } from './credit';
import Decimal from './decimal';
import { calculateDocumentTotals, type DocumentTotals } from './totals';

function source(
  key: string,
  unitPrice: string,
  taxCode = 'STD19',
  rate = '19',
  quantity = '1',
  discountPercent = '0',
): Omit<CreditSourceLine, 'creditedBefore'> {
  return { key, quantity, unitPrice, discountPercent, taxCode, taxRatePercent: rate };
}

/** Credits `steps` one after another, carrying what each issued credit took. */
function creditInSteps(
  pricesIncludeTax: boolean,
  sources: Omit<CreditSourceLine, 'creditedBefore'>[],
  steps: { sourceKey: string; quantity: string }[][],
): DocumentTotals[] {
  const credited = new Map<string, Decimal>();
  return steps.map((step) => {
    const totals = calculateCreditTotals({
      pricesIncludeTax,
      sources: sources.map((line) => ({
        ...line,
        creditedBefore: (credited.get(line.key) ?? new Decimal(0)).toString(),
      })),
      lines: step.map((line, index) => ({ position: index + 1, ...line })),
    });
    for (const line of step) {
      credited.set(
        line.sourceKey,
        (credited.get(line.sourceKey) ?? new Decimal(0)).plus(line.quantity),
      );
    }
    return totals;
  });
}

describe('calculateCreditTotals', () => {
  it('reverses VAT 0.16, 0.16 and 0.15 for three tax-inclusive 0.99 lines credited one at a time', () => {
    const sources = [source('a', '0.99'), source('b', '0.99'), source('c', '0.99')];
    const credits = creditInSteps(true, sources, [
      [{ sourceKey: 'a', quantity: '1' }],
      [{ sourceKey: 'b', quantity: '1' }],
      [{ sourceKey: 'c', quantity: '1' }],
    ]);
    expect(credits.map((credit) => credit.taxTotal)).toEqual(['0.16', '0.16', '0.15']);
    expect(credits.map((credit) => credit.total)).toEqual(['0.99', '0.99', '0.99']);
    expect(credits.map((credit) => credit.netTotal)).toEqual(['0.83', '0.83', '0.84']);
  });

  it('reverses VAT 0.01, 0.00, 0.01, 0.00 for four tax-exclusive 0.03 items credited one at a time', () => {
    const fourLines = creditInSteps(
      false,
      [source('a', '0.03'), source('b', '0.03'), source('c', '0.03'), source('d', '0.03')],
      ['a', 'b', 'c', 'd'].map((key) => [{ sourceKey: key, quantity: '1' }]),
    );
    expect(fourLines.map((credit) => credit.taxTotal)).toEqual(['0.01', '0.00', '0.01', '0.00']);
    const oneLine = creditInSteps(
      false,
      [source('a', '0.03', 'STD19', '19', '4')],
      [1, 2, 3, 4].map(() => [{ sourceKey: 'a', quantity: '1' }]),
    );
    expect(oneLine.map((credit) => credit.taxTotal)).toEqual(['0.01', '0.00', '0.01', '0.00']);
  });

  it('never puts a negative amount on a credit for tax-inclusive 11.93 and 11.92 lines', () => {
    const credits = creditInSteps(
      true,
      [source('a', '11.93'), source('b', '11.92')],
      [[{ sourceKey: 'a', quantity: '1' }], [{ sourceKey: 'b', quantity: '1' }]],
    );
    for (const credit of credits) {
      expectNoNegative(credit);
    }
    expectSum(
      credits,
      calculateDocumentTotals(documentOf(true, [source('a', '11.93'), source('b', '11.92')])),
    );
  });

  it('gives the cent to the lower position when remainders are exactly equal', () => {
    const [credit] = creditInSteps(
      true,
      [source('a', '0.27', 'RED5', '5'), source('b', '0.06', 'RED5', '5')],
      [
        [
          { sourceKey: 'a', quantity: '1' },
          { sourceKey: 'b', quantity: '1' },
        ],
      ],
    );
    expect(credit?.lines.map((line) => line.lineNet)).toEqual(['0.26', '0.05']);
  });

  it('refuses to credit more than the original line, counting two lines on the same line together', () => {
    const lines = [source('a', '10.00', 'STD19', '19', '2')];
    expect(() =>
      calculateCreditTotals({
        pricesIncludeTax: false,
        sources: lines.map((line) => ({ ...line, creditedBefore: '1.5' })),
        lines: [{ position: 1, sourceKey: 'a', quantity: '1' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'over_credit' }));
    expect(() =>
      calculateCreditTotals({
        pricesIncludeTax: false,
        sources: lines.map((line) => ({ ...line, creditedBefore: '0' })),
        lines: [
          { position: 1, sourceKey: 'a', quantity: '1.5' },
          { position: 2, sourceKey: 'a', quantity: '0.6' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'over_credit' }));
    expect(() =>
      calculateCreditTotals({
        pricesIncludeTax: false,
        sources: lines.map((line) => ({ ...line, creditedBefore: '0' })),
        lines: [{ position: 1, sourceKey: 'missing', quantity: '1' }],
      }),
    ).toThrow(expect.objectContaining({ code: 'unknown_source' }));
  });

  it('credits a discounted line in part with the original discount', () => {
    const [credit] = creditInSteps(
      false,
      [source('a', '10.00', 'STD19', '19', '2', '15')],
      [[{ sourceKey: 'a', quantity: '1' }]],
    );
    expect(credit).toMatchObject({
      subtotal: '10.00',
      discountTotal: '1.50',
      netTotal: '8.50',
      taxTotal: '1.62',
      total: '10.12',
    });
  });

  it('adds up to the invoice, never negative, however the quantities are split', () => {
    const random = seeded(20261028);
    for (let run = 0; run < 300; run += 1) {
      const inclusive = random() < 0.5;
      const codes = [
        { code: 'STD19', rate: '19' },
        { code: 'RED5', rate: '5' },
        { code: 'ZERO', rate: '0' },
      ];
      const lines = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, index) => {
        const tax = codes[Math.floor(random() * codes.length)] ?? codes[0];
        return source(
          `l${String(index)}`,
          (Math.floor(random() * 2000) / 100).toFixed(2),
          tax?.code,
          tax?.rate,
          ((1 + Math.floor(random() * 10)) / 2).toFixed(1),
          String(Math.floor(random() * 3) * 5),
        );
      });
      // Split each line's quantity (in halves) into 0.5 steps over up to four credit notes.
      const steps: { sourceKey: string; quantity: string }[][] = [[], [], [], []];
      for (const line of lines) {
        for (let half = 0; half < Number(line.quantity) * 2; half += 1) {
          steps[Math.floor(random() * steps.length)]?.push({
            sourceKey: line.key,
            quantity: '0.5',
          });
        }
      }
      const credits = creditInSteps(
        inclusive,
        lines,
        steps.filter((step) => step.length > 0),
      );
      for (const credit of credits) {
        expectNoNegative(credit);
      }
      expectSum(credits, calculateDocumentTotals(documentOf(inclusive, lines)));
    }
  });
});

function documentOf(pricesIncludeTax: boolean, lines: Omit<CreditSourceLine, 'creditedBefore'>[]) {
  return {
    pricesIncludeTax,
    lines: lines.map((line, index) => ({
      position: index + 1,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountPercent: line.discountPercent,
      taxCode: line.taxCode,
      taxRatePercent: line.taxRatePercent,
    })),
  };
}

function expectNoNegative(credit: DocumentTotals): void {
  const amounts = [
    credit.subtotal,
    credit.discountTotal,
    credit.netTotal,
    credit.taxTotal,
    credit.total,
    ...credit.lines.flatMap((line) => [
      line.lineSubtotal,
      line.lineDiscount,
      line.lineNet,
      line.lineGross,
    ]),
    ...credit.taxSummary.flatMap((group) => [group.net, group.tax, group.gross]),
  ];
  for (const amount of amounts) {
    expect(new Decimal(amount).isNegative() && !new Decimal(amount).isZero(), amount).toBe(false);
  }
}

/** The credits together equal the original: totals and every tax-code group. */
function expectSum(credits: DocumentTotals[], invoice: DocumentTotals): void {
  const add = (pick: (credit: DocumentTotals) => string) =>
    credits.reduce((total, credit) => total.plus(pick(credit)), new Decimal(0)).toFixed(2);
  for (const key of ['subtotal', 'discountTotal', 'netTotal', 'taxTotal', 'total'] as const) {
    expect(
      add((credit) => credit[key]),
      key,
    ).toBe(invoice[key]);
  }
  for (const group of invoice.taxSummary) {
    for (const key of ['net', 'tax', 'gross'] as const) {
      const credited = credits
        .flatMap((credit) => credit.taxSummary.filter((entry) => entry.taxCode === group.taxCode))
        .reduce((total, entry) => total.plus(entry[key]), new Decimal(0))
        .toFixed(2);
      expect(credited, `${group.taxCode} ${key}`).toBe(group[key]);
    }
  }
}

/** A small deterministic generator, so a failure can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
