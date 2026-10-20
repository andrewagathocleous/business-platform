import type { TenantTransaction } from '@bp/db';
import { can, grantsForAssignment, PERMISSIONS, type Grant, type ResourceScope } from '@bp/domain';

export function platformOwnerGrants(): Grant[] {
  return PERMISSIONS.filter((permission) => !permission.automationOnly).map((permission) => ({
    permission: permission.key,
    scopeType: 'company' as const,
    scopeId: null,
  }));
}

export function dedupeGrants(grants: readonly Grant[]): Grant[] {
  const seen = new Set<string>();
  const result: Grant[] = [];
  for (const grant of grants) {
    const key = `${grant.permission}\u0000${grant.scopeType}\u0000${grant.scopeId ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ permission: grant.permission, scopeType: grant.scopeType, scopeId: grant.scopeId });
  }
  result.sort((left, right) => {
    const byPermission = left.permission.localeCompare(right.permission);
    if (byPermission !== 0) {
      return byPermission;
    }
    const byScope = left.scopeType.localeCompare(right.scopeType);
    if (byScope !== 0) {
      return byScope;
    }
    return (left.scopeId ?? '').localeCompare(right.scopeId ?? '');
  });
  return result;
}

export async function grantsForMembership(db: TenantTransaction, membershipId: string): Promise<Grant[]> {
  const assignments = await db.membershipRole.findMany({
    where: { membershipId },
    include: { role: { include: { permissions: true } } },
  });
  return dedupeGrants(
    assignments.flatMap((assignment) =>
      grantsForAssignment(
        assignment.role.permissions.map((permission) => permission.permission),
        toResourceScope(assignment.scopeType, assignment.scopeId),
      ),
    ),
  );
}

export function holdsMemberManage(grants: readonly Grant[]): boolean {
  return can(grants, 'member.manage');
}

export function toResourceScope(scopeType: string, scopeId: string | null): ResourceScope {
  if (
    scopeType === 'company' ||
    scopeType === 'store' ||
    scopeType === 'location' ||
    scopeType === 'mailbox' ||
    scopeType === 'integration_account'
  ) {
    return { type: scopeType, id: scopeId };
  }
  return { type: 'company', id: null };
}
