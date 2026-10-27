import type { TenantTransaction } from '@bp/db';
import type { Request } from 'express';
import { isUuid } from '../authz/company-path';
import type { ResolvedResource, ScopeResolver } from '../authz/require-permission.decorator';
import type { RequestContext } from '../authz/request-context';
import { orderScopes } from '../orders/order.scope';

/**
 * The file row is read under RLS first. The permission is chosen from the kind:
 * invoice PDFs need `invoice.view` at company scope; packing slips and gift
 * messages need `document.download` on the source order's store and location;
 * a test print needs `document.download` at company scope.
 */
export const fileResourceScope: ScopeResolver = (request, ctx, tx) =>
  fileResource(request, ctx, tx);

async function fileResource(
  request: Request,
  ctx: RequestContext,
  tx: TenantTransaction,
): Promise<ResolvedResource> {
  const id = request.params['id'];
  if (typeof id !== 'string' || !isUuid(id)) {
    return { found: false };
  }
  const file = await tx.storedFile.findFirst({
    where: { id: id.toLowerCase(), companyId: ctx.companyId },
    select: { kind: true, sourceType: true, sourceId: true },
  });
  if (!file) {
    return { found: false };
  }
  return accessForStoredFile(file.kind, {
    sourceType: file.sourceType,
    sourceId: file.sourceId,
    order: await orderForFile(tx, ctx.companyId, file.kind, file.sourceType, file.sourceId),
  });
}

export type StoredFileOrder = {
  storeId: string;
  locationId: string;
};

/**
 * Every stored kind is named. An unknown kind, or a packing slip or gift
 * message whose order cannot be resolved, is a miss.
 */
export function accessForStoredFile(
  kind: string,
  source: { sourceType: string | null; sourceId: string | null; order: StoredFileOrder | null },
): ResolvedResource {
  if (kind === 'invoice_pdf') {
    return { found: true, scopes: [{ type: 'company', id: null }], permission: 'invoice.view' };
  }
  if (kind === 'test_print') {
    return {
      found: true,
      scopes: [{ type: 'company', id: null }],
      permission: 'document.download',
    };
  }
  if (kind === 'packing_slip' || kind === 'gift_message') {
    if (
      source.sourceType !== 'order' ||
      source.sourceId === null ||
      source.sourceId.length === 0 ||
      source.order === null
    ) {
      return { found: false };
    }
    return {
      found: true,
      scopes: orderScopes(source.order.storeId, source.order.locationId),
      permission: 'document.download',
    };
  }
  return { found: false };
}

async function orderForFile(
  tx: TenantTransaction,
  companyId: string,
  kind: string,
  sourceType: string | null,
  sourceId: string | null,
): Promise<StoredFileOrder | null> {
  if (
    (kind !== 'packing_slip' && kind !== 'gift_message') ||
    sourceType !== 'order' ||
    sourceId === null ||
    sourceId.length === 0
  ) {
    return null;
  }
  const order = await tx.salesOrder.findFirst({
    where: { id: sourceId, companyId },
    select: { storeId: true, store: { select: { locationId: true } } },
  });
  if (!order) {
    return null;
  }
  return { storeId: order.storeId, locationId: order.store.locationId };
}
