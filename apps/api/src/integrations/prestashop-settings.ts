import {
  PAYMENT_STATUSES,
  isIanaTimeZone,
  wallTimeInZoneToInstant,
  type PaymentStatus,
} from '@bp/domain';
import { canonicalPrestashopBaseUrl } from '@bp/integrations';
import { z } from 'zod';

const SHOP_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const stateEntry = z
  .object({
    payment: z.enum(PAYMENT_STATUSES),
    cancelled: z.boolean(),
  })
  .strict();

/**
 * `store_connection.settings` for a PrestaShop store.
 * `http:` is accepted only for a loopback host, the same rule as the client,
 * so a test can point at a fake server. A live shop is `https`.
 */
export const prestashopSettingsSchema = z
  .object({
    baseUrl: z.string().transform((value, ctx) => {
      try {
        return canonicalPrestashopBaseUrl(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'baseUrl is invalid' });
        return value;
      }
    }),
    timezone: z.string().refine(isIanaTimeZone, 'timezone is invalid'),
    firstImportFrom: z.string().regex(SHOP_TIME, 'firstImportFrom must be YYYY-MM-DD HH:mm:ss'),
    pollIntervalSeconds: z.number().int().min(120).default(180),
    stateMap: z.record(z.string().min(1), stateEntry),
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      wallTimeInZoneToInstant(value.firstImportFrom, value.timezone);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'firstImportFrom is invalid',
        path: ['firstImportFrom'],
      });
    }
  });

export type PrestashopSettings = z.infer<typeof prestashopSettingsSchema>;

export class PrestashopSettingsInvalid extends Error {
  override readonly name = 'PrestashopSettingsInvalid';
  readonly code = 'settings_invalid';

  constructor() {
    super('settings_invalid');
  }
}

export function parsePrestashopSettings(value: unknown): PrestashopSettings {
  const parsed = prestashopSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new PrestashopSettingsInvalid();
  }
  return parsed.data;
}

export function readPrestashopSettings(value: unknown): PrestashopSettings | null {
  const parsed = prestashopSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type { PaymentStatus };
