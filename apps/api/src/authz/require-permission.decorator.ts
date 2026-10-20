import { SetMetadata } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { permissionByKey, type ResourceScope } from '@bp/domain';
import type { Request } from 'express';
import type { RequestContext } from './request-context';

export const REQUIRE_PERMISSION_KEY = 'bp:permission';

export type ResolvedResource =
  | { found: false }
  | { found: true; scopes: readonly ResourceScope[] };

/** Store-scoped checks resolve the resource under RLS, then `decideAccess` runs. */
export type ScopeResolver = (
  request: Request,
  context: RequestContext,
  tx: TenantTransaction,
) => Promise<ResolvedResource>;

export type RequiredPermission = {
  permission: string;
  scope?: ScopeResolver;
};

export function RequirePermission(
  permission: string,
  options?: { scope?: ScopeResolver },
): MethodDecorator {
  if (!permissionByKey(permission)) {
    throw new Error(`Unknown permission "${permission}"`);
  }
  const metadata: RequiredPermission = { permission, scope: options?.scope };
  return SetMetadata(REQUIRE_PERMISSION_KEY, metadata);
}
