import { permissionByKey, type ScopableScope } from './permissions';

export const SCOPE_TYPES = [
  'company',
  'store',
  'location',
  'mailbox',
  'integration_account',
] as const;

export type ScopeType = (typeof SCOPE_TYPES)[number];

export type Grant = {
  permission: string;
  scopeType: ScopeType;
  scopeId: string | null;
};

export type ResourceScope = {
  type: ScopeType;
  id: string | null;
};

/**
 * A company-wide grant covers every resource. A scoped grant covers only a resource
 * that carries the same scope. With no resource scope, only a company-wide grant matches,
 * so a store-scoped order.view does not grant access to company-level resources.
 */
export function can(
  grants: readonly Grant[],
  permission: string,
  resourceScope?: ResourceScope | readonly ResourceScope[],
): boolean {
  const matching = grants.filter((grant) => grant.permission === permission);
  if (matching.some((grant) => grant.scopeType === 'company')) {
    return true;
  }
  const scopes = normaliseScopes(resourceScope);
  return scopes.some(
    (scope) =>
      scope.type !== 'company' &&
      matching.some((grant) => grant.scopeType === scope.type && grant.scopeId === scope.id),
  );
}

/**
 * Escalation rule 1: the actor must hold every permission in the target role
 * at the same scope or a broader one. Company is broader than store, location,
 * mailbox and integration account. Rules that need the actor's identity
 * (no self-modification, platform owners, last administrator) are enforced by the API.
 */
export function canGrant(
  actorGrants: readonly Grant[],
  targetRole: { readonly permissions: readonly string[] },
  scope: ResourceScope,
): boolean {
  return targetRole.permissions.every((permission) => covers(actorGrants, permission, scope));
}

/**
 * Expands one role assignment into grants.
 * A company assignment grants every permission in the role.
 * A narrower assignment grants only permissions whose scopableBy includes that scope type.
 */
export function grantsForAssignment(
  permissions: readonly string[],
  scope: ResourceScope,
): Grant[] {
  if (scope.type === 'company') {
    return permissions.map((permission) => ({
      permission,
      scopeType: 'company' as const,
      scopeId: null,
    }));
  }
  const scopeType: ScopableScope = scope.type;
  return permissions.flatMap((permission) => {
    const definition = permissionByKey(permission);
    if (!definition?.scopableBy.includes(scopeType)) {
      return [];
    }
    return [{ permission, scopeType, scopeId: scope.id }];
  });
}

function covers(grants: readonly Grant[], permission: string, scope: ResourceScope): boolean {
  const matching = grants.filter((grant) => grant.permission === permission);
  if (matching.some((grant) => grant.scopeType === 'company')) {
    return true;
  }
  if (scope.type === 'company') {
    return false;
  }
  return matching.some((grant) => grant.scopeType === scope.type && grant.scopeId === scope.id);
}

function isScopeList(
  value: ResourceScope | readonly ResourceScope[],
): value is readonly ResourceScope[] {
  return Array.isArray(value);
}

function normaliseScopes(
  resourceScope: ResourceScope | readonly ResourceScope[] | undefined,
): readonly ResourceScope[] {
  if (resourceScope === undefined) {
    return [];
  }
  return isScopeList(resourceScope) ? resourceScope : [resourceScope];
}
