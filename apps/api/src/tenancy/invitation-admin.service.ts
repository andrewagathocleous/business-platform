import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { canGrant } from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { PrismaService } from '../database/prisma.service';
import type { RoleAssignmentInput } from './membership.service';
import type { RequestMeta } from '../identity/request-meta';
import { hashToken, randomToken } from '../identity/tokens';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class InvitationDenied extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly reason: string,
    readonly companyId: string | null,
    readonly objectType: string,
    readonly objectId: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'InvitationDenied';
  }
}

export type InvitationCreated = {
  id: string;
  email: string;
  expiresAt: string;
  assignments: RoleAssignmentInput[];
  link: string;
};

@Injectable()
export class InvitationAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    ctx: RequestContext,
    email: string,
    assignments: RoleAssignmentInput[],
    meta: RequestMeta,
  ): Promise<InvitationCreated> {
    if (!ctx.userId) {
      throw new ForbiddenException('Forbidden');
    }
    const actorId = ctx.userId;
    try {
      return await this.prisma.client.$transaction(
        (tx) => this.createLocked(tx, ctx, actorId, email, assignments, meta),
        { timeout: 15_000 },
      );
    } catch (error) {
      if (error instanceof InvitationDenied) {
        if (error.status !== 400) {
          await this.audit.recordDenial({
            companyId: error.companyId,
            actorType: 'user',
            actorId,
            actorLabel: ctx.actorLabel,
            action: 'authorization.denied',
            objectType: error.objectType,
            objectId: error.objectId,
            ip: meta.ip,
            userAgent: meta.userAgent,
            details: { reason: error.reason },
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
      throw error;
    }
  }

  private async createLocked(
    tx: TenantTransaction,
    ctx: RequestContext,
    actorId: string,
    email: string,
    assignments: RoleAssignmentInput[],
    meta: RequestMeta,
  ): Promise<InvitationCreated> {
    if (assignments.length === 0) {
      throw new InvitationDenied(400, 'assignments_required', ctx.companyId, 'invitation', null, 'assignments are required');
    }
    await tx.$queryRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
    const seen = new Set<string>();
    const resolved: { assignment: RoleAssignmentInput; permissions: string[] }[] = [];
    for (const assignment of assignments) {
      const key = `${assignment.roleKey}\u0000${assignment.scopeType}\u0000${assignment.scopeId ?? ''}`;
      if (seen.has(key)) {
        throw new InvitationDenied(400, 'duplicate_assignment', ctx.companyId, 'invitation', null, 'duplicate role assignment');
      }
      seen.add(key);
      const role = await tx.role.findUnique({
        where: { companyId_key: { companyId: ctx.companyId, key: assignment.roleKey } },
        include: { permissions: true },
      });
      if (!role) {
        throw new InvitationDenied(400, 'unknown_role', ctx.companyId, 'role', null, 'Unknown role');
      }
      await this.assertScope(tx, ctx.companyId, assignment);
      const permissions = role.permissions.map((permission) => permission.permission);
      if (
        !canGrant(ctx.grants, { permissions }, { type: assignment.scopeType, id: assignment.scopeId })
      ) {
        throw new InvitationDenied(403, 'grant_not_allowed', ctx.companyId, 'invitation', null, 'Forbidden');
      }
      resolved.push({ assignment, permissions });
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const saved = await tx.invitation.create({
      data: {
        companyId: ctx.companyId,
        email,
        roleAssignments: assignments,
        tokenHash: hashToken(token),
        expiresAt,
        invitedById: actorId,
      },
    });
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId,
      actorLabel: ctx.actorLabel,
      action: 'invitation.created',
      objectType: 'invitation',
      objectId: saved.id,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        email,
        assignments: assignments.map((assignment) => ({
          roleKey: assignment.roleKey,
          scopeType: assignment.scopeType,
          scopeId: assignment.scopeId,
        })),
      },
    });
    const link = `/api/auth/oidc/start?redirect=${encodeURIComponent('/')}&invitation=${encodeURIComponent(token)}`;
    return {
      id: saved.id,
      email: saved.email,
      expiresAt: saved.expiresAt.toISOString(),
      assignments,
      link,
    };
  }

  private async assertScope(tx: TenantTransaction, companyId: string, assignment: RoleAssignmentInput): Promise<void> {
    if (assignment.scopeType === 'company') {
      return;
    }
    if (assignment.scopeType === 'mailbox' || assignment.scopeType === 'integration_account') {
      throw new InvitationDenied(400, 'scope_not_supported', companyId, 'role', null, 'scope type is not supported');
    }
    const scopeId = assignment.scopeId;
    if (!scopeId || !isUuid(scopeId)) {
      throw new InvitationDenied(400, 'invalid_scope', companyId, 'role', null, 'scope id is required');
    }
    if (assignment.scopeType === 'store') {
      const store = await tx.store.findFirst({ where: { id: scopeId, companyId } });
      if (!store) {
        throw new InvitationDenied(404, 'scope_not_found', companyId, 'store', scopeId, 'Not found');
      }
      return;
    }
    const location = await tx.location.findFirst({ where: { id: scopeId, companyId } });
    if (!location) {
      throw new InvitationDenied(404, 'scope_not_found', companyId, 'location', scopeId, 'Not found');
    }
  }
}
