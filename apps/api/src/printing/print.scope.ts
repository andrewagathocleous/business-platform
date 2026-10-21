import type { TenantTransaction } from '@bp/db';
import { can, permittedScopeFilter, type ResourceScope } from '@bp/domain';
import type { Request } from 'express';
import { isUuid } from '../authz/company-path';
import type { ScopeResolver } from '../authz/require-permission.decorator';
import type { RequestContext } from '../authz/request-context';
import { orderScopes } from '../orders/order.scope';

/**
 * A bad `sourceId` stays in the caller's own scopes so the service can return 400.
 * A real id that is not this company's order is not found.
 * A reprint is judged with `print.reprint`.
 */
export const printRequestScope: ScopeResolver = async (request, ctx, tx) => {
  const body = isRecord(request.body) ? request.body : {};
  const reprint = body.reprint != null;
  const permission = reprint ? 'print.reprint' : 'print.submit';
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
  if (!isUuid(sourceId)) {
    return { found: true, scopes: grantScopes(ctx, permission), permission };
  }
  const order = await tx.salesOrder.findFirst({
    where: { id: sourceId.toLowerCase(), companyId: ctx.companyId },
    select: { storeId: true },
  });
  if (!order) {
    return { found: false };
  }
  const store = await tx.store.findFirst({
    where: { id: order.storeId, companyId: ctx.companyId },
    select: { locationId: true },
  });
  if (!store) {
    return { found: false };
  }
  return { found: true, scopes: orderScopes(order.storeId, store.locationId), permission };
};

/**
 * Company-wide `automation.view` or `print.submit` sees every job.
 * A store or location grant of `print.submit` sees that scope.
 * `print.confirm` does not widen the list.
 */
export const printListScope: ScopeResolver = (_request, ctx) => {
  if (can(ctx.grants, 'automation.view') || can(ctx.grants, 'print.submit')) {
    return Promise.resolve({ found: true, scopes: [{ type: 'company', id: null }] });
  }
  return Promise.resolve({ found: true, scopes: grantScopes(ctx, 'print.submit') });
};

export const printJobScope: ScopeResolver = (request, ctx, tx) => printJobResource(request, ctx, tx);

export const printerListScope: ScopeResolver = (_request, ctx) => {
  if (can(ctx.grants, 'printer.manage') || can(ctx.grants, 'print.submit')) {
    return Promise.resolve({ found: true, scopes: [{ type: 'company', id: null }] });
  }
  return Promise.resolve({ found: true, scopes: grantScopes(ctx, 'print.submit') });
};

async function printJobResource(
  request: Request,
  ctx: RequestContext,
  tx: TenantTransaction,
): Promise<Awaited<ReturnType<ScopeResolver>>> {
  const id = request.params['id'];
  if (typeof id !== 'string' || !isUuid(id)) {
    return { found: false };
  }
  const job = await tx.printJob.findFirst({
    where: { id: id.toLowerCase(), companyId: ctx.companyId },
    select: { sourceType: true, sourceId: true },
  });
  if (!job) {
    return { found: false };
  }
  if (job.sourceType !== 'order') {
    return { found: true, scopes: [{ type: 'company', id: null }] };
  }
  const order = await tx.salesOrder.findFirst({
    where: { id: job.sourceId, companyId: ctx.companyId },
    select: { storeId: true },
  });
  if (!order) {
    return { found: false };
  }
  const store = await tx.store.findFirst({
    where: { id: order.storeId, companyId: ctx.companyId },
    select: { locationId: true },
  });
  if (!store) {
    return { found: false };
  }
  return { found: true, scopes: orderScopes(order.storeId, store.locationId) };
}

function grantScopes(ctx: RequestContext, permission: string): ResourceScope[] {
  const stores = permittedScopeFilter(ctx.grants, permission, 'store');
  const locations = permittedScopeFilter(ctx.grants, permission, 'location');
  if (stores.kind === 'all' || locations.kind === 'all') {
    return [{ type: 'company', id: null }];
  }
  const scopes: ResourceScope[] = [];
  if (stores.kind === 'ids') {
    for (const id of stores.ids) {
      scopes.push({ type: 'store', id });
    }
  }
  if (locations.kind === 'ids') {
    for (const id of locations.ids) {
      scopes.push({ type: 'location', id });
    }
  }
  if (scopes.length === 0) {
    return [{ type: 'company', id: null }];
  }
  return scopes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
