import Decimal from '../money/decimal';
import { addDaysToBusinessDate } from '../time/business-date';

/** A tax code's delivery deadline (Cyprus VAT reg. 11(5) and 11(6)). */
export type DeliveryDeadlineRule = 'days_30' | 'next_month_15';

/**
 * The date an issued document must reach the customer by, from its supply date and the
 * deadline rules of the tax codes on its lines. The strictest (earliest) rule wins.
 */
export function deliveryDeadline(
  supplyDate: string,
  rules: readonly DeliveryDeadlineRule[],
): string {
  if (rules.length === 0) {
    throw new Error('a delivery deadline needs at least one rule');
  }
  const dates = [...new Set(rules)].map((rule) =>
    rule === 'days_30' ? addDaysToBusinessDate(supplyDate, 30) : fifteenthOfNextMonth(supplyDate),
  );
  return dates.reduce((earliest, date) => (date < earliest ? date : earliest));
}

function fifteenthOfNextMonth(businessDate: string): string {
  // Adding zero days validates the date and normalises it to YYYY-MM-DD.
  const date = addDaysToBusinessDate(businessDate, 0);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-15`;
}

/**
 * The VAT-exclusive unit price printed on a tax-inclusive document:
 * unit price × 100 / (100 + rate), half-up to 4 decimals. It is printed only.
 * The line net from the totals engine stays the amount that counts.
 */
export function vatExclusiveUnitPrice(unitPrice: string, ratePercent: string): string {
  const price = new Decimal(unitPrice);
  const rate = new Decimal(ratePercent);
  if (!price.isFinite() || !rate.isFinite() || rate.isNegative()) {
    throw new Error('unit price and rate must be finite, and the rate not negative');
  }
  return price.mul(100).div(rate.plus(100)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

/** A 4-decimal unit amount for printing, with at least 2 decimals: 10.0000 prints 10.00. */
export function printedUnitAmount(value: string): string {
  return new Decimal(value).toFixed(4).replace(/(\.\d\d\d*?)0+$/, '$1');
}
