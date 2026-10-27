import type { TenantTransaction } from '@bp/db';
import { permittedScopeFilter, type ResourceScope } from '@bp/domain';
import type { Request } from 'express';
import { isUuid } from '../authz/company-path';
import type { ScopeResolver } from '../authz/require-permission.decorator';
import type { RequestContext } from '../authz/request-context';

/** An order carries its store and that store's location. Either grant matches. */
export function orderScopes(storeId: string, locationId: string): ResourceScope[] {
  return [
    { type: 'store', id: storeId },
    { type: 'location', id: locationId },
  ];
}

/**
 * Company-wide viewers see every store. A store grant sees that store.
 * A location grant sees the stores at that location. No grant is forbidden.
 */
export const orderListScope: ScopeResolver = (_request, ctx) => {
  const stores = permittedScopeFilter(ctx.grants, 'order.view', 'store');
  const locations = permittedScopeFilter(ctx.grants, 'order.view', 'location');
  if (stores.kind === 'all' || locations.kind === 'all') {
    return Promise.resolve({ found: true, scopes: [{ type: 'company', id: null }] });
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
  return Promise.resolve({ found: true, scopes });
};

export const orderResourceScope: ScopeResolver = (request, ctx, tx) => orderResource(request, ctx, tx);

async function orderResource(
  request: Request,
  ctx: RequestContext,
  tx: TenantTransaction,
): Promise<Awaited<ReturnType<ScopeResolver>>> {
  const id = request.params['id'];
  if (typeof id !== 'string' || !isUuid(id)) {
    return { found: false };
  }
  const order = await tx.salesOrder.findFirst({
    where: { id: id.toLowerCase(), companyId: ctx.companyId },
    select: { storeId: true, store: { select: { locationId: true } } },
  });
  if (!order) {
    return { found: false };
  }
  return { found: true, scopes: orderScopes(order.storeId, order.store.locationId) };
}
