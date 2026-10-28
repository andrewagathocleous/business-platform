import {
  calculateCreditTotals,
  DocumentValidationError,
  type CreditLineRequest,
  type DocumentTotals,
} from '@bp/domain';
import { CommerceError } from '../commerce/errors';
import { fixed } from '../commerce/format';

/** A line of the issued invoice a credit note credits. */
export type OriginalLine = {
  id: string;
  position: number;
  kind: 'item' | 'shipping';
  productId: string | null;
  description: string;
  quantity: { toFixed(digits: number): string };
  unit: string;
  unitPrice: { toFixed(digits: number): string };
  discountPercent: { toFixed(digits: number): string };
  taxCodeId: string;
  taxRatePercent: { toFixed(digits: number): string };
};

export type Original = {
  id: string;
  clientId: string;
  currency: string;
  language: string;
  pricesIncludeTax: boolean;
  lines: OriginalLine[];
};

/**
 * A credit note's amounts (docs/plan/release-2.md, R2-D): cumulative differences against what
 * issued credit notes have already credited, at the original's prices, discounts and rates.
 * Over-crediting a line is 409 over_credit; other refusals are 422.
 */
export function creditTotals(
  original: Original,
  before: ReadonlyMap<string, string>,
  requests: CreditLineRequest[],
  audit: { action: string; objectId: string },
): DocumentTotals {
  try {
    return calculateCreditTotals({
      pricesIncludeTax: original.pricesIncludeTax,
      // Grouped by tax code id: the original's groups, even if a code was renamed since.
      sources: original.lines.map((line) => ({
        key: line.id,
        quantity: fixed(line.quantity, 4),
        unitPrice: fixed(line.unitPrice, 4),
        discountPercent: fixed(line.discountPercent, 2),
        taxCode: line.taxCodeId,
        taxRatePercent: fixed(line.taxRatePercent, 4),
        creditedBefore: before.get(line.id) ?? '0',
      })),
      lines: requests,
    });
  } catch (error) {
    if (error instanceof DocumentValidationError) {
      if (error.code === 'over_credit') {
        throw new CommerceError(
          409,
          'over_credit',
          'invoice',
          audit.objectId,
          error.message,
          audit.action,
        );
      }
      throw new CommerceError(
        422,
        error.code,
        'invoice',
        audit.objectId,
        error.message,
        audit.action,
      );
    }
    throw error;
  }
}
