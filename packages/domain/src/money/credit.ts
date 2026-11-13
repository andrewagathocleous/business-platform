import Decimal from './decimal';
import { allocateInclusiveNets, inclusiveNet } from './exact';
import { AmountError, money, parseAmount, round2 } from './parse';
import {
  DocumentValidationError,
  type DocumentLineTotals,
  type DocumentTotals,
  type TaxGroupTotals,
} from './totals';

const HUNDRED = new Decimal(100);
const ZERO = new Decimal(0);

/** A line of the original invoice, with what issued credit notes have already credited. */
export type CreditSourceLine = {
  /** The original line's id. */
  key: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxCode: string;
  taxRatePercent: string;
  /** Quantity on issued credit notes so far. */
  creditedBefore: string;
};

export type CreditLineRequest = {
  /** The credit note's own line position. */
  position: number;
  sourceKey: string;
  quantity: string;
};

export type CreditTotalsInput = {
  pricesIncludeTax: boolean;
  sources: readonly CreditSourceLine[];
  lines: readonly CreditLineRequest[];
};

type Source = {
  key: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discountPercent: Decimal;
  taxCode: string;
  rate: Decimal;
  taxRatePercent: string;
  before: Decimal;
  /** Before plus every quantity this credit note takes from the line. */
  after: Decimal;
};

type CreditLine = {
  position: number;
  source: Source;
  quantity: Decimal;
  lineSubtotal: Decimal;
  lineDiscount: Decimal;
  lineNet: Decimal;
  lineGross: Decimal;
};

/**
 * A credit note's amounts as cumulative differences (docs/plan/release-2.md, R2-D): each
 * amount is what the original's lines show at the quantity credited after this note, minus
 * what they show at the quantity credited before it. Tax is rounded per tax-code group, as on
 * invoices, so all the credit notes of an invoice add up to what one document with the total
 * credited quantity would show, and a full credit equals the original exactly. No amount is
 * ever negative.
 */
export function calculateCreditTotals(input: CreditTotalsInput): DocumentTotals {
  if (input.lines.length === 0) {
    throw new DocumentValidationError('empty_lines', 'a credit note needs at least one line');
  }
  const sources = new Map<string, Source>();
  for (const line of input.sources) {
    if (sources.has(line.key)) {
      throw new DocumentValidationError(
        'duplicate_source',
        `source line ${line.key} is listed twice`,
      );
    }
    sources.set(line.key, parseSource(line));
  }
  const ordered = [...input.lines].sort((left, right) => left.position - right.position);
  const positions = new Set<number>();
  const lines: CreditLine[] = [];
  for (const request of ordered) {
    if (!Number.isInteger(request.position) || request.position < 1) {
      throw new DocumentValidationError(
        'invalid_position',
        'line position must be a positive integer',
      );
    }
    if (positions.has(request.position)) {
      throw new DocumentValidationError(
        'duplicate_position',
        `duplicate line position ${String(request.position)}`,
      );
    }
    positions.add(request.position);
    const source = sources.get(request.sourceKey);
    if (!source) {
      throw new DocumentValidationError('unknown_source', `no original line ${request.sourceKey}`);
    }
    const quantity = parseField(request.quantity, 4, 'quantity_scale', 'invalid_quantity');
    if (quantity.lte(0)) {
      throw new DocumentValidationError('quantity_not_positive', 'quantity must be greater than 0');
    }
    // Two lines of one credit note on the same original line count together, in position order.
    const previous = source.after;
    const next = previous.plus(quantity);
    if (next.gt(source.quantity)) {
      throw new DocumentValidationError(
        'over_credit',
        `line ${request.sourceKey} would be credited ${next.toString()} of ${source.quantity.toString()}`,
      );
    }
    source.after = next;
    const lineSubtotal = subtotalAt(source, next).minus(subtotalAt(source, previous));
    const lineDiscount = discountAt(source, next).minus(discountAt(source, previous));
    const amount = lineSubtotal.minus(lineDiscount);
    lines.push({
      position: request.position,
      source,
      quantity,
      lineSubtotal,
      lineDiscount,
      lineNet: amount,
      lineGross: amount,
    });
  }

  const groups = groupSources([...sources.values()]);
  const summary: {
    taxCode: string;
    taxRatePercent: string;
    net: Decimal;
    tax: Decimal;
    gross: Decimal;
  }[] = [];
  for (const group of groups) {
    const own = lines.filter((line) => line.source.taxCode === group.taxCode);
    if (own.length === 0) {
      continue;
    }
    const amountBefore = sumAt(group.sources, (source) => source.before);
    const amountAfter = sumAt(group.sources, (source) => source.after);
    const amount = own.reduce((total, line) => total.plus(line.lineGross), ZERO);
    if (input.pricesIncludeTax) {
      // amount is gross. Tax as the group would show it, after minus before.
      const tax = inclusiveTax(amountAfter, group.rate).minus(
        inclusiveTax(amountBefore, group.rate),
      );
      const net = amount.minus(tax);
      allocateNets(own, group.rate, net);
      summary.push({
        taxCode: group.taxCode,
        taxRatePercent: group.taxRatePercent,
        net,
        tax,
        gross: amount,
      });
    } else {
      // amount is net; per-line tax is not defined, as on invoices.
      const tax = exclusiveTax(amountAfter, group.rate).minus(
        exclusiveTax(amountBefore, group.rate),
      );
      summary.push({
        taxCode: group.taxCode,
        taxRatePercent: group.taxRatePercent,
        net: amount,
        tax,
        gross: amount.plus(tax),
      });
    }
  }

  const subtotal = lines.reduce((total, line) => total.plus(line.lineSubtotal), ZERO);
  const discountTotal = lines.reduce((total, line) => total.plus(line.lineDiscount), ZERO);
  const taxTotal = summary.reduce((total, group) => total.plus(group.tax), ZERO);
  const grossTotal = summary.reduce((total, group) => total.plus(group.gross), ZERO);
  const netTotal = summary.reduce((total, group) => total.plus(group.net), ZERO);
  return {
    subtotal: money(subtotal),
    discountTotal: money(discountTotal),
    netTotal: money(netTotal),
    taxTotal: money(taxTotal),
    total: money(grossTotal),
    lines: lines.map(toLineTotals),
    taxSummary: summary.map(toGroupTotals),
  };
}

function parseSource(line: CreditSourceLine): Source {
  const quantity = parseField(line.quantity, 4, 'quantity_scale', 'invalid_quantity');
  const unitPrice = parseField(line.unitPrice, 4, 'unit_price_scale', 'invalid_unit_price');
  const discountPercent = parseField(line.discountPercent, 2, 'discount_scale', 'invalid_discount');
  const rate = parseField(line.taxRatePercent, 4, 'tax_rate_scale', 'invalid_tax_rate');
  const before = parseField(line.creditedBefore, 4, 'quantity_scale', 'invalid_quantity');
  if (quantity.lte(0) || unitPrice.lt(0) || rate.lt(0)) {
    throw new DocumentValidationError('invalid_source', `original line ${line.key} is not valid`);
  }
  if (discountPercent.lt(0) || discountPercent.gt(HUNDRED)) {
    throw new DocumentValidationError(
      'discount_out_of_range',
      'discount percent must be from 0 to 100',
    );
  }
  if (before.lt(0) || before.gt(quantity)) {
    throw new DocumentValidationError(
      'over_credit',
      `line ${line.key} was already credited beyond its quantity`,
    );
  }
  return {
    key: line.key,
    quantity,
    unitPrice,
    discountPercent,
    taxCode: line.taxCode,
    rate,
    taxRatePercent: rate.toString(),
    before,
    after: before,
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

/** The original line's subtotal at a quantity: round2(quantity × unit price). */
function subtotalAt(source: Source, quantity: Decimal): Decimal {
  return round2(quantity.mul(source.unitPrice));
}

function discountAt(source: Source, quantity: Decimal): Decimal {
  return round2(subtotalAt(source, quantity).mul(source.discountPercent).div(HUNDRED));
}

/** The line's total at a quantity: gross with tax-inclusive prices, net otherwise. */
function amountAt(source: Source, quantity: Decimal): Decimal {
  return subtotalAt(source, quantity).minus(discountAt(source, quantity));
}

function sumAt(sources: readonly Source[], quantity: (source: Source) => Decimal): Decimal {
  return sources.reduce((total, source) => total.plus(amountAt(source, quantity(source))), ZERO);
}

function exclusiveTax(net: Decimal, rate: Decimal): Decimal {
  return round2(net.mul(rate).div(HUNDRED));
}

function inclusiveTax(gross: Decimal, rate: Decimal): Decimal {
  return gross.minus(inclusiveNet(gross, rate));
}

function groupSources(
  sources: readonly Source[],
): { taxCode: string; rate: Decimal; taxRatePercent: string; sources: Source[] }[] {
  const groups = new Map<
    string,
    { taxCode: string; rate: Decimal; taxRatePercent: string; sources: Source[] }
  >();
  for (const source of sources) {
    const existing = groups.get(source.taxCode);
    if (!existing) {
      groups.set(source.taxCode, {
        taxCode: source.taxCode,
        rate: source.rate,
        taxRatePercent: source.taxRatePercent,
        sources: [source],
      });
      continue;
    }
    if (!existing.rate.eq(source.rate)) {
      throw new DocumentValidationError(
        'tax_rate_mismatch',
        `tax code ${source.taxCode} is used with two rates`,
      );
    }
    existing.sources.push(source);
  }
  return [...groups.values()].sort((left, right) => left.taxCode.localeCompare(right.taxCode));
}

/**
 * The credit's group net over the credit's own lines, largest remainder first, ties to the
 * lower position (the invoice rule, compared exactly). Never spread over lines this credit note
 * does not have.
 */
function allocateNets(lines: readonly CreditLine[], rate: Decimal, groupNet: Decimal): void {
  const nets = allocateInclusiveNets(
    lines.map((line) => ({ position: line.position, gross: line.lineGross })),
    rate,
    groupNet,
  );
  if (!nets) {
    throw new DocumentValidationError(
      'allocation_failed',
      'credit net allocation did not produce a whole number of cents',
    );
  }
  for (const line of lines) {
    line.lineNet = nets.get(line.position) ?? ZERO;
  }
}

function toLineTotals(line: CreditLine): DocumentLineTotals {
  return {
    position: line.position,
    taxCode: line.source.taxCode,
    taxRatePercent: line.source.taxRatePercent,
    lineSubtotal: money(line.lineSubtotal),
    lineDiscount: money(line.lineDiscount),
    lineNet: money(line.lineNet),
    lineGross: money(line.lineGross),
  };
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
