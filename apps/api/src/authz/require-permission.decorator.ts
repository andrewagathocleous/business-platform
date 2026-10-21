import { SetMetadata } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { permissionByKey, type ResourceScope } from '@bp/domain';
import type { Request } from 'express';
import type { RequestContext } from './request-context';

export const REQUIRE_PERMISSION_KEY = 'bp:permission';

export type ResolvedResource =
  | { found: false }
  | {
      found: true;
      scopes: readonly ResourceScope[];
      /**
       * When set, only this permission is checked. It must be the route permission
       * or one of `anyOf`. File downloads use it so an invoice file is judged with
       * `invoice.view` and a packing slip with `document.download`, after RLS.
       */
      permission?: string;
    };

/** Store-scoped checks resolve the resource under RLS, then `decideAccess` runs. */
export type ScopeResolver = (
  request: Request,
  context: RequestContext,
  tx: TenantTransaction,
) => Promise<ResolvedResource>;

export type RequiredPermission = {
  permission: string;
  /** Any one of these also allows the route. Each is checked against the same scopes. */
  anyOf?: readonly string[];
  scope?: ScopeResolver;
};

export function RequirePermission(
  permission: string,
  options?: { scope?: ScopeResolver; anyOf?: readonly string[] },
): MethodDecorator {
  const keys = [permission, ...(options?.anyOf ?? [])];
  for (const key of keys) {
    if (!permissionByKey(key)) {
      throw new Error(`Unknown permission "${key}"`);
    }
  }
  const metadata: RequiredPermission = {
    permission,
    ...(options?.anyOf !== undefined ? { anyOf: options.anyOf } : {}),
    ...(options?.scope !== undefined ? { scope: options.scope } : {}),
  };
  return SetMetadata(REQUIRE_PERMISSION_KEY, metadata);
}
