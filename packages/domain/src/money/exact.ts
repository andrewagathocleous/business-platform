import Decimal from './decimal';

const HUNDRED = new Decimal(100);
const TEN_THOUSAND = new Decimal(10000);
const ONE_CENT = new Decimal('0.01');

/**
 * The net of a tax-inclusive gross, round2(gross × 100 / (100 + rate)) half-up, worked out in
 * whole numbers so no division is rounded on the way. Decimal division keeps 40 significant
 * digits, which can tip a value sitting exactly on a half cent, or make equal remainders unequal.
 */
export function inclusiveNet(gross: Decimal, rate: Decimal): Decimal {
  const { cents, numerator, denominator } = netCents(gross, rate);
  return numerator.mul(2).gte(denominator) ? cents.plus(1).mul(ONE_CENT) : cents.mul(ONE_CENT);
}

/**
 * Splits a tax-inclusive group's net over its lines by the largest-remainder method
 * (docs/finance/rounding.md): each line's net truncated to cents, then the cents left over to the
 * largest remainders, ties to the lower position. Remainders are compared exactly: within one
 * group they share the denominator (100 + rate), so their numerators decide.
 */
export function allocateInclusiveNets(
  lines: readonly { position: number; gross: Decimal }[],
  rate: Decimal,
  groupNet: Decimal,
): Map<number, Decimal> | null {
  const parts = lines.map((line) => {
    const { cents, numerator } = netCents(line.gross, rate);
    return { position: line.position, cents, numerator };
  });
  const truncated = parts.reduce((total, part) => total.plus(part.cents), new Decimal(0));
  let left = groupNet.div(ONE_CENT).minus(truncated);
  if (!left.isInteger() || left.lt(0)) {
    return null;
  }
  const order = [...parts].sort((a, b) => {
    const byRemainder = b.numerator.cmp(a.numerator);
    return byRemainder !== 0 ? byRemainder : a.position - b.position;
  });
  const nets = new Map(parts.map((part) => [part.position, part.cents]));
  let index = 0;
  while (left.gt(0)) {
    const target = order[index % order.length];
    if (!target) {
      return null;
    }
    nets.set(target.position, (nets.get(target.position) ?? new Decimal(0)).plus(1));
    left = left.minus(1);
    index += 1;
  }
  return new Map([...nets].map(([position, cents]) => [position, cents.mul(ONE_CENT)]));
}

/**
 * gross × 100 / (100 + rate) in cents, as whole cents plus the exact remainder
 * `numerator / denominator` of a cent. Scaling by 10^8 and 10^4 makes a gross of up to 8
 * decimals (money has 2) and a rate of up to 4 whole numbers, so divToInt is exact.
 */
function netCents(
  gross: Decimal,
  rate: Decimal,
): { cents: Decimal; numerator: Decimal; denominator: Decimal } {
  // lt(0), not isNegative(): "-0.0000" is a valid zero rate.
  if (gross.lt(0) || rate.lt(0)) {
    throw new Error('gross and rate must not be negative');
  }
  const scaledGross = gross.mul(HUNDRED).mul(HUNDRED).mul(TEN_THOUSAND);
  const denominator = rate.plus(HUNDRED).mul(TEN_THOUSAND);
  if (!scaledGross.isInteger() || !denominator.isInteger()) {
    throw new Error('gross needs at most 8 decimals and the rate at most 4');
  }
  const cents = scaledGross.divToInt(denominator);
  return { cents, numerator: scaledGross.minus(cents.mul(denominator)), denominator };
}
