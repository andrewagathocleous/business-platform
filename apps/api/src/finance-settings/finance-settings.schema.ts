import { isValidBic, isValidIban, normalizeBic, normalizeIban, parseAmount } from '@bp/domain';
import { z } from 'zod';

const NAME_MAX = 200;
const NOTE_MAX = 2000;

/** Null clears the field. A string that is empty after trimming the ends is rejected. */
const clearableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'id is invalid');

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/, 'code may use letters, digits, - and _ only');

export const TAX_KINDS = [
  'standard',
  'reduced',
  'zero',
  'exempt',
  'reverse_charge',
  'out_of_scope',
] as const;
export type TaxKindValue = (typeof TAX_KINDS)[number];

/** Only standard and reduced codes charge VAT; every other kind is 0 %. */
const CHARGED_KINDS = new Set<TaxKindValue>(['standard', 'reduced']);

const rateSchema = z
  .string()
  .regex(/^\d{1,3}(?:\.\d{1,4})?$/, 'ratePercent must be a decimal string with up to 4 places')
  .refine((value) => parseAmount(value, 4).lte(100), 'ratePercent must be 100 or less')
  .transform((value) => parseAmount(value, 4).toFixed(4));

export function rateMatchesKind(kind: TaxKindValue, ratePercent: string): boolean {
  const rate = parseAmount(ratePercent, 4);
  return CHARGED_KINDS.has(kind) ? rate.gt(0) : rate.isZero();
}

export const taxCodeCreateSchema = z
  .object({
    code: codeSchema,
    name: z.string().trim().min(1).max(NAME_MAX),
    ratePercent: rateSchema,
    kind: z.enum(TAX_KINDS),
    noteEn: clearableText(NOTE_MAX),
    noteEl: clearableText(NOTE_MAX),
    deadlineRule: z.enum(['days_30', 'next_month_15']).optional(),
  })
  .strict()
  .refine((body) => rateMatchesKind(body.kind, body.ratePercent), {
    message: 'ratePercent must be above 0 for standard and reduced codes, and 0 for the others',
  });

export const taxCodePatchSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    code: codeSchema.optional(),
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    ratePercent: rateSchema.optional(),
    kind: z.enum(TAX_KINDS).optional(),
    noteEn: clearableText(NOTE_MAX),
    noteEl: clearableText(NOTE_MAX),
    deadlineRule: z.enum(['days_30', 'next_month_15']).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), {
    message: 'a field is required',
  });

export const seriesCreateSchema = z
  .object({
    code: codeSchema,
    documentType: z.enum(['invoice', 'credit_note', 'quote']),
    prefix: z
      .string()
      .max(40)
      .regex(/^[^\p{Cc}]*$/u, 'prefix may not contain control characters')
      .refine((value) => value === value.trim(), 'prefix may not start or end with a space'),
    nextNumber: z.number().int().min(1).max(999_999_999).optional(),
    padding: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export const seriesPatchSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    code: codeSchema.optional(),
    prefix: seriesCreateSchema.shape.prefix.optional(),
    nextNumber: z.number().int().min(1).max(999_999_999).optional(),
    padding: z.number().int().min(1).max(12).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), {
    message: 'a field is required',
  });

const ibanSchema = z
  .string()
  .max(64)
  .transform(normalizeIban)
  .refine(isValidIban, 'iban is invalid');

const bicSchema = z
  .string()
  .max(16)
  .transform(normalizeBic)
  .refine(isValidBic, 'bic is invalid')
  .nullable();

export const bankAccountCreateSchema = z
  .object({
    bankName: z.string().trim().min(1).max(NAME_MAX),
    accountHolder: z.string().trim().min(1).max(NAME_MAX),
    iban: ibanSchema,
    bic: bicSchema.optional(),
    shownOnInvoices: z.boolean().optional(),
  })
  .strict();

export const bankAccountPatchSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    bankName: z.string().trim().min(1).max(NAME_MAX).optional(),
    accountHolder: z.string().trim().min(1).max(NAME_MAX).optional(),
    iban: ibanSchema.optional(),
    bic: bicSchema.optional(),
    shownOnInvoices: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), {
    message: 'a field is required',
  })
  .refine((body) => !(body.shownOnInvoices === true && body.active === false), {
    message: 'an inactive account cannot be shown on invoices',
  });

export const defaultSeriesSchema = uuidSchema.nullable().optional();

export type TaxCodeCreate = z.infer<typeof taxCodeCreateSchema>;
export type TaxCodePatch = z.infer<typeof taxCodePatchSchema>;
export type SeriesCreate = z.infer<typeof seriesCreateSchema>;
export type SeriesPatch = z.infer<typeof seriesPatchSchema>;
export type BankAccountCreate = z.infer<typeof bankAccountCreateSchema>;
export type BankAccountPatch = z.infer<typeof bankAccountPatchSchema>;
