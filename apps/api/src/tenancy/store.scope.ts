import type { TenantTransaction } from '@bp/db';
import { permittedScopeFilter } from '@bp/domain';
import type { Request } from 'express';
import { isUuid } from '../authz/company-path';
import type { ScopeResolver } from '../authz/require-permission.decorator';
import type { RequestContext } from '../authz/request-context';

/** Company-wide `store.view` sees every store. A store grant sees that store. */
export const storeListScope: ScopeResolver = (_request, ctx) => {
  const stores = permittedScopeFilter(ctx.grants, 'store.view', 'store');
  if (stores.kind === 'all') {
    return Promise.resolve({ found: true, scopes: [{ type: 'company', id: null }] });
  }
  if (stores.kind === 'ids') {
    return Promise.resolve({
      found: true,
      scopes: stores.ids.map((id) => ({ type: 'store' as const, id })),
    });
  }
  return Promise.resolve({ found: true, scopes: [] });
};

export const storeResourceScope: ScopeResolver = (request, ctx, tx) => storeResource(request, ctx, tx);

async function storeResource(
  request: Request,
  ctx: RequestContext,
  tx: TenantTransaction,
): Promise<Awaited<ReturnType<ScopeResolver>>> {
  const id = request.params['id'];
  if (typeof id !== 'string' || !isUuid(id)) {
    return { found: false };
  }
  const store = await tx.store.findFirst({
    where: { id: id.toLowerCase(), companyId: ctx.companyId },
    select: { id: true },
  });
  if (!store) {
    return { found: false };
  }
  return { found: true, scopes: [{ type: 'store', id: store.id }] };
}
