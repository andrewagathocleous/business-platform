import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type TenantTransaction } from '@bp/db';
import type { DeliveryMethod, FulfilmentStatus, PaymentStatus } from '@bp/domain';
import { unsupportedGlyphs } from '@bp/documents';
import {
  mapPrestashopOrder,
  mapShopifyOrder,
  PrestashopMapError,
  ShopifyMapError,
  type MappedShopifyOrder,
} from '@bp/integrations';
import { carrierMapOf } from '../integrations/prestashop-connections';
import { parsePrestashopSettings, PrestashopSettingsInvalid } from '../integrations/prestashop-settings';
import { AuditService } from '../audit/audit.service';
import { uuidv7 } from '../correlation/correlation';
import type { ClaimedJob, JobOutcome } from './jobs/job-runner';

export type InboxProcessHooks = {
  beforeAdvisoryLock?: (inboxId: string) => Promise<void>;
  afterAdvisoryLock?: (inboxId: string) => Promise<void>;
};

// submitting and uncertain may already have reached the provider.
const PRINTED = [
  'submitting',
  'submitted',
  'delivered_to_printer',
  'done_reported',
  'confirmed_printed',
  'uncertain',
] as const;

const TERMINAL = new Set<string>(['completed', 'cancelled']);

type InboxRecord = {
  id: string;
  connectionId: string;
  externalObjectId: string | null;
  payload: unknown;
  status: string;
};

type LockedOrder = {
  id: string;
  version: number;
  fulfilment_status: string;
  source_updated_at: Date | null;
  gift_message: string | null;
  review_reason: string | null;
  attention_reasons: string[] | null;
};

/**
 * Turns one inbox row into an order. The runner calls this inside the company transaction.
 * `hooks` is a test seam so concurrent imports can be forced into a chosen arrival order.
 */
@Injectable()
export class InboxProcessor {
  hooks: InboxProcessHooks | null = null;

  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async run(job: ClaimedJob, tx: TenantTransaction, signal: AbortSignal): Promise<JobOutcome | undefined> {
    if (signalAborted(signal)) {
      throw aborted(signal);
    }
    const payload = readJobPayload(job.payload);
    if (!payload || !job.companyId) {
      return { failed: 'invalid_job_payload' };
    }
    const inbox = await tx.integrationInbox.findFirst({
      where: { id: payload.inboxId, companyId: job.companyId },
    });
    if (!inbox) {
      return { failed: 'inbox_not_found' };
    }
    if (inbox.status !== 'received') {
      return;
    }
    const loaded = toInbox(inbox);
    if (!loaded.externalObjectId) {
      return this.fail(tx, job.companyId, payload, loaded.id, 'missing_external_object_id');
    }
    const connection = await tx.storeConnection.findFirst({
      where: { id: loaded.connectionId, companyId: job.companyId },
      include: { store: true },
    });
    if (!connection) {
      return this.fail(tx, job.companyId, payload, loaded.id, 'connection_not_importable');
    }
    const platform = connection.store.platform;
    if (platform === 'prestashop') {
      // Rows already in the inbox were received with a working key, so auth_failed
      // still imports. Any other status leaves the row received.
      // Activating the connection re-enqueues those received rows.
      if (connection.status !== 'active' && connection.status !== 'auth_failed') {
        return { failed: 'connection_not_importable' };
      }
      if (connection.mode !== 'live') {
        return this.fail(tx, job.companyId, payload, loaded.id, 'connection_not_importable');
      }
    } else if (connection.status !== 'active') {
      return this.fail(tx, job.companyId, payload, loaded.id, 'connection_not_importable');
    } else if (platform === 'shopify') {
      if (connection.mode !== 'mock') {
        return this.fail(tx, job.companyId, payload, loaded.id, 'connection_not_importable');
      }
    } else if (connection.mode !== 'mock') {
      return this.fail(tx, job.companyId, payload, loaded.id, 'connection_not_importable');
    } else {
      return this.fail(tx, job.companyId, payload, loaded.id, 'unsupported_provider');
    }
    await this.hooks?.beforeAdvisoryLock?.(loaded.id);
    const lockKey = `${connection.id}:${loaded.externalObjectId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0::bigint))`;
    await this.hooks?.afterAdvisoryLock?.(loaded.id);
    if (signalAborted(signal)) {
      throw aborted(signal);
    }
    let mapped: MappedShopifyOrder;
    try {
      mapped = mapOrder(platform, loaded.payload, connection);
    } catch (error) {
      const message = mapFailure(error);
      return this.fail(tx, job.companyId, payload, loaded.id, message);
    }
    const missing = unsupportedGlyphs(mapped.giftMessage ?? '');
    const inserted = await insertOrder(tx, job.companyId, connection.storeId, connection.id, connection.store.platform, mapped, missing);
    const locked = await lockOrder(tx, job.companyId, connection.id, mapped.externalId);
    if (!locked) {
      return this.fail(tx, job.companyId, payload, loaded.id, 'order_missing');
    }
    if (inserted) {
      await replaceLines(tx, job.companyId, locked.id, mapped);
      await this.auditOrder(tx, job.companyId, payload, locked.id, 'order.imported', {
        externalId: mapped.externalId,
        externalNumber: mapped.externalNumber,
        version: locked.version,
        fulfilmentStatus: locked.fulfilment_status,
        reviewReason: createReview(mapped, missing).reason,
      });
      await this.finish(tx, job.companyId, payload, loaded.id, 'processed');
      return;
    }
    const incoming = mapped.sourceUpdatedAt.getTime();
    const current = locked.source_updated_at?.getTime() ?? null;
    if (current !== null && incoming <= current) {
      await this.finish(tx, job.companyId, payload, loaded.id, 'stale');
      return;
    }
    const giftChanged = !sameText(locked.gift_message, mapped.giftMessage);
    const printed = giftChanged ? await giftPrinted(tx, job.companyId, locked.id) : false;
    const alreadyCancelled = reasonPresent(locked.review_reason, locked.attention_reasons ?? [], 'cancelled_at_source');
    const signals = updateSignals(mapped, giftChanged && printed, alreadyCancelled);
    const terminal = TERMINAL.has(locked.fulfilment_status);
    const attention = appendReasons(locked.attention_reasons ?? [], terminal ? signals : []);
    const changed = await tx.salesOrder.updateMany({
      where: {
        id: locked.id,
        companyId: job.companyId,
        OR: [{ sourceUpdatedAt: null }, { sourceUpdatedAt: { lt: mapped.sourceUpdatedAt } }],
      },
      data: sourceUpdate(mapped, connection.store.platform, missing, terminal, signals, attention),
    });
    if (changed.count !== 1) {
      await this.finish(tx, job.companyId, payload, loaded.id, 'stale');
      return;
    }
    await replaceLines(tx, job.companyId, locked.id, mapped);
    const saved = await tx.salesOrder.findFirst({
      where: { id: locked.id, companyId: job.companyId },
      select: { version: true, fulfilmentStatus: true, reviewReason: true, attentionReasons: true },
    });
    await this.auditOrder(tx, job.companyId, payload, locked.id, 'order.source_updated', {
      externalId: mapped.externalId,
      fromVersion: locked.version,
      toVersion: saved?.version ?? locked.version + 1,
      fulfilmentStatus: saved?.fulfilmentStatus ?? locked.fulfilment_status,
      reviewReason: saved?.reviewReason ?? null,
      attentionReasons: saved?.attentionReasons ?? attention,
      appendedReasons: terminal ? signals : [],
    });
    await this.finish(tx, job.companyId, payload, loaded.id, 'processed');
  }

  private async fail(
    tx: TenantTransaction,
    companyId: string,
    actor: JobActor,
    inboxId: string,
    message: string,
  ): Promise<JobOutcome> {
    const error = message.slice(0, 500);
    await tx.integrationInbox.update({
      where: { id: inboxId },
      data: { status: 'failed', processedAt: new Date(), error },
    });
    await this.auditInbox(tx, companyId, actor, inboxId, 'inbox.failed', 'failure', { error });
    return { failed: error };
  }

  private async finish(
    tx: TenantTransaction,
    companyId: string,
    actor: JobActor,
    inboxId: string,
    status: 'processed' | 'stale',
  ): Promise<void> {
    await tx.integrationInbox.update({
      where: { id: inboxId },
      data: { status, processedAt: new Date(), error: null },
    });
    if (status === 'stale') {
      await this.auditInbox(tx, companyId, actor, inboxId, 'inbox.stale', 'success', { status: 'stale' });
    }
  }

  private async auditOrder(
    tx: TenantTransaction,
    companyId: string,
    payload: JobActor,
    orderId: string,
    action: 'order.imported' | 'order.source_updated',
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId,
      actorType: 'service',
      actorId: payload.serviceIdentityId,
      actorLabel: payload.actorLabel,
      action,
      objectType: 'order',
      objectId: orderId,
      outcome: 'success',
      details,
    });
  }

  private async auditInbox(
    tx: TenantTransaction,
    companyId: string,
    actor: JobActor,
    inboxId: string,
    action: 'inbox.stale' | 'inbox.failed',
    outcome: 'success' | 'failure',
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId,
      actorType: 'service',
      actorId: actor.serviceIdentityId,
      actorLabel: actor.actorLabel,
      action,
      objectType: 'integration_inbox',
      objectId: inboxId,
      outcome,
      details,
    });
  }
}

type JobActor = {
  serviceIdentityId: string | null;
  actorLabel: string | null;
};

function readJobPayload(payload: unknown): ({ inboxId: string } & JobActor) | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  if (!('inboxId' in payload) || typeof payload.inboxId !== 'string') {
    return null;
  }
  const serviceIdentityId =
    'serviceIdentityId' in payload && typeof payload.serviceIdentityId === 'string'
      ? payload.serviceIdentityId
      : null;
  const actorLabel = 'actorLabel' in payload && typeof payload.actorLabel === 'string' ? payload.actorLabel : null;
  return { inboxId: payload.inboxId, serviceIdentityId, actorLabel };
}

function toInbox(row: {
  id: string;
  connectionId: string;
  externalObjectId: string | null;
  payload: unknown;
  status: string;
}): InboxRecord {
  return row;
}

function createReview(
  mapped: MappedShopifyOrder,
  missing: readonly string[],
): { fulfilment: FulfilmentStatus; reason: string | null } {
  const reasons: string[] = [];
  if (mapped.paymentStatus === 'unknown') {
    reasons.push('unknown_payment');
  }
  if (mapped.deliveryMethod === 'unknown') {
    reasons.push('unknown_delivery');
  }
  if (missing.length > 0) {
    reasons.push('unsupported_glyphs');
  }
  if (mapped.sourceStatus.cancelledAt) {
    reasons.push('cancelled_at_source');
  }
  if (reasons.length === 0) {
    return { fulfilment: 'new', reason: null };
  }
  return { fulfilment: 'review_required', reason: reasons.join(',') };
}

function updateSignals(
  mapped: MappedShopifyOrder,
  giftChangedAfterPrint: boolean,
  alreadyCancelled: boolean,
): string[] {
  const reasons: string[] = [];
  if (mapped.sourceStatus.cancelledAt || alreadyCancelled) {
    reasons.push('cancelled_at_source');
  }
  if (giftChangedAfterPrint) {
    reasons.push('gift_message_changed_after_print');
  }
  return reasons;
}

function reasonPresent(reviewReason: string | null, attention: readonly string[], reason: string): boolean {
  if (attention.includes(reason)) {
    return true;
  }
  if (!reviewReason) {
    return false;
  }
  return reviewReason.split(',').includes(reason);
}

function appendReasons(existing: readonly string[], additions: readonly string[]): string[] {
  const next = [...existing];
  for (const reason of additions) {
    if (!next.includes(reason)) {
      next.push(reason);
    }
  }
  return next;
}

async function insertOrder(
  tx: TenantTransaction,
  companyId: string,
  storeId: string,
  connectionId: string,
  platform: string,
  mapped: MappedShopifyOrder,
  missing: readonly string[],
): Promise<boolean> {
  const review = createReview(mapped, missing);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO sales_order (
      id, company_id, store_id, connection_id, external_id, external_number,
      source_platform, source_status, source_created_at, source_updated_at,
      payment_status, fulfilment_status, integration_status, review_reason, attention_reasons,
      customer, recipient, billing_address, delivery_method, shipping_line,
      gift_message, gift_message_meta, customer_note, currency,
      subtotal, shipping_total, tax_total, total, version, created_at, updated_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${companyId}::uuid,
      ${storeId}::uuid,
      ${connectionId}::uuid,
      ${mapped.externalId},
      ${mapped.externalNumber},
      ${platform}::"store_platform",
      ${JSON.stringify(mapped.sourceStatus)}::jsonb,
      ${mapped.sourceCreatedAt},
      ${mapped.sourceUpdatedAt},
      ${mapped.paymentStatus}::"payment_status",
      ${review.fulfilment}::"fulfilment_status",
      'synced'::"integration_status",
      ${review.reason},
      '{}'::text[],
      ${JSON.stringify(mapped.customer)}::jsonb,
      ${jsonText(mapped.recipient)}::jsonb,
      ${jsonText(mapped.billingAddress)}::jsonb,
      ${mapped.deliveryMethod}::"delivery_method",
      ${jsonText(mapped.shippingLine)}::jsonb,
      ${mapped.giftMessage},
      ${jsonText(missing.length > 0 ? { unsupportedChars: [...missing] } : null)}::jsonb,
      ${mapped.customerNote},
      ${mapped.currency},
      ${mapped.subtotal}::numeric,
      ${mapped.shippingTotal}::numeric,
      ${mapped.taxTotal}::numeric,
      ${mapped.total}::numeric,
      1,
      now(),
      now()
    )
    ON CONFLICT (company_id, connection_id, external_id) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

async function lockOrder(
  tx: TenantTransaction,
  companyId: string,
  connectionId: string,
  externalId: string,
): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT
      id,
      version,
      fulfilment_status::text AS fulfilment_status,
      source_updated_at,
      gift_message,
      review_reason,
      attention_reasons
    FROM sales_order
    WHERE company_id = ${companyId}::uuid
      AND connection_id = ${connectionId}::uuid
      AND external_id = ${externalId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
    return { ...row, attention_reasons: row.attention_reasons ?? [] };
}

function sourceUpdate(
  mapped: MappedShopifyOrder,
  platform: string,
  missing: readonly string[],
  terminal: boolean,
  signals: readonly string[],
  attention: readonly string[],
): {
  externalNumber: string;
  sourcePlatform: 'shopify' | 'prestashop' | 'manual';
  sourceStatus: Prisma.InputJsonValue;
  sourceCreatedAt: Date;
  sourceUpdatedAt: Date;
  paymentStatus: PaymentStatus;
  deliveryMethod: DeliveryMethod;
  customer: Prisma.InputJsonValue;
  recipient: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  billingAddress: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  shippingLine: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  giftMessage: string | null;
  giftMessageMeta: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  customerNote: string | null;
  currency: string;
  subtotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  integrationStatus: 'synced';
  version: { increment: number };
  fulfilmentStatus?: FulfilmentStatus;
  reviewReason?: string;
  attentionReasons?: string[];
} {
  const data = {
    externalNumber: mapped.externalNumber,
    sourcePlatform: platformValue(platform),
    sourceStatus: jsonValue(mapped.sourceStatus),
    sourceCreatedAt: mapped.sourceCreatedAt,
    sourceUpdatedAt: mapped.sourceUpdatedAt,
    paymentStatus: mapped.paymentStatus,
    deliveryMethod: mapped.deliveryMethod,
    customer: jsonValue(mapped.customer),
    recipient: jsonOrNull(mapped.recipient),
    billingAddress: jsonOrNull(mapped.billingAddress),
    shippingLine: jsonOrNull(mapped.shippingLine),
    giftMessage: mapped.giftMessage,
    giftMessageMeta: jsonOrNull(missing.length > 0 ? { unsupportedChars: [...missing] } : null),
    customerNote: mapped.customerNote,
    currency: mapped.currency,
    subtotal: mapped.subtotal,
    shippingTotal: mapped.shippingTotal,
    taxTotal: mapped.taxTotal,
    total: mapped.total,
    integrationStatus: 'synced' as const,
    version: { increment: 1 },
  };
  if (terminal) {
    return { ...data, attentionReasons: [...attention] };
  }
  if (signals.length > 0) {
    return { ...data, fulfilmentStatus: 'review_required', reviewReason: signals.join(',') };
  }
  return data;
}

async function replaceLines(
  tx: TenantTransaction,
  companyId: string,
  orderId: string,
  mapped: MappedShopifyOrder,
): Promise<void> {
  await tx.salesOrderLine.deleteMany({ where: { companyId, orderId } });
  if (mapped.lines.length === 0) {
    return;
  }
  await tx.salesOrderLine.createMany({
    data: mapped.lines.map((line) => ({
      companyId,
      orderId,
      externalLineId: line.externalLineId,
      sku: line.sku,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: line.total,
    })),
  });
}

async function giftPrinted(tx: TenantTransaction, companyId: string, orderId: string): Promise<boolean> {
  const job = await tx.printJob.findFirst({
    where: {
      companyId,
      sourceType: 'order',
      sourceId: orderId,
      documentType: 'gift_message',
      status: { in: [...PRINTED] },
    },
    select: { id: true },
  });
  return job !== null;
}

function sameText(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return Buffer.from(left, 'utf8').equals(Buffer.from(right, 'utf8'));
}

function mapOrder(
  platform: string,
  payload: unknown,
  connection: {
    mode: string;
    settings: unknown;
    store: { giftMessageKeys: string[]; deliveryMethodMap: unknown };
  },
): MappedShopifyOrder {
  if (platform === 'prestashop') {
    const settings = parsePrestashopSettings(connection.settings);
    return mapPrestashopOrder(payload, {
      timezone: settings.timezone,
      stateMap: settings.stateMap,
      carrierMap: carrierMapOf(connection.store.deliveryMethodMap),
    });
  }
  return mapShopifyOrder(payload, {
    giftMessageKeys: connection.store.giftMessageKeys,
    deliveryMethodMap: stringMap(connection.store.deliveryMethodMap),
  });
}

function mapFailure(error: unknown): string {
  if (error instanceof ShopifyMapError || error instanceof PrestashopMapError) {
    return error.message;
  }
  if (error instanceof PrestashopSettingsInvalid) {
    return error.code;
  }
  return 'order_map_failed';
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

function jsonText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed === 'object' && parsed !== null) {
    return parsed;
  }
  return {};
}

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null || value === undefined) {
    return Prisma.JsonNull;
  }
  return jsonValue(value);
}

function platformValue(value: string): 'shopify' | 'prestashop' | 'manual' {
  if (value === 'shopify' || value === 'prestashop' || value === 'manual') {
    return value;
  }
  return 'shopify';
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function aborted(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException('The operation was aborted', 'AbortError');
}
