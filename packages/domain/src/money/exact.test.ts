import { describe, expect, it } from 'vitest';
import Decimal from './decimal';
import { allocateInclusiveNets, inclusiveNet } from './exact';

const d = (value: string) => new Decimal(value);

describe('inclusiveNet', () => {
  it('rounds half a cent up and keeps whole cents', () => {
    expect(inclusiveNet(d('0.04'), d('60')).toFixed(2)).toBe('0.03');
    expect(inclusiveNet(d('0.08'), d('60')).toFixed(2)).toBe('0.05');
    expect(inclusiveNet(d('11.90'), d('19')).toFixed(2)).toBe('10.00');
    expect(inclusiveNet(d('2.97'), d('19')).toFixed(2)).toBe('2.50');
    expect(inclusiveNet(d('0'), d('19')).toFixed(2)).toBe('0.00');
    expect(inclusiveNet(d('10.00'), d('-0.0000')).toFixed(2)).toBe('10.00');
    expect(inclusiveNet(d('-0'), d('19')).toFixed(2)).toBe('0.00');
  });

  it('agrees with plain half-up rounding on a range of grosses and rates', () => {
    for (const rate of ['0', '3', '5', '9', '19', '7.5', '0.0001']) {
      for (let cents = 0; cents <= 2000; cents += 7) {
        const gross = new Decimal(cents).div(100);
        const expected = gross
          .mul(100)
          .div(d(rate).plus(100))
          .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        expect(inclusiveNet(gross, d(rate)).toFixed(2), `${gross.toFixed(2)} at ${rate}`).toBe(
          expected.toFixed(2),
        );
      }
    }
  });

  it('refuses amounts it cannot scale to whole numbers', () => {
    expect(() => inclusiveNet(d('0.000000001'), d('19'))).toThrow();
    expect(() => inclusiveNet(d('1.00'), d('19.00001'))).toThrow();
  });
});

describe('allocateInclusiveNets', () => {
  it('breaks exact ties by position and adds up to the group net', () => {
    const nets = allocateInclusiveNets(
      [
        { position: 2, gross: d('0.06') },
        { position: 1, gross: d('0.27') },
      ],
      d('5'),
      d('0.31'),
    );
    expect(nets && [...nets].sort(([a], [b]) => a - b).map(([, net]) => net.toFixed(2))).toEqual([
      '0.26',
      '0.05',
    ]);
  });

  it('reports a group net the lines cannot reach', () => {
    expect(
      allocateInclusiveNets([{ position: 1, gross: d('1.00') }], d('19'), d('0.10')),
    ).toBeNull();
  });
});
