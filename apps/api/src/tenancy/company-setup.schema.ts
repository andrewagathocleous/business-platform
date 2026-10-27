import { currencyMinorDigits, isIanaTimeZone, isKnownCurrency } from '@bp/domain';
import { z } from 'zod';

const NAME_MAX = 200;

export const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(NAME_MAX),
    line2: z.string().trim().min(1).max(NAME_MAX).optional(),
    city: z.string().trim().min(1).max(100),
    postcode: z.string().trim().min(1).max(32).optional(),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, 'countryCode is invalid'),
  })
  .strict();

/** Null clears the field. A string that is empty after trimming the ends is rejected. */
const clearableText = (max: number) => z.string().trim().min(1).max(max).nullable().optional();

const timezoneSchema = z.string().max(64).refine(isIanaTimeZone, 'timezone is invalid');

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'defaultCurrency is invalid')
  .refine(isKnownCurrency, 'defaultCurrency is invalid')
  .refine((code) => currencyMinorDigits(code) === 2, 'defaultCurrency must have two minor digits');

const companyPatchKeys = [
  'legalName',
  'tradingName',
  'registrationNumber',
  'vatNumber',
  'taxOffice',
  'address',
  'timezone',
  'defaultCurrency',
  'defaultLocale',
  'documentLanguage',
  'paymentTermsDays',
] as const;

export const companyPatchSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    legalName: z.string().trim().min(1).max(NAME_MAX).optional(),
    tradingName: z.string().trim().min(1).max(NAME_MAX).optional(),
    registrationNumber: clearableText(64),
    vatNumber: clearableText(32),
    taxOffice: clearableText(120),
    address: addressSchema.optional(),
    timezone: timezoneSchema.optional(),
    defaultCurrency: currencySchema.optional(),
    defaultLocale: z.enum(['en', 'el']).optional(),
    documentLanguage: z.enum(['en', 'el']).optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
  })
  .strict()
  .refine((body) => companyPatchKeys.some((key) => body[key] !== undefined), {
    message: 'a field is required',
  });

export const brandCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
  })
  .strict();

export const brandPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.archived !== undefined, {
    message: 'a field is required',
  });

export const locationCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    address: addressSchema,
    timezone: timezoneSchema.optional(),
  })
  .strict();

export const locationPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    address: addressSchema.optional(),
    timezone: timezoneSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.address !== undefined ||
      body.timezone !== undefined ||
      body.archived !== undefined,
    { message: 'a field is required' },
  );

const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(isBareHostname, 'domain is invalid')
  .nullable();

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'id is invalid');

export const storeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    platform: z.enum(['prestashop', 'shopify', 'manual']),
    brandId: uuidSchema,
    locationId: uuidSchema,
    domain: domainSchema.optional(),
    invoiceAuthority: z.enum(['undecided', 'store', 'platform']).optional(),
  })
  .strict();

export const storePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    brandId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    domain: domainSchema.optional(),
    invoiceAuthority: z.enum(['undecided', 'store', 'platform']).optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.name !== undefined ||
      body.brandId !== undefined ||
      body.locationId !== undefined ||
      body.domain !== undefined ||
      body.invoiceAuthority !== undefined ||
      body.archived !== undefined,
    { message: 'a field is required' },
  );

export type CompanyPatch = z.infer<typeof companyPatchSchema>;
export type BrandCreate = z.infer<typeof brandCreateSchema>;
export type BrandPatch = z.infer<typeof brandPatchSchema>;
export type LocationCreate = z.infer<typeof locationCreateSchema>;
export type LocationPatch = z.infer<typeof locationPatchSchema>;
export type StoreCreate = z.infer<typeof storeCreateSchema>;
export type StorePatch = z.infer<typeof storePatchSchema>;

/** A DNS hostname, with no scheme, userinfo, port, path or query. */
function isBareHostname(value: string): boolean {
  if (value !== value.trim() || value.includes('://') || /[\s/?#@:[\]]/.test(value)) {
    return false;
  }
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    value,
  );
}
