import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import {
  can,
  canGrant,
  grantsForAssignment,
  membershipEscalationDenial,
  type Grant,
  type MembershipEscalation,
} from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { CompanyAccessService } from '../authz/company-access.service';
import { isUuid } from '../authz/company-path';
import { dedupeGrants, grantsForMembership, holdsMemberManage, toResourceScope } from '../authz/load-grants';
import type { RequestContext } from '../authz/request-context';
import { clockNow, CLOCK, type Clock } from '../identity/clock';
import type { RequestMeta } from '../identity/request-meta';
import { PrismaService } from '../database/prisma.service';

export type RoleAssignmentInput = {
  roleKey: string;
  scopeType: 'company' | 'store' | 'location' | 'mailbox' | 'integration_account';
  scopeId: string | null;
};

export type MembershipPatch = {
  status?: 'active' | 'suspended' | 'removed';
  assignments?: RoleAssignmentInput[];
};

export type MemberAssignmentView = {
  roleKey: string;
  roleName: string;
  scopeType: string;
  scopeId: string | null;
};

export type MemberView = {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  status: string;
  userStatus: string;
  isPlatformOwner: boolean;
  assignments: MemberAssignmentView[];
};

type ResolvedAssignment = RoleAssignmentInput & {
  roleId: string;
  permissions: string[];
};

class MembershipDenied extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly reason: string,
    readonly companyId: string | null,
    readonly objectType: string,
    readonly objectId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'MembershipDenied';
  }
}

const memberInclude = {
  user: true,
  roles: { include: { role: { include: { permissions: true } } } },
} as const;

type LoadedMembership = {
  id: string;
  userId: string;
  companyId: string;
  status: string;
  user: { id: string; email: string; displayName: string; status: string; isPlatformOwner: boolean };
  roles: {
    scopeType: string;
    scopeId: string | null;
    role: { key: string; name: string; permissions: { permission: string }[] };
  }[];
};

@Injectable()
export class MembershipService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CompanyAccessService) private readonly companyAccess: CompanyAccessService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(companyId: string): Promise<MemberView[]> {
    const rows = await this.prisma.client.membership.findMany({
      where: { companyId },
      include: memberInclude,
      orderBy: [{ user: { email: 'asc' } }, { id: 'asc' }],
    });
    return rows.map((row) => toMemberView(row));
  }

  async get(ctx: RequestContext, membershipId: string): Promise<MemberView> {
    if (!isUuid(membershipId)) {
      await this.auditMissing(ctx, null);
      throw new NotFoundException('Not found');
    }
    const row = await this.prisma.client.membership.findFirst({
      where: { id: membershipId, companyId: ctx.companyId },
      include: memberInclude,
    });
    if (!row) {
      await this.auditMissing(ctx, membershipId);
      throw new NotFoundException('Not found');
    }
    return toMemberView(row);
  }

  async update(ctx: RequestContext, membershipId: string, patch: MembershipPatch, meta: RequestMeta): Promise<MemberView> {
    const actorId = this.actorId(ctx);
    try {
      return await this.prisma.client.$transaction(
        (tx) => this.updateLocked(tx, ctx, actorId, membershipId, patch, meta),
        { timeout: 15_000 },
      );
    } catch (error) {
      if (error instanceof MembershipDenied) {
        await this.finishDenied(ctx, meta, error);
      }
      throw error;
    }
  }

  async revokeSessions(ctx: RequestContext, membershipId: string, meta: RequestMeta): Promise<{ revoked: number }> {
    const actorId = this.actorId(ctx);
    try {
      return await this.prisma.client.$transaction(
        (tx) => this.revokeLocked(tx, ctx, actorId, membershipId, meta),
        { timeout: 15_000 },
      );
    } catch (error) {
      if (error instanceof MembershipDenied) {
        await this.finishDenied(ctx, meta, error);
      }
      throw error;
    }
  }

  private async updateLocked(
    tx: TenantTransaction,
    ctx: RequestContext,
    actorId: string,
    membershipId: string,
    patch: MembershipPatch,
    meta: RequestMeta,
  ): Promise<MemberView> {
    await this.lockCompany(tx, ctx.companyId);
    const actor = await this.acting(tx, ctx, actorId, 'member.manage', membershipId);
    const target = await this.loadTarget(tx, ctx.companyId, membershipId);
    const currentGrants = grantsOf(target);
    const nextStatus = patch.status ?? target.status;
    const resolved = patch.assignments ? await this.resolveAssignments(tx, ctx.companyId, patch.assignments) : null;
    const nextGrants = resolved ? grantsOfAssignments(resolved) : currentGrants;
    const holders = await this.memberManageHolders(tx, ctx.companyId);
    const currentlyHolds = holders.has(target.id);
    const nextHolds = nextStatus === 'active' && target.user.status === 'active' && holdsMemberManage(nextGrants);
    const escalation: MembershipEscalation = {
      actorUserId: actorId,
      actorIsPlatformOwner: actor.isPlatformOwner,
      targetUserId: target.userId,
      targetIsPlatformOwner: target.user.isPlatformOwner,
      otherActiveMemberManageCount: otherHolders(holders, target.id),
      withdrawsMemberManage: currentlyHolds && !nextHolds,
    };
    const denial = membershipEscalationDenial(escalation);
    if (denial) {
      throw new MembershipDenied(403, denial, ctx.companyId, 'membership', target.id, 'Forbidden');
    }
    if (resolved) {
      for (const assignment of resolved) {
        const allowed = canGrant(actor.grants, { permissions: assignment.permissions }, {
          type: assignment.scopeType,
          id: assignment.scopeId,
        });
        if (!allowed) {
          throw new MembershipDenied(403, 'grant_not_allowed', ctx.companyId, 'membership', target.id, 'Forbidden');
        }
      }
    }
    const now = clockNow(this.clock);
    if (patch.status && patch.status !== target.status) {
      // Company is already locked. Lock the user next so two companies suspending
      // the same person cannot both observe the other membership as still active.
      await this.lockUser(tx, target.userId);
      await tx.membership.update({
        where: { id: target.id },
        data: statusWrite(patch.status, now),
      });
      if (patch.status === 'suspended') {
        await this.revokeIfSoleCompany(tx, target.userId, target.id, now);
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        actorType: 'user',
        actorId,
        actorLabel: actor.actorLabel,
        action: statusAction(patch.status),
        objectType: 'membership',
        objectId: target.id,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { from: target.status, to: patch.status },
      });
    }
    if (resolved) {
      await tx.membershipRole.deleteMany({ where: { membershipId: target.id } });
      for (const assignment of resolved) {
        await tx.membershipRole.create({
          data: {
            membershipId: target.id,
            roleId: assignment.roleId,
            scopeType: assignment.scopeType,
            scopeId: assignment.scopeId,
            grantedById: actorId,
          },
        });
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        actorType: 'user',
        actorId,
        actorLabel: actor.actorLabel,
        action: 'membership.roles_updated',
        objectType: 'membership',
        objectId: target.id,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: {
          assignments: resolved.map((assignment) => ({
            roleKey: assignment.roleKey,
            scopeType: assignment.scopeType,
            scopeId: assignment.scopeId,
          })),
        },
      });
    }
    const saved = await tx.membership.findFirstOrThrow({
      where: { id: target.id },
      include: memberInclude,
    });
    return toMemberView(saved);
  }

  private async revokeLocked(
    tx: TenantTransaction,
    ctx: RequestContext,
    actorId: string,
    membershipId: string,
    meta: RequestMeta,
  ): Promise<{ revoked: number }> {
    await this.lockCompany(tx, ctx.companyId);
    const actor = await this.acting(tx, ctx, actorId, 'member.sessions.revoke', membershipId);
    const target = await this.loadTarget(tx, ctx.companyId, membershipId);
    const denial = membershipEscalationDenial({
      actorUserId: actorId,
      actorIsPlatformOwner: actor.isPlatformOwner,
      targetUserId: target.userId,
      targetIsPlatformOwner: target.user.isPlatformOwner,
      otherActiveMemberManageCount: 1,
      withdrawsMemberManage: false,
    });
    if (denial) {
      throw new MembershipDenied(403, denial, ctx.companyId, 'membership', target.id, 'Forbidden');
    }
    const now = clockNow(this.clock);
    const revoked = await tx.userSession.updateMany({
      where: { userId: target.userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'member.sessions.revoke' },
    });
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId,
      actorLabel: actor.actorLabel,
      action: 'member.sessions.revoked',
      objectType: 'membership',
      objectId: target.id,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { userId: target.userId, revoked: revoked.count },
    });
    return { revoked: revoked.count };
  }

  private async lockUser(tx: TenantTransaction, userId: string): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM user_account WHERE id = CAST(${userId} AS uuid) FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new MembershipDenied(404, 'user_not_found', null, 'user_account', userId, 'Not found');
    }
  }

  private async lockCompany(tx: TenantTransaction, companyId: string): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM company WHERE id = CAST(${companyId} AS uuid) FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new MembershipDenied(404, 'company_not_found', null, 'company', companyId, 'Not found');
    }
    await tx.$queryRaw`SELECT set_config('app.company_id', ${companyId}, true)`;
  }

  private async acting(
    tx: TenantTransaction,
    ctx: RequestContext,
    actorId: string,
    permission: string,
    membershipId: string,
  ): Promise<{ grants: Grant[]; isPlatformOwner: boolean; actorLabel: string | null }> {
    const access = await this.companyAccess.loadStaffAccess(tx, {
      userId: actorId,
      mfaSatisfied: ctx.mfaSatisfied,
      companyId: ctx.companyId,
    });
    if (!access.ok) {
      throw new MembershipDenied(404, access.reason, access.companyId, 'membership', membershipId, 'Not found');
    }
    if (!can(access.context.grants, permission)) {
      throw new MembershipDenied(403, 'permission_missing', ctx.companyId, 'membership', membershipId, 'Forbidden');
    }
    return {
      grants: access.context.grants,
      isPlatformOwner: access.context.isPlatformOwner,
      actorLabel: access.context.actorLabel,
    };
  }

  private async loadTarget(tx: TenantTransaction, companyId: string, membershipId: string): Promise<LoadedMembership> {
    if (!isUuid(membershipId)) {
      throw new MembershipDenied(404, 'membership_not_found', companyId, 'membership', null, 'Not found');
    }
    const target = await tx.membership.findFirst({
      where: { id: membershipId, companyId },
      include: memberInclude,
    });
    if (!target) {
      throw new MembershipDenied(404, 'membership_not_found', companyId, 'membership', membershipId, 'Not found');
    }
    return target;
  }

  private async resolveAssignments(
    tx: TenantTransaction,
    companyId: string,
    assignments: RoleAssignmentInput[],
  ): Promise<ResolvedAssignment[]> {
    const seen = new Set<string>();
    const resolved: ResolvedAssignment[] = [];
    for (const assignment of assignments) {
      const key = `${assignment.roleKey}\u0000${assignment.scopeType}\u0000${assignment.scopeId ?? ''}`;
      if (seen.has(key)) {
        throw new MembershipDenied(400, 'duplicate_assignment', companyId, 'role', null, 'duplicate role assignment');
      }
      seen.add(key);
      const role = await tx.role.findUnique({
        where: { companyId_key: { companyId, key: assignment.roleKey } },
        include: { permissions: true },
      });
      if (!role) {
        throw new MembershipDenied(400, 'unknown_role', companyId, 'role', null, 'Unknown role');
      }
      await this.assertScope(tx, companyId, assignment);
      resolved.push({
        ...assignment,
        roleId: role.id,
        permissions: role.permissions.map((permission) => permission.permission),
      });
    }
    return resolved;
  }

  private async assertScope(tx: TenantTransaction, companyId: string, assignment: RoleAssignmentInput): Promise<void> {
    if (assignment.scopeType === 'company') {
      return;
    }
    if (assignment.scopeType === 'mailbox' || assignment.scopeType === 'integration_account') {
      throw new MembershipDenied(400, 'scope_not_supported', companyId, 'role', null, 'scope type is not supported');
    }
    const scopeId = assignment.scopeId;
    if (!scopeId) {
      throw new MembershipDenied(400, 'invalid_scope', companyId, 'role', null, 'scope id is required');
    }
    if (assignment.scopeType === 'store') {
      const store = await tx.store.findFirst({ where: { id: scopeId, companyId } });
      if (!store) {
        throw new MembershipDenied(404, 'scope_not_found', companyId, 'store', scopeId, 'Not found');
      }
      return;
    }
    const location = await tx.location.findFirst({ where: { id: scopeId, companyId } });
    if (!location) {
      throw new MembershipDenied(404, 'scope_not_found', companyId, 'location', scopeId, 'Not found');
    }
  }

  private async memberManageHolders(tx: TenantTransaction, companyId: string): Promise<Set<string>> {
    const memberships = await tx.membership.findMany({
      where: { companyId, status: 'active', user: { status: 'active' } },
      select: { id: true },
    });
    const holders = new Set<string>();
    for (const membership of memberships) {
      const grants = await grantsForMembership(tx, membership.id);
      if (holdsMemberManage(grants)) {
        holders.add(membership.id);
      }
    }
    return holders;
  }

  private async revokeIfSoleCompany(
    tx: TenantTransaction,
    userId: string,
    membershipId: string,
    now: Date,
  ): Promise<void> {
    const others = await tx.membership.count({
      where: { userId, status: 'active', id: { not: membershipId } },
    });
    if (others > 0) {
      return;
    }
    await tx.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'membership_suspended' },
    });
  }

  private actorId(ctx: RequestContext): string {
    if (!ctx.userId) {
      throw new ForbiddenException('Forbidden');
    }
    return ctx.userId;
  }

  private async finishDenied(ctx: RequestContext, meta: RequestMeta, error: MembershipDenied): Promise<never> {
    if (error.status !== 400) {
      await this.audit.recordDenial({
        companyId: error.companyId,
        actorType: 'user',
        actorId: ctx.userId,
        actorLabel: ctx.actorLabel,
        action: 'authorization.denied',
        objectType: error.objectType,
        objectId: error.objectId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { reason: error.reason, companyId: ctx.companyId },
      });
    }
    if (error.status === 404) {
      throw new NotFoundException('Not found');
    }
    if (error.status === 400) {
      throw new BadRequestException(error.message);
    }
    throw new ForbiddenException('Forbidden');
  }

  private async auditMissing(ctx: RequestContext, membershipId: string | null): Promise<void> {
    await this.audit.recordDenial({
      companyId: ctx.companyId,
      actorType: ctx.userId ? 'user' : 'service',
      actorId: ctx.userId ?? ctx.serviceIdentityId,
      actorLabel: ctx.actorLabel,
      action: 'authorization.denied',
      objectType: 'membership',
      objectId: membershipId,
      details: { reason: 'membership_not_found' },
    });
  }
}

function otherHolders(holders: Set<string>, membershipId: string): number {
  let count = 0;
  for (const id of holders) {
    if (id !== membershipId) {
      count += 1;
    }
  }
  return count;
}

function statusWrite(status: 'active' | 'suspended' | 'removed', now: Date): {
  status: 'active' | 'suspended' | 'removed';
  suspendedAt: Date | null;
  removedAt: Date | null;
} {
  if (status === 'suspended') {
    return { status, suspendedAt: now, removedAt: null };
  }
  if (status === 'removed') {
    return { status, suspendedAt: null, removedAt: now };
  }
  return { status, suspendedAt: null, removedAt: null };
}

function statusAction(status: 'active' | 'suspended' | 'removed'): string {
  if (status === 'suspended') {
    return 'membership.suspended';
  }
  if (status === 'removed') {
    return 'membership.removed';
  }
  return 'membership.reactivated';
}

function grantsOf(membership: LoadedMembership): Grant[] {
  return dedupeGrants(
    membership.roles.flatMap((assignment) =>
      grantsForAssignment(
        assignment.role.permissions.map((permission) => permission.permission),
        toResourceScope(assignment.scopeType, assignment.scopeId),
      ),
    ),
  );
}

function grantsOfAssignments(assignments: ResolvedAssignment[]): Grant[] {
  return dedupeGrants(
    assignments.flatMap((assignment) =>
      grantsForAssignment(assignment.permissions, { type: assignment.scopeType, id: assignment.scopeId }),
    ),
  );
}

function toMemberView(row: LoadedMembership): MemberView {
  const assignments = row.roles
    .map((assignment) => ({
      roleKey: assignment.role.key,
      roleName: assignment.role.name,
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId,
    }))
    .sort((left, right) => {
      const byRole = left.roleKey.localeCompare(right.roleKey);
      if (byRole !== 0) {
        return byRole;
      }
      const byScope = left.scopeType.localeCompare(right.scopeType);
      if (byScope !== 0) {
        return byScope;
      }
      return (left.scopeId ?? '').localeCompare(right.scopeId ?? '');
    });
  return {
    membershipId: row.id,
    userId: row.userId,
    email: row.user.email,
    displayName: row.user.displayName,
    status: row.status,
    userStatus: row.user.status,
    isPlatformOwner: row.user.isPlatformOwner,
    assignments,
  };
}
