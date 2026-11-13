import { z } from 'zod';

const contactSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string().min(1).max(300),
  email: z.string().min(1).max(320).nullable().optional(),
  phone: z.string().min(1).max(80).nullable().optional(),
  position: z.string().min(1).max(160).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const addressSchema = z.strictObject({
  id: z.string().optional(),
  kind: z.enum(['billing', 'shipping']),
  label: z.string().min(1).max(160).nullable().optional(),
  line1: z.string().min(1).max(300),
  line2: z.string().min(1).max(300).nullable().optional(),
  city: z.string().min(1).max(160),
  region: z.string().min(1).max(160).nullable().optional(),
  postalCode: z.string().min(1).max(40).nullable().optional(),
  countryCode: z.string().regex(/^[A-Za-z]{2}$/),
  isDefault: z.boolean().optional(),
});

export const clientFields = {
  kind: z.enum(['organisation', 'individual']),
  displayName: z.string().min(1).max(500),
  legalName: z.string().min(1).max(500).nullable().optional(),
  vatNumber: z.string().min(1).max(40).nullable().optional(),
  taxId: z.string().min(1).max(40).nullable().optional(),
  email: z.string().min(3).max(320).nullable().optional(),
  phone: z.string().min(1).max(80).nullable().optional(),
  website: z.string().min(1).max(300).nullable().optional(),
  notes: z.string().max(20_000).nullable().optional(),
  defaultCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  defaultLanguage: z.enum(['en', 'el']).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(3650).nullable().optional(),
  acceptsEInvoices: z.boolean().optional(),
  contacts: z.array(contactSchema).max(30).optional(),
  addresses: z.array(addressSchema).max(30).optional(),
};

export const clientCreate = z.strictObject(clientFields);
