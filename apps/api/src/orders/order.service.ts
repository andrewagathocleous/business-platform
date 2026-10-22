import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import {
  allowedTransitions,
  can,
  decideAccess,
  DELIVERY_METHODS,
  permittedScopeFilter,
  evaluateTransition,
  FULFILMENT_STATUSES,
  PAYMENT_STATUSES,
  type DeliveryMethod,
  type FulfilmentStatus,
  type Grant,
  type PaymentStatus,
  type ResourceScope,
  type TransitionDecision,
} from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { grantsForMembership } from '../authz/load-grants';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { fixed } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { businessDateBounds } from './business-time';
import type { OrderListQuery } from './order.query';
import { blocksFirstPrint } from '../printing/first-print';
import { printJobLabel, type PrintSlot } from '../printing/print-label';
import { orderScopes } from './order.scope';

const PRINT_TYPES = ['invoice', 'packing_slip', 'gift_message', 'shipping_label'] as const;

type PrintType = (typeof PRINT_TYPES)[number];

export type OrderTransitionInput = {
  to: FulfilmentStatus;
  expectedVersion: number;
  reason?: string;
};

export type OrderNoteInput = { body: string };

export type OrderAssignInput = { userId: string | null; expectedVersion: number };

export type OrderActivityEvent = {
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  correlationId: string;
  details: unknown;
};

type Money = { toFixed(digits: number): string };

type OrderRow = {
  id: string;
  storeId: string;
  connectionId: string;
  externalId: string;
  externalNumber: string;
  sourcePlatform: string;
  sourceStatus: unknown;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
  paymentStatus: string;
  fulfilmentStatus: string;
  integrationStatus: string;
  reviewReason: string | null;
  attentionReasons: string[];
  customer: unknown;
  recipient: unknown;
  billingAddress: unknown;
  deliveryMethod: string;
  shippingLine: unknown;
  giftMessage: string | null;
  customerNote: string | null;
  currency: string;
  subtotal: Money;
  shippingTotal: Money;
  taxTotal: Money;
  total: Money;
  assignedToUserId: string | null;
  version: number;
  lines?: LineRow[];
  notes?: NoteRow[];
  store?: { locationId: string };
};

type LineRow = {
  id: string;
  externalLineId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  quantity: Money;
  unitPrice: Money;
  total: Money;
};

type NoteRow = {
  id: string;
  body: string;
  authorUserId: string;
  createdAt: Date;
};

type LockedOrder = {
  id: string;
  version: number;
  store_id: string;
  location_id: string;
  fulfilment_status: string;
  payment_status: string;
  delivery_method: string;
};

type StoreScope = { kind: 'all' } | { kind: 'none' } | { kind: 'ids'; ids: string[] };

@Injectable()
export class OrderService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async list(ctx: RequestContext, query: OrderListQuery, meta: RequestMeta) {
    const actor = requireActor(ctx);
    if (query.assigned === 'me' && !ctx.userId) {
      throw new BadRequestException('assigned=me requires a user');
    }
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const scope = await this.visibleStoreIds(tx, ctx);
        if (scope.kind === 'none') {
          return emptyPage(query);
        }
        if (query.storeId && scope.kind === 'ids' && !scope.ids.includes(query.storeId)) {
          return emptyPage(query);
        }
        const company = await tx.company.findUnique({
          where: { id: ctx.companyId },
          select: { timezone: true },
        });
        const bounds = businessDateBounds(query.from, query.to, company?.timezone ?? 'Asia/Nicosia');
        const matched = query.q ? await searchIds(tx, ctx.companyId, query.q) : null;
        if (matched && matched.length === 0) {
          return emptyPage(query);
        }
        const where: Prisma.SalesOrderWhereInput = {
          companyId: ctx.companyId,
          ...(query.storeId
            ? { storeId: query.storeId }
            : scope.kind === 'ids'
              ? { storeId: { in: scope.ids } }
              : {}),
          ...(query.fulfilmentStatus.length > 0 ? { fulfilmentStatus: { in: query.fulfilmentStatus } } : {}),
          ...(query.paymentStatus.length > 0 ? { paymentStatus: { in: query.paymentStatus } } : {}),
          ...(query.assigned === 'me' ? { assignedToUserId: actor } : {}),
          ...(query.assigned === 'none' ? { assignedToUserId: null } : {}),
          ...(bounds.from || bounds.to
            ? { sourceCreatedAt: { ...(bounds.from ? { gte: bounds.from } : {}), ...(bounds.to ? { lt: bounds.to } : {}) } }
            : {}),
          ...(matched ? { id: { in: matched } } : {}),
        };
        // One connection cannot run two queries at once through the pg driver adapter.
        // createPrismaClient also serialises each pooled client's query() so an include
        // cannot overlap a query that is still in flight.
        const total = await tx.salesOrder.count({ where });
        const rows = await tx.salesOrder.findMany({
          where,
          orderBy: orderBy(query),
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        const names = await memberNames(
          tx,
          ctx.companyId,
          rows.map((row) => row.assignedToUserId),
        );
        return {
          orders: rows.map((row) => orderSummary(row, names)),
          page: query.page,
          pageSize: query.pageSize,
          total,
        };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async detail(ctx: RequestContext, id: string, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const order = await this.load(tx, ctx.companyId, id);
        return { order: await presentOrder(tx, ctx, order) };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async transition(ctx: RequestContext, id: string, input: OrderTransitionInput, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const order = await lockOrder(tx, ctx.companyId, id);
        if (!order) {
          throw new CommerceError(404, 'order_not_found', 'order', isUuid(id) ? id.toLowerCase() : null, 'Not found');
        }
        if (input.to === 'cancelled') {
          assertScope(
            ctx.grants,
            'order.cancel',
            orderScopes(order.store_id, order.location_id),
            order.id,
            'order.transition',
          );
        }
        if (order.version !== input.expectedVersion) {
          throw new CommerceError(409, 'version_conflict', 'order', order.id, 'version_conflict', 'order.transition');
        }
        const state = {
          fulfilmentStatus: fulfilmentOf(order.fulfilment_status),
          paymentStatus: paymentOf(order.payment_status),
          deliveryMethod: deliveryOf(order.delivery_method),
        };
        const decision = evaluateTransition(state, input.to);
        if (!decision.allowed) {
          throw new CommerceError(
            422,
            decision.error ?? 'transition_not_allowed',
            'order',
            order.id,
            decision.error ?? 'transition_not_allowed',
            'order.transition',
            { from: state.fulfilmentStatus, to: input.to },
          );
        }
        if (decision.requiredPermission) {
          assertScope(
            ctx.grants,
            decision.requiredPermission,
            orderScopes(order.store_id, order.location_id),
            order.id,
            'order.transition',
          );
        }
        const updated = await tx.salesOrder.updateMany({
          where: { id: order.id, companyId: ctx.companyId, version: order.version },
          data: { fulfilmentStatus: input.to, version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new CommerceError(409, 'version_conflict', 'order', order.id, 'version_conflict', 'order.transition');
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'order.transition',
          objectType: 'order',
          objectId: order.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { from: state.fulfilmentStatus, to: input.to, reason: input.reason ?? null },
        });
        const saved = await this.load(tx, ctx.companyId, order.id);
        return { order: await presentOrder(tx, ctx, saved) };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async addNote(ctx: RequestContext, id: string, input: OrderNoteInput, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const order = await this.load(tx, ctx.companyId, id);
        const note = await tx.orderNote.create({
          data: { companyId: ctx.companyId, orderId: order.id, authorUserId: actor, body: input.body },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'order.note_added',
          objectType: 'order',
          objectId: order.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { noteId: note.id },
        });
        const saved = await this.load(tx, ctx.companyId, order.id);
        const names = await memberNames(tx, ctx.companyId, [
          saved.assignedToUserId,
          note.authorUserId,
          ...(saved.notes ?? []).map((item) => item.authorUserId),
        ]);
        return {
          note: noteView(note, names),
          order: orderDetail(saved, ctx, await printState(tx, ctx.companyId, order.id), names),
        };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async assign(ctx: RequestContext, id: string, input: OrderAssignInput, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const order = await lockOrder(tx, ctx.companyId, id);
        if (!order) {
          throw new CommerceError(404, 'order_not_found', 'order', isUuid(id) ? id.toLowerCase() : null, 'Not found');
        }
        const userId = input.userId?.toLowerCase() ?? null;
        const self = userId !== null && userId === actor.toLowerCase();
        const scopes = orderScopes(order.store_id, order.location_id);
        if (self) {
          assertClaimOrAssign(ctx.grants, scopes, order.id);
        } else {
          assertScope(ctx.grants, 'order.assign', scopes, order.id, 'order.assign');
        }
        if (order.version !== input.expectedVersion) {
          throw new CommerceError(409, 'version_conflict', 'order', order.id, 'version_conflict', 'order.assign');
        }
        if (userId) {
          await assertAssignee(
            tx,
            ctx.companyId,
            order.store_id,
            order.location_id,
            order.id,
            userId,
            self ? 'order.claimed' : 'order.assign',
          );
        }
        const updated = await tx.salesOrder.updateMany({
          where: { id: order.id, companyId: ctx.companyId, version: order.version },
          data: { assignedToUserId: userId, version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new CommerceError(409, 'version_conflict', 'order', order.id, 'version_conflict', 'order.assign');
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: self ? 'order.claimed' : 'order.assigned',
          objectType: 'order',
          objectId: order.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { userId },
        });
        const saved = await this.load(tx, ctx.companyId, order.id);
        return { order: await presentOrder(tx, ctx, saved) };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async activity(ctx: RequestContext, id: string, meta: RequestMeta): Promise<{ events: OrderActivityEvent[] }> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const order = await this.load(tx, ctx.companyId, id);
        const prints = await tx.printJob.findMany({
          where: { companyId: ctx.companyId, sourceType: 'order', sourceId: order.id },
          select: { id: true },
        });
        const printIds = prints.map((job) => job.id);
        const events = await tx.auditEvent.findMany({
          where: {
            companyId: ctx.companyId,
            OR: [
              { objectType: 'order', objectId: order.id },
              ...(printIds.length > 0 ? [{ objectType: 'print_job', objectId: { in: printIds } }] : []),
            ],
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        });
        return {
          events: events.map((event) => ({
            id: event.id,
            occurredAt: event.occurredAt.toISOString(),
            actorType: event.actorType,
            actorId: event.actorId,
            actorLabel: event.actorLabel,
            action: event.action,
            objectType: event.objectType,
            objectId: event.objectId,
            outcome: event.outcome,
            correlationId: event.correlationId,
            details: event.details,
          })),
        };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async filters(
    ctx: RequestContext,
    meta: RequestMeta,
  ): Promise<{ stores: { id: string; name: string; platform: string }[] }> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const scope = await this.visibleStoreIds(tx, ctx);
        if (scope.kind === 'none') {
          return { stores: [] };
        }
        const stores = await tx.store.findMany({
          where: {
            companyId: ctx.companyId,
            ...(scope.kind === 'ids' ? { id: { in: scope.ids } } : {}),
          },
          select: { id: true, name: true, platform: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        });
        return {
          stores: stores.map((store) => ({
            id: store.id,
            name: store.name,
            platform: store.platform,
          })),
        };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async assignees(ctx: RequestContext, id: string, meta: RequestMeta) {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const order = await this.load(tx, ctx.companyId, id);
        const members = await tx.membership.findMany({
          where: { companyId: ctx.companyId, status: 'active', user: { status: 'active' } },
          select: { id: true, userId: true, user: { select: { displayName: true } } },
          orderBy: [{ user: { displayName: 'asc' } }, { userId: 'asc' }],
        });
        const users: { userId: string; displayName: string }[] = [];
        for (const member of members) {
          const grants = await grantsForMembership(tx, member.id);
          if (assigneeCandidate(grants, order.storeId, order.store?.locationId ?? '')) {
            users.push({ userId: member.userId, displayName: member.user.displayName });
          }
        }
        return { users };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private async visibleStoreIds(tx: TenantTransaction, ctx: RequestContext): Promise<StoreScope> {
    const stores = permittedScopeFilter(ctx.grants, 'order.view', 'store');
    const locations = permittedScopeFilter(ctx.grants, 'order.view', 'location');
    if (stores.kind === 'all' || locations.kind === 'all') {
      return { kind: 'all' };
    }
    const ids = new Set<string>(stores.kind === 'ids' ? stores.ids : []);
    const locationIds = locations.kind === 'ids' ? locations.ids : [];
    if (locationIds.length > 0) {
      const rows = await tx.store.findMany({
        where: { companyId: ctx.companyId, locationId: { in: locationIds } },
        select: { id: true },
      });
      for (const row of rows) {
        ids.add(row.id);
      }
    }
    if (ids.size === 0) {
      return { kind: 'none' };
    }
    return { kind: 'ids', ids: [...ids] };
  }

  private async load(tx: TenantTransaction, companyId: string, id: string): Promise<OrderRow> {
    if (!isUuid(id)) {
      throw new CommerceError(404, 'order_not_found', 'order', null, 'Not found');
    }
    const order = await tx.salesOrder.findFirst({
      where: { id: id.toLowerCase(), companyId },
      include: {
        lines: { orderBy: { id: 'asc' } },
        notes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        store: { select: { locationId: true } },
      },
    });
    if (!order) {
      throw new CommerceError(404, 'order_not_found', 'order', id.toLowerCase(), 'Not found');
    }
    return order;
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  private async fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

async function assertAssignee(
  tx: TenantTransaction,
  companyId: string,
  storeId: string,
  locationId: string,
  orderId: string,
  userId: string,
  action: string,
): Promise<void> {
  const user = await tx.userAccount.findUnique({ where: { id: userId } });
  const membership =
    user && user.status === 'active'
      ? await tx.membership.findUnique({ where: { userId_companyId: { userId, companyId } } })
      : null;
  const grants = membership && membership.status === 'active' ? await grantsForMembership(tx, membership.id) : [];
  if (!assigneeGrantsAllow(grants, storeId, locationId)) {
    throw new CommerceError(422, 'assignee_not_allowed', 'order', orderId, 'assignee_not_allowed', action);
  }
}

async function lockOrder(tx: TenantTransaction, companyId: string, id: string): Promise<LockedOrder | null> {
  if (!isUuid(id)) {
    return null;
  }
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT
      o.id,
      o.version,
      o.store_id,
      s.location_id,
      o.fulfilment_status::text AS fulfilment_status,
      o.payment_status::text AS payment_status,
      o.delivery_method::text AS delivery_method
    FROM sales_order o
    JOIN store s ON s.company_id = o.company_id AND s.id = o.store_id
    WHERE o.company_id = ${companyId}::uuid AND o.id = ${id.toLowerCase()}::uuid
    FOR UPDATE OF o
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return row;
}

async function searchIds(tx: TenantTransaction, companyId: string, q: string): Promise<string[]> {
  const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM sales_order
    WHERE company_id = ${companyId}::uuid
      AND (
        external_number ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(customer->>'displayName', '') ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(customer->>'email', '') ILIKE ${pattern} ESCAPE '\\'
      )
  `;
  return rows.map((row) => row.id);
}

async function printState(
  tx: TenantTransaction,
  companyId: string,
  orderId: string,
): Promise<{ latest: Record<PrintType, PrintSlot | null>; firstPrintAvailable: Record<PrintType, boolean> }> {
  const jobs = await tx.printJob.findMany({
    where: { companyId, sourceType: 'order', sourceId: orderId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      documentType: true,
      status: true,
      isReprint: true,
      createdAt: true,
      printerId: true,
    },
  });
  const printerIds = [...new Set(jobs.map((job) => job.printerId))];
  const printers =
    printerIds.length === 0
      ? []
      : await tx.printer.findMany({
          where: { companyId, id: { in: printerIds } },
          select: { id: true, provider: true },
        });
  const providerById = new Map(printers.map((printer) => [printer.id, printer.provider]));
  const latest: Record<PrintType, PrintSlot | null> = {
    invoice: null,
    packing_slip: null,
    gift_message: null,
    shipping_label: null,
  };
  const blocked = new Set<PrintType>();
  for (const job of jobs) {
    if (!isPrintType(job.documentType)) {
      continue;
    }
    if (blocksFirstPrint(job.status, job.isReprint)) {
      blocked.add(job.documentType);
    }
    if (latest[job.documentType] !== null) {
      continue;
    }
    const provider = providerById.get(job.printerId) ?? 'mock';
    latest[job.documentType] = {
      id: job.id,
      documentType: job.documentType,
      status: job.status,
      isReprint: job.isReprint,
      createdAt: job.createdAt.toISOString(),
      provider,
      label: printJobLabel(job.status),
    };
  }
  return {
    latest,
    firstPrintAvailable: {
      invoice: !blocked.has('invoice'),
      packing_slip: !blocked.has('packing_slip'),
      gift_message: !blocked.has('gift_message'),
      shipping_label: !blocked.has('shipping_label'),
    },
  };
}

function orderBy(query: OrderListQuery): Prisma.SalesOrderOrderByWithRelationInput[] {
  const direction = query.sortDirection;
  switch (query.sortField) {
    case 'sourceCreatedAt':
      return [{ sourceCreatedAt: direction }, { id: 'asc' }];
    case 'sourceUpdatedAt':
      return [{ sourceUpdatedAt: direction }, { id: 'asc' }];
    case 'externalNumber':
      return [{ externalNumber: direction }, { id: 'asc' }];
    case 'createdAt':
      return [{ createdAt: direction }, { id: 'asc' }];
    case 'fulfilmentStatus':
      return [{ fulfilmentStatus: direction }, { id: 'asc' }];
    case 'paymentStatus':
      return [{ paymentStatus: direction }, { id: 'asc' }];
    case 'total':
      return [{ total: direction }, { id: 'asc' }];
  }
}

function emptyPage(query: OrderListQuery) {
  return { orders: [], page: query.page, pageSize: query.pageSize, total: 0 };
}

type MemberNames = ReadonlyMap<string, string>;

async function memberNames(
  tx: TenantTransaction,
  companyId: string,
  userIds: readonly (string | null | undefined)[],
): Promise<MemberNames> {
  const ids = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await tx.membership.findMany({
    where: { companyId, userId: { in: ids } },
    select: { userId: true, user: { select: { displayName: true } } },
  });
  return new Map(rows.map((row) => [row.userId, row.user.displayName]));
}

function named(userId: string | null, names: MemberNames): { userId: string; displayName: string } | null {
  if (!userId) {
    return null;
  }
  const displayName = names.get(userId);
  if (displayName === undefined) {
    return null;
  }
  return { userId, displayName };
}

async function presentOrder(tx: TenantTransaction, ctx: RequestContext, row: OrderRow) {
  const names = await memberNames(tx, ctx.companyId, [
    row.assignedToUserId,
    ...(row.notes ?? []).map((note) => note.authorUserId),
  ]);
  return orderDetail(row, ctx, await printState(tx, ctx.companyId, row.id), names);
}

function orderSummary(row: OrderRow, names: MemberNames) {
  return {
    id: row.id,
    storeId: row.storeId,
    connectionId: row.connectionId,
    externalId: row.externalId,
    externalNumber: row.externalNumber,
    sourcePlatform: row.sourcePlatform,
    sourceCreatedAt: iso(row.sourceCreatedAt),
    sourceUpdatedAt: iso(row.sourceUpdatedAt),
    paymentStatus: row.paymentStatus,
    fulfilmentStatus: row.fulfilmentStatus,
    integrationStatus: row.integrationStatus,
    reviewReason: row.reviewReason,
    attentionReasons: row.attentionReasons,
    deliveryMethod: row.deliveryMethod,
    currency: row.currency,
    subtotal: fixed(row.subtotal, 2),
    shippingTotal: fixed(row.shippingTotal, 2),
    taxTotal: fixed(row.taxTotal, 2),
    total: fixed(row.total, 2),
    assignedToUserId: row.assignedToUserId,
    assignedTo: named(row.assignedToUserId, names),
    version: row.version,
    customer: customerSummary(row.customer),
  };
}

function orderDetail(
  row: OrderRow,
  ctx: RequestContext,
  prints: { latest: Record<PrintType, PrintSlot | null>; firstPrintAvailable: Record<PrintType, boolean> },
  names: MemberNames,
) {
  const state = {
    fulfilmentStatus: fulfilmentOf(row.fulfilmentStatus),
    paymentStatus: paymentOf(row.paymentStatus),
    deliveryMethod: deliveryOf(row.deliveryMethod),
  };
  return {
    ...orderSummary(row, names),
    sourceStatus: jsonObject(row.sourceStatus),
    customer: jsonObject(row.customer),
    recipient: jsonObject(row.recipient),
    billingAddress: jsonObject(row.billingAddress),
    shippingLine: jsonObject(row.shippingLine),
    giftMessage: row.giftMessage,
    customerNote: row.customerNote,
    lines: (row.lines ?? []).map((line) => ({
      id: line.id,
      externalLineId: line.externalLineId,
      sku: line.sku,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: fixed(line.quantity, 4),
      unitPrice: fixed(line.unitPrice, 4),
      total: fixed(line.total, 2),
    })),
    notes: (row.notes ?? []).map((note) => noteView(note, names)),
    allowedTransitions: visibleTransitions(state, ctx, row.storeId, row.store?.locationId ?? ''),
    printJobs: prints.latest,
    firstPrintAvailable: prints.firstPrintAvailable,
    can: orderCapabilities(ctx.grants, row.storeId, row.store?.locationId ?? ''),
  };
}

export type OrderCan = {
  edit: boolean;
  claim: boolean;
  assign: boolean;
  cancel: boolean;
  downloadDocuments: boolean;
  printSubmit: boolean;
  printReprint: boolean;
  printConfirm: boolean;
};

/** Same `can(grants, permission, orderScopes)` check the order and print routes use. `claim` is claim or assign. */
export function orderCapabilities(grants: readonly Grant[], storeId: string, locationId: string): OrderCan {
  const scopes = orderScopes(storeId, locationId);
  return {
    edit: can(grants, 'order.edit', scopes),
    claim: can(grants, 'order.claim', scopes) || can(grants, 'order.assign', scopes),
    assign: can(grants, 'order.assign', scopes),
    cancel: can(grants, 'order.cancel', scopes),
    downloadDocuments: can(grants, 'document.download', scopes),
    printSubmit: can(grants, 'print.submit', scopes),
    printReprint: can(grants, 'print.reprint', scopes),
    printConfirm: can(grants, 'print.confirm', scopes),
  };
}

/** The grant check `assertAssignee` enforces: the member can view this order. */
export function assigneeGrantsAllow(grants: readonly Grant[], storeId: string, locationId: string): boolean {
  return can(grants, 'order.view', orderScopes(storeId, locationId));
}

/**
 * Assignee list: `assertAssignee`'s rule, plus `order.claim` or `order.transition` on the order.
 * The view check is the shared predicate so the list cannot offer someone assign would reject.
 */
export function assigneeCandidate(grants: readonly Grant[], storeId: string, locationId: string): boolean {
  const scopes = orderScopes(storeId, locationId);
  return (
    assigneeGrantsAllow(grants, storeId, locationId) &&
    (can(grants, 'order.claim', scopes) || can(grants, 'order.transition', scopes))
  );
}

function noteView(note: NoteRow, names: MemberNames) {
  return {
    id: note.id,
    body: note.body,
    authorUserId: note.authorUserId,
    authorDisplayName: names.get(note.authorUserId) ?? null,
    createdAt: note.createdAt.toISOString(),
  };
}

function visibleTransitions(
  state: { fulfilmentStatus: FulfilmentStatus; paymentStatus: PaymentStatus; deliveryMethod: DeliveryMethod },
  ctx: RequestContext,
  storeId: string,
  locationId: string,
): TransitionDecision[] {
  const scopes = orderScopes(storeId, locationId);
  if (!can(ctx.grants, 'order.transition', scopes)) {
    return [];
  }
  return allowedTransitions(state).filter((decision) => {
    if (!decision.requiredPermission) {
      return true;
    }
    return can(ctx.grants, decision.requiredPermission, scopes);
  });
}

function assertScope(
  grants: readonly Grant[],
  permission: string,
  scopes: readonly ResourceScope[],
  orderId: string,
  action: string,
): void {
  const decision = decideAccess(grants, permission, scopes);
  if (decision === 'allow') {
    return;
  }
  if (decision === 'not_found') {
    throw new CommerceError(404, 'out_of_scope', 'order', orderId, 'Not found', action, { permission });
  }
  throw new CommerceError(403, 'permission_missing', 'order', orderId, 'Forbidden', action, { permission });
}

function assertClaimOrAssign(grants: readonly Grant[], scopes: readonly ResourceScope[], orderId: string): void {
  const claim = decideAccess(grants, 'order.claim', scopes);
  const assign = decideAccess(grants, 'order.assign', scopes);
  if (claim === 'allow' || assign === 'allow') {
    return;
  }
  const missed = claim === 'not_found' || assign === 'not_found';
  throw new CommerceError(
    missed ? 404 : 403,
    missed ? 'out_of_scope' : 'permission_missing',
    'order',
    orderId,
    missed ? 'Not found' : 'Forbidden',
    'order.claimed',
    { permission: claim === 'not_found' ? 'order.claim' : 'order.assign' },
  );
}

function customerSummary(value: unknown): { displayName: string | null; email: string | null; phone: string | null } | null {
  const record = jsonObject(value);
  if (!record) {
    return null;
  }
  return { displayName: text(record['displayName']), email: text(record['email']), phone: text(record['phone']) };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = item;
  }
  return result;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function fulfilmentOf(value: string): FulfilmentStatus {
  if ((FULFILMENT_STATUSES as readonly string[]).includes(value)) {
    return value as FulfilmentStatus;
  }
  throw new Error('unexpected fulfilment status');
}

function paymentOf(value: string): PaymentStatus {
  if ((PAYMENT_STATUSES as readonly string[]).includes(value)) {
    return value as PaymentStatus;
  }
  throw new Error('unexpected payment status');
}

function deliveryOf(value: string): DeliveryMethod {
  if ((DELIVERY_METHODS as readonly string[]).includes(value)) {
    return value as DeliveryMethod;
  }
  throw new Error('unexpected delivery method');
}

function isPrintType(value: string): value is PrintType {
  return (PRINT_TYPES as readonly string[]).includes(value);
}
