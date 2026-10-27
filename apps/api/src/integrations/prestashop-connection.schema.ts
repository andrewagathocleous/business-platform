import { DELIVERY_METHODS, PAYMENT_STATUSES } from '@bp/domain';
import { z } from 'zod';

const SHOP_ID = /^[0-9]+$/;
const PRESTASHOP_KEY = /^[A-Za-z0-9]{32}$/;

const stateEntry = z
  .object({
    payment: z.enum(PAYMENT_STATUSES),
    cancelled: z.boolean(),
  })
  .strict();

export const connectionPutSchema = z
  .object({
    baseUrl: z.string(),
    timezone: z.string(),
    firstImportFrom: z.string(),
    pollIntervalSeconds: z.number().int().min(120).optional(),
    key: z.string().regex(PRESTASHOP_KEY).optional(),
  })
  .strict();

export const connectionMapsSchema = z
  .object({
    stateMap: z.record(z.string().regex(SHOP_ID), stateEntry),
    carrierMap: z.record(z.string().regex(SHOP_ID), z.enum(DELIVERY_METHODS)),
  })
  .strict();

export const emptyBodySchema = z.object({}).strict();

export type ConnectionPut = z.infer<typeof connectionPutSchema>;
export type ConnectionMaps = z.infer<typeof connectionMapsSchema>;
