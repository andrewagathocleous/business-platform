import Decimal from './decimal';

const DECIMAL_STRING = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;

export type AmountRejection = 'number' | 'type' | 'format' | 'scale' | 'non_finite';

export class AmountError extends Error {
  readonly reason: AmountRejection;

  constructor(reason: AmountRejection, message: string) {
    super(message);
    this.name = 'AmountError';
    this.reason = reason;
  }
}

/**
 * Parses a decimal string. JavaScript numbers are rejected so JSON numbers cannot
 * sneak into money fields. Prices and quantities allow at most 4 decimal places.
 */
export function parseAmount(input: unknown, maxDecimalPlaces = 4): Decimal {
  if (typeof input === 'number') {
    throw new AmountError('number', 'JSON numbers are rejected; pass a decimal string');
  }
  if (typeof input !== 'string') {
    throw new AmountError('type', 'amount must be a decimal string');
  }
  if (!Number.isInteger(maxDecimalPlaces) || maxDecimalPlaces < 0) {
    throw new AmountError('scale', 'maxDecimalPlaces must be a non-negative integer');
  }
  const match = DECIMAL_STRING.exec(input);
  if (!match) {
    throw new AmountError('format', 'amount must be a plain finite decimal string');
  }
  const fraction = match[1];
  if (fraction !== undefined && fraction.length > maxDecimalPlaces) {
    throw new AmountError(
      'scale',
      `amount has more than ${String(maxDecimalPlaces)} decimal places`,
    );
  }
  const value = new Decimal(input);
  if (!value.isFinite()) {
    throw new AmountError('non_finite', 'amount must be finite');
  }
  return value;
}

export function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function money(value: Decimal): string {
  return value.toFixed(2);
}
