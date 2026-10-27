import { decideAccess, type AccessDecision, type Grant, type ResourceScope } from '@bp/domain';
import type { ResolvedResource } from './require-permission.decorator';

/**
 * Runs a resource resolver, then applies scope rules.
 * A resolved store outside the caller's grants is `not_found`.
 */
export async function resolvePermission(
  grants: readonly Grant[],
  permission: string,
  resolve: () => Promise<ResolvedResource>,
): Promise<AccessDecision> {
  const resolved = await resolve();
  if (!resolved.found) {
    return 'not_found';
  }
  return decideAccess(grants, permission, resolved.scopes);
}

export function scopesOf(id: string): readonly ResourceScope[] {
  return [{ type: 'store', id }];
}
