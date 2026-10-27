import { z } from 'zod';

/** Decimal strings only. JSON numbers fail this schema. */
export const decimalString = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);

export const documentLineSchema = z.strictObject({
  position: z.number().int().positive(),
  quantity: decimalString,
  unitPrice: decimalString,
  discountPercent: decimalString,
  taxCode: z.string().min(1),
  taxRatePercent: decimalString,
});

export const documentTotalsSchema = z.strictObject({
  pricesIncludeTax: z.boolean(),
  lines: z.array(documentLineSchema).min(1),
});

export type DocumentLineDto = z.infer<typeof documentLineSchema>;
export type DocumentTotalsDto = z.infer<typeof documentTotalsSchema>;
