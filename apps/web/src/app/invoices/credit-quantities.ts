import { decimalInput } from './decimal-input';

/** The API keeps quantities to 4 decimals. Worked out exactly, never through `Number`. */
const SCALE = 10_000n;
const QUANTITY = /^\d+(\.\d{1,4})?$/;

/** A typed quantity in ten-thousandths, or null when it is not a quantity the API takes. */
export function quantityUnits(raw: string): bigint | null {
  const value = decimalInput(raw);
  if (!QUANTITY.test(value)) {
    return null;
  }
  const [whole = '0', part = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(part.padEnd(4, '0'));
}

/** What is left to credit on a line: its quantity less what issued credit notes credited. */
export function remainingUnits(quantity: string, credited: string): bigint {
  const left = (quantityUnits(quantity) ?? 0n) - (quantityUnits(credited) ?? 0n);
  return left > 0n ? left : 0n;
}

/** 20000 reads "2" and 15000 reads "1.5". */
export function quantityText(units: bigint): string {
  const whole = units / SCALE;
  const part = (units % SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return part.length > 0 ? `${whole.toString()}.${part}` : whole.toString();
}
