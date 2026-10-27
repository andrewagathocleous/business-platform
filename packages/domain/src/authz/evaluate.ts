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
 * Who is acting on which membership, and whether the change would remove the
 * last active holder of company-wide `member.manage`.
 * Invitation creation has no target membership yet, so it omits this and only rule 1 applies.
 */
export type MembershipEscalation = {
  actorUserId: string;
  actorIsPlatformOwner: boolean;
  targetUserId: string;
  targetIsPlatformOwner: boolean;
  /** Active `member.manage` holders in the company, excluding the target membership. */
  otherActiveMemberManageCount: number;
  /** The change suspends, removes, or drops company-wide `member.manage` from the target. */
  withdrawsMemberManage: boolean;
};

export type EscalationDenial = 'self_modification' | 'platform_owner_target' | 'last_member_manage';

/**
 * Escalation rules 2–4. Rule 2 is self-modification, rule 3 is targeting a platform
 * owner, and rule 4 is withdrawing `member.manage` from the last active holder.
 * A platform owner is the exception to all three.
 */
export function membershipEscalationDenial(escalation: MembershipEscalation): EscalationDenial | null {
  if (escalation.actorUserId === escalation.targetUserId && !escalation.actorIsPlatformOwner) {
    return 'self_modification';
  }
  if (escalation.targetIsPlatformOwner && !escalation.actorIsPlatformOwner) {
    return 'platform_owner_target';
  }
  if (
    escalation.withdrawsMemberManage &&
    escalation.otherActiveMemberManageCount < 1 &&
    !escalation.actorIsPlatformOwner
  ) {
    return 'last_member_manage';
  }
  return null;
}

/**
 * Escalation rule 1: the actor must hold every permission in the target role
 * at the same scope or a broader one. Company is broader than store, location,
 * mailbox and integration account.
 * When `escalation` is passed, rules 2–4 apply as well.
 */
export function canGrant(
  actorGrants: readonly Grant[],
  targetRole: { readonly permissions: readonly string[] },
  scope: ResourceScope,
  escalation?: MembershipEscalation,
): boolean {
  const covered = targetRole.permissions.every((permission) => covers(actorGrants, permission, scope));
  if (!covered) {
    return false;
  }
  if (!escalation) {
    return true;
  }
  return membershipEscalationDenial(escalation) === null;
}

export type AccessDecision = 'allow' | 'not_found' | 'forbidden';

/**
 * Company-level check when `resourceScopes` is omitted: a miss is forbidden.
 * `null` means the resource is missing or hidden. A scope list that `can` does
 * not cover is not_found when the actor holds the permission somewhere else
 * (out of scope) and forbidden when they do not hold it at all.
 */
export function decideAccess(
  grants: readonly Grant[],
  permission: string,
  resourceScopes?: readonly ResourceScope[] | null,
): AccessDecision {
  if (resourceScopes === null) {
    return 'not_found';
  }
  if (resourceScopes === undefined) {
    return can(grants, permission) ? 'allow' : 'forbidden';
  }
  if (can(grants, permission, resourceScopes)) {
    return 'allow';
  }
  const holdsPermission = grants.some((grant) => grant.permission === permission);
  return holdsPermission ? 'not_found' : 'forbidden';
}

export type ScopeFilter =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'ids'; ids: string[] };

/** List filter for a scopable permission. Company-wide grant means no id filter. */
export function permittedScopeFilter(
  grants: readonly Grant[],
  permission: string,
  scopeType: Exclude<ScopeType, 'company'>,
): ScopeFilter {
  if (grants.some((grant) => grant.permission === permission && grant.scopeType === 'company')) {
    return { kind: 'all' };
  }
  const ids = grants.flatMap((grant) =>
    grant.permission === permission && grant.scopeType === scopeType && grant.scopeId ? [grant.scopeId] : [],
  );
  if (ids.length === 0) {
    return { kind: 'none' };
  }
  return { kind: 'ids', ids };
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
