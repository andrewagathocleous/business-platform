import Decimal from './decimal';
import { AmountError, money, parseAmount, round2 } from './parse';

const MAX_QUANTITY = new Decimal('1000000');
const MAX_UNIT_PRICE = new Decimal('10000000');
const HUNDRED = new Decimal(100);
const ZERO = new Decimal(0);
const ONE_CENT = new Decimal('0.01');

export class DocumentValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DocumentValidationError';
    this.code = code;
  }
}

export type DocumentLineInput = {
  position: number;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxCode: string;
  taxRatePercent: string;
};

export type DocumentTotalsInput = {
  pricesIncludeTax: boolean;
  lines: readonly DocumentLineInput[];
};

export type DocumentLineTotals = {
  position: number;
  taxCode: string;
  taxRatePercent: string;
  lineSubtotal: string;
  lineDiscount: string;
  lineNet: string;
  lineGross: string;
};

export type TaxGroupTotals = {
  taxCode: string;
  taxRatePercent: string;
  net: string;
  tax: string;
  gross: string;
};

export type DocumentTotals = {
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
  lines: DocumentLineTotals[];
  taxSummary: TaxGroupTotals[];
};

type ParsedLine = {
  position: number;
  taxCode: string;
  rate: Decimal;
  taxRatePercent: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  lineSubtotal: Decimal;
  lineDiscount: Decimal;
  lineNet: Decimal;
  lineGross: Decimal;
};

type Group = {
  taxCode: string;
  rate: Decimal;
  taxRatePercent: string;
  lines: ParsedLine[];
};

/**
 * Invoice and quote totals from docs/finance/rounding.md.
 * Tax-exclusive mode rounds tax once per tax code. Tax-inclusive mode allocates
 * each group's net across its lines with the largest-remainder method.
 * In exclusive mode, per-line tax is not defined, so lineGross equals lineNet
 * and the tax lives only on the tax summary.
 */
export function calculateDocumentTotals(input: DocumentTotalsInput): DocumentTotals {
  if (input.lines.length === 0) {
    throw new DocumentValidationError('empty_lines', 'a document needs at least one line');
  }
  const parsed = input.lines.map((line) => parseLine(line));
  assertUniquePositions(parsed);
  const groups = groupByTaxCode(parsed);

  if (!input.pricesIncludeTax) {
    return exclusiveTotals(parsed, groups);
  }
  return inclusiveTotals(parsed, groups);
}

function parseLine(line: DocumentLineInput): ParsedLine {
  if (!Number.isInteger(line.position) || line.position < 1) {
    throw new DocumentValidationError('invalid_position', 'line position must be a positive integer');
  }
  if (line.taxCode.trim() === '') {
    throw new DocumentValidationError('tax_code_required', 'every line has a tax code');
  }
  const quantity = parseField(line.quantity, 4, 'quantity_scale', 'invalid_quantity');
  const unitPrice = parseField(line.unitPrice, 4, 'unit_price_scale', 'invalid_unit_price');
  const discountPercent = parseField(line.discountPercent, 2, 'discount_scale', 'invalid_discount');
  const rate = parseField(line.taxRatePercent, 4, 'tax_rate_scale', 'invalid_tax_rate');

  if (quantity.lte(0)) {
    throw new DocumentValidationError('quantity_not_positive', 'quantity must be greater than 0');
  }
  if (quantity.gt(MAX_QUANTITY)) {
    throw new DocumentValidationError('quantity_too_large', 'quantity must be at most 1000000');
  }
  if (unitPrice.lt(0)) {
    throw new DocumentValidationError('unit_price_negative', 'unit price must be at least 0');
  }
  if (unitPrice.gt(MAX_UNIT_PRICE)) {
    throw new DocumentValidationError('unit_price_too_large', 'unit price must be at most 10000000');
  }
  if (discountPercent.lt(0) || discountPercent.gt(HUNDRED)) {
    throw new DocumentValidationError('discount_out_of_range', 'discount percent must be from 0 to 100');
  }
  if (rate.lt(0)) {
    throw new DocumentValidationError('tax_rate_negative', 'tax rate must be at least 0');
  }

  const lineSubtotal = round2(quantity.mul(unitPrice));
  const lineDiscount = round2(lineSubtotal.mul(discountPercent).div(HUNDRED));
  return {
    position: line.position,
    taxCode: line.taxCode,
    rate,
    taxRatePercent: rate.toString(),
    quantity,
    unitPrice,
    discountPercent,
    lineSubtotal,
    lineDiscount,
    lineNet: ZERO,
    lineGross: ZERO,
  };
}

function parseField(
  input: unknown,
  scale: number,
  scaleCode: string,
  invalidCode: string,
): Decimal {
  try {
    return parseAmount(input, scale);
  } catch (error) {
    if (error instanceof AmountError) {
      throw new DocumentValidationError(
        error.reason === 'scale' ? scaleCode : invalidCode,
        error.message,
      );
    }
    throw error;
  }
}

function assertUniquePositions(lines: readonly ParsedLine[]): void {
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.position)) {
      throw new DocumentValidationError('duplicate_position', `duplicate line position ${String(line.position)}`);
    }
    seen.add(line.position);
  }
}

function groupByTaxCode(lines: readonly ParsedLine[]): Group[] {
  const groups = new Map<string, Group>();
  for (const line of lines) {
    const existing = groups.get(line.taxCode);
    if (!existing) {
      groups.set(line.taxCode, {
        taxCode: line.taxCode,
        rate: line.rate,
        taxRatePercent: line.taxRatePercent,
        lines: [line],
      });
      continue;
    }
    if (!existing.rate.eq(line.rate)) {
      throw new DocumentValidationError(
        'tax_rate_mismatch',
        `tax code ${line.taxCode} is used with two rates`,
      );
    }
    existing.lines.push(line);
  }
  return [...groups.values()].sort((a, b) => a.taxCode.localeCompare(b.taxCode));
}

function exclusiveTotals(lines: readonly ParsedLine[], groups: readonly Group[]): DocumentTotals {
  for (const line of lines) {
    line.lineNet = line.lineSubtotal.minus(line.lineDiscount);
    // Tax is rounded per group, not per line, so the line has no tax-inclusive gross.
    line.lineGross = line.lineNet;
  }
  const taxSummary = groups.map((group) => {
    const net = sum(group.lines, (line) => line.lineNet);
    const tax = round2(net.mul(group.rate).div(HUNDRED));
    return {
      taxCode: group.taxCode,
      taxRatePercent: group.taxRatePercent,
      net,
      tax,
      gross: net.plus(tax),
    };
  });
  const subtotal = sum(lines, (line) => line.lineSubtotal);
  const discountTotal = sum(lines, (line) => line.lineDiscount);
  const netTotal = sum(lines, (line) => line.lineNet);
  const taxTotal = taxSummary.reduce((total, group) => total.plus(group.tax), ZERO);
  return {
    subtotal: money(subtotal),
    discountTotal: money(discountTotal),
    netTotal: money(netTotal),
    taxTotal: money(taxTotal),
    total: money(netTotal.plus(taxTotal)),
    lines: toLineTotals(lines),
    taxSummary: taxSummary.map(toGroupTotals),
  };
}

function inclusiveTotals(lines: readonly ParsedLine[], groups: readonly Group[]): DocumentTotals {
  for (const line of lines) {
    line.lineGross = line.lineSubtotal.minus(line.lineDiscount);
  }
  const taxSummary = groups.map((group) => {
    const gross = sum(group.lines, (line) => line.lineGross);
    const net = round2(gross.mul(HUNDRED).div(group.rate.plus(HUNDRED)));
    allocateNets(group.lines, group.rate, net);
    return {
      taxCode: group.taxCode,
      taxRatePercent: group.taxRatePercent,
      net,
      tax: gross.minus(net),
      gross,
    };
  });
  const subtotal = sum(lines, (line) => line.lineSubtotal);
  const discountTotal = sum(lines, (line) => line.lineDiscount);
  const total = taxSummary.reduce((sumTotal, group) => sumTotal.plus(group.gross), ZERO);
  const taxTotal = taxSummary.reduce((sumTax, group) => sumTax.plus(group.tax), ZERO);
  return {
    subtotal: money(subtotal),
    discountTotal: money(discountTotal),
    netTotal: money(total.minus(taxTotal)),
    taxTotal: money(taxTotal),
    total: money(total),
    lines: toLineTotals(lines),
    taxSummary: taxSummary.map(toGroupTotals),
  };
}

/**
 * Largest-remainder allocation so the stored line nets add up to groupNet.
 * Ties go to the lower line position.
 */
function allocateNets(lines: readonly ParsedLine[], rate: Decimal, groupNet: Decimal): void {
  const parts = lines.map((line) => {
    const raw = line.lineGross.mul(HUNDRED).div(rate.plus(HUNDRED));
    const truncated = raw.toDecimalPlaces(2, Decimal.ROUND_DOWN);
    return { line, truncated, remainder: raw.minus(truncated) };
  });
  const truncatedSum = parts.reduce((total, part) => total.plus(part.truncated), ZERO);
  let centsLeft = groupNet.minus(truncatedSum).div(ONE_CENT);
  if (!centsLeft.isInteger() || centsLeft.lt(0)) {
    throw new DocumentValidationError(
      'allocation_failed',
      'inclusive net allocation did not produce a whole number of cents',
    );
  }
  const ordered = [...parts].sort((a, b) => {
    const byRemainder = b.remainder.cmp(a.remainder);
    if (byRemainder !== 0) {
      return byRemainder;
    }
    return a.line.position - b.line.position;
  });
  const extraCents = new Map<number, Decimal>();
  let index = 0;
  while (centsLeft.gt(0)) {
    const target = ordered[index % ordered.length];
    if (!target) {
      throw new DocumentValidationError('allocation_failed', 'no lines to allocate');
    }
    const current = extraCents.get(target.line.position) ?? ZERO;
    extraCents.set(target.line.position, current.plus(1));
    centsLeft = centsLeft.minus(1);
    index += 1;
  }
  for (const part of parts) {
    const cents = extraCents.get(part.line.position) ?? ZERO;
    part.line.lineNet = part.truncated.plus(cents.mul(ONE_CENT));
  }
}

function sum(lines: readonly ParsedLine[], pick: (line: ParsedLine) => Decimal): Decimal {
  return lines.reduce((total, line) => total.plus(pick(line)), ZERO);
}

function toLineTotals(lines: readonly ParsedLine[]): DocumentLineTotals[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((line) => ({
      position: line.position,
      taxCode: line.taxCode,
      taxRatePercent: line.taxRatePercent,
      lineSubtotal: money(line.lineSubtotal),
      lineDiscount: money(line.lineDiscount),
      lineNet: money(line.lineNet),
      lineGross: money(line.lineGross),
    }));
}

function toGroupTotals(group: {
  taxCode: string;
  taxRatePercent: string;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
}): TaxGroupTotals {
  return {
    taxCode: group.taxCode,
    taxRatePercent: group.taxRatePercent,
    net: money(group.net),
    tax: money(group.tax),
    gross: money(group.gross),
  };
}
