import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import { can, canGrant } from '@bp/domain';
import { z } from 'zod';
import type { AuditRecord } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import { grantsForMembership, platformOwnerGrants } from '../authz/load-grants';
import { PrismaService } from '../database/prisma.service';
import { writeAudit } from './auth-audit';
import {
  displayNameFromClaims,
  emailAtLink,
  invitationEmailMatches,
  type ParsedOidcClaims,
} from './claims';
import type { RequestMeta } from './request-meta';

const SCOPE_TYPES = ['company', 'store', 'location', 'mailbox', 'integration_account'] as const;

export const invitationRoleAssignmentSchema = z
  .object({
    roleKey: z.string().min(1).max(64),
    scopeType: z.enum(SCOPE_TYPES),
    scopeId: z.uuid().nullable(),
  })
  .refine((assignment) => (assignment.scopeType === 'company') === (assignment.scopeId === null), {
    message: 'company scope has a null scope id, and every other scope has an id',
  });

export type InvitationRoleAssignment = z.infer<typeof invitationRoleAssignmentSchema>;

const NOT_PROVISIONED = 'account not provisioned';

export type InvitationAcceptResult =
  | { ok: true; userId: string }
  | { ok: false; status: 400 | 403; message: string };

type Stop = {
  audit: AuditRecord;
  status: 400 | 403;
  message: string;
};

class AcceptanceStop extends Error {
  constructor(readonly stop: Stop) {
    super(stop.audit.action);
  }
}

/**
 * Invitation acceptance takes `SELECT … FROM company WHERE id = $1 FOR UPDATE`
 * and re-reads the invitation under that lock. It then re-checks the inviter.
 * An active platform owner is authorised without a membership and holds every
 * ordinary permission. Anyone else must still have an active membership,
 * `member.invite`, and `canGrant` for every stored role assignment.
 * A failed check is an audited denial and leaves the invitation open.
 * Before linking an Entra identity to an existing account, the user row is
 * locked with `FOR NO KEY UPDATE` so two acceptances cannot both pass the
 * link check. That lock still allows `membership_role.granted_by` to take
 * its foreign-key key-share lock.
 *
 * A suspended or removed membership is not reactivated by an invitation.
 * Email linking attaches an Entra identity only when that account has none,
 * and never attaches one to a platform owner.
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async accept(input: {
    tokenHash: string;
    claims: ParsedOidcClaims;
    meta: RequestMeta;
  }): Promise<InvitationAcceptResult> {
    try {
      const userId = await this.prisma.client.$transaction((tx) => this.acceptLocked(tx, input));
      return { ok: true, userId };
    } catch (error) {
      if (error instanceof AcceptanceStop) {
        await writeAudit(this.prisma, this.audit, error.stop.audit);
        return { ok: false, status: error.stop.status, message: error.stop.message };
      }
      this.logger.warn(`invitation acceptance failed: ${errorName(error)}`);
      await writeAudit(this.prisma, this.audit, failureAudit(input.meta, 'invitation_invalid', null, null));
      return { ok: false, status: 400, message: 'Sign-in could not be completed' };
    }
  }

  private async acceptLocked(
    tx: TenantTransaction,
    input: { tokenHash: string; claims: ParsedOidcClaims; meta: RequestMeta },
  ): Promise<string> {
    const invitation = await tx.invitation.findUnique({ where: { tokenHash: input.tokenHash } });
    if (!invitation) {
      throw new AcceptanceStop({
        audit: denialAudit(input.meta, 'invitation_not_found', null, null, 'user_identity'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM company WHERE id = CAST(${invitation.companyId} AS uuid) FOR UPDATE
    `;
    if (locked.length !== 1) {
      throw new AcceptanceStop({
        audit: failureAudit(input.meta, 'company_missing', invitation.companyId, invitation.id),
        status: 400,
        message: 'Sign-in could not be completed',
      });
    }
    const current = await tx.invitation.findUnique({ where: { id: invitation.id } });
    if (!current || current.acceptedAt || current.revokedAt || current.expiresAt.getTime() <= Date.now()) {
      throw new AcceptanceStop({
        audit: denialAudit(input.meta, 'invitation_unavailable', invitation.companyId, invitation.id, 'invitation'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    if (!invitationEmailMatches(current.email, input.claims)) {
      throw new AcceptanceStop({
        audit: denialAudit(
          input.meta,
          'invitation_email_mismatch',
          current.companyId,
          current.id,
          'invitation',
        ),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    const assignments = parseAssignments(current.roleAssignments);
    if (!assignments) {
      throw new AcceptanceStop({
        audit: failureAudit(input.meta, 'invitation_invalid', current.companyId, current.id),
        status: 400,
        message: 'Sign-in could not be completed',
      });
    }
    const roles: { assignment: InvitationRoleAssignment; roleId: string; permissions: string[] }[] = [];
    for (const assignment of assignments) {
      const role = await tx.role.findUnique({
        where: { companyId_key: { companyId: current.companyId, key: assignment.roleKey } },
        include: { permissions: true },
      });
      if (!role) {
        throw new AcceptanceStop({
          audit: failureAudit(input.meta, 'role_missing', current.companyId, current.id),
          status: 400,
          message: 'Sign-in could not be completed',
        });
      }
      roles.push({
        assignment,
        roleId: role.id,
        permissions: role.permissions.map((permission) => permission.permission),
      });
    }
    await this.assertInviterAuthority(tx, current, roles, input.meta);
    const existingIdentity = await tx.userIdentity.findUnique({
      where: {
        provider_issuer_subject: {
          provider: 'entra',
          issuer: input.claims.issuer,
          subject: input.claims.subject,
        },
      },
    });
    let user = await tx.userAccount.findFirst({ where: { email: current.email } });
    if (existingIdentity) {
      const identityUser = await tx.userAccount.findUnique({ where: { id: existingIdentity.userId } });
      if (!identityUser || identityUser.email.toLowerCase() !== current.email.toLowerCase()) {
        throw new AcceptanceStop({
          audit: denialAudit(input.meta, 'identity_conflict', current.companyId, current.id, 'user_identity'),
          status: 403,
          message: NOT_PROVISIONED,
        });
      }
      user = identityUser;
    } else if (user) {
      await this.lockUser(tx, user.id, current, input.meta);
      await this.assertEmailLink(tx, user, current, input.meta);
    }
    if (user && user.status !== 'active') {
      throw new AcceptanceStop({
        audit: denialAudit(input.meta, 'user_disabled', current.companyId, current.id, 'user_account'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    if (user) {
      const membership = await tx.membership.findUnique({
        where: { userId_companyId: { userId: user.id, companyId: current.companyId } },
      });
      if (membership && (membership.status === 'suspended' || membership.status === 'removed')) {
        throw new AcceptanceStop({
          audit: denialAudit(input.meta, 'membership_blocked', current.companyId, current.id, 'membership'),
          status: 403,
          message: NOT_PROVISIONED,
        });
      }
    }

    const savedUser =
      user ??
      (await tx.userAccount.create({
        data: {
          email: current.email,
          displayName: displayNameFromClaims(input.claims, current.email),
          locale: 'en',
          isPlatformOwner: false,
          status: 'active',
        },
      }));
    const linkedEmail = emailAtLink(input.claims);
    if (existingIdentity) {
      await tx.userIdentity.update({
        where: { id: existingIdentity.id },
        data: {
          userId: savedUser.id,
          tenantId: input.claims.tenantId ?? null,
          entraOid: input.claims.entraOid ?? null,
          emailAtLink: linkedEmail,
          lastLoginAt: new Date(),
        },
      });
    } else {
      try {
        await tx.userIdentity.create({
          data: {
            userId: savedUser.id,
            provider: 'entra',
            issuer: input.claims.issuer,
            subject: input.claims.subject,
            tenantId: input.claims.tenantId ?? null,
            entraOid: input.claims.entraOid ?? null,
            emailAtLink: linkedEmail,
            lastLoginAt: new Date(),
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        throw new AcceptanceStop({
          audit: denialAudit(
            input.meta,
            'account_identity_conflict',
            current.companyId,
            current.id,
            'user_identity',
          ),
          status: 403,
          message: NOT_PROVISIONED,
        });
      }
    }
    const membership = await tx.membership.upsert({
      where: { userId_companyId: { userId: savedUser.id, companyId: current.companyId } },
      create: { userId: savedUser.id, companyId: current.companyId, status: 'active' },
      update: { status: 'active', suspendedAt: null, removedAt: null },
    });
    for (const role of roles) {
      const existingRole = await tx.membershipRole.findFirst({
        where: {
          membershipId: membership.id,
          roleId: role.roleId,
          scopeType: role.assignment.scopeType,
          scopeId: role.assignment.scopeId,
        },
      });
      if (!existingRole) {
        await tx.membershipRole.create({
          data: {
            membershipId: membership.id,
            roleId: role.roleId,
            scopeType: role.assignment.scopeType,
            scopeId: role.assignment.scopeId,
            grantedById: current.invitedById,
          },
        });
      }
    }
    await tx.invitation.update({
      where: { id: current.id },
      data: { acceptedAt: new Date(), acceptedUserId: savedUser.id },
    });
    await tx.$queryRaw`SELECT set_config('app.company_id', ${current.companyId}, true)`;
    await this.audit.record(tx, {
      companyId: current.companyId,
      actorType: 'user',
      actorId: savedUser.id,
      actorLabel: savedUser.email,
      action: 'invitation.accepted',
      objectType: 'invitation',
      objectId: current.id,
      outcome: 'success',
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      details: { roleKeys: roles.map((role) => role.assignment.roleKey) },
    });
    return savedUser.id;
  }

  private async assertInviterAuthority(
    tx: TenantTransaction,
    invitation: { id: string; companyId: string; invitedById: string },
    roles: { assignment: InvitationRoleAssignment; permissions: string[] }[],
    meta: RequestMeta,
  ): Promise<void> {
    const inviter = await tx.userAccount.findUnique({ where: { id: invitation.invitedById } });
    if (!inviter || inviter.status !== 'active') {
      throw new AcceptanceStop({
        audit: denialAudit(meta, 'inviter_not_authorized', invitation.companyId, invitation.id, 'invitation'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    const membership = await tx.membership.findUnique({
      where: { userId_companyId: { userId: inviter.id, companyId: invitation.companyId } },
    });
    const grants = inviter.isPlatformOwner
      ? platformOwnerGrants()
      : membership && membership.status === 'active'
        ? await grantsForMembership(tx, membership.id)
        : null;
    if (!grants) {
      throw new AcceptanceStop({
        audit: denialAudit(meta, 'inviter_not_authorized', invitation.companyId, invitation.id, 'invitation'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    if (!can(grants, 'member.invite')) {
      throw new AcceptanceStop({
        audit: denialAudit(meta, 'inviter_permission_missing', invitation.companyId, invitation.id, 'invitation'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    for (const role of roles) {
      const allowed = canGrant(
        grants,
        { permissions: role.permissions },
        { type: role.assignment.scopeType, id: role.assignment.scopeId },
      );
      if (!allowed) {
        throw new AcceptanceStop({
          audit: denialAudit(meta, 'grant_not_allowed', invitation.companyId, invitation.id, 'invitation'),
          status: 403,
          message: NOT_PROVISIONED,
        });
      }
    }
  }

  /**
   * Email linking runs only when this Entra subject is not already on the account.
   * An existing Entra identity is a different (issuer, subject). A platform owner
   * is never linked through an invitation.
   * `FOR NO KEY UPDATE` serialises the account without conflicting with the
   * key-share lock taken by `membership_role.granted_by`.
   */
  private async lockUser(
    tx: TenantTransaction,
    userId: string,
    invitation: { id: string; companyId: string },
    meta: RequestMeta,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM user_account WHERE id = CAST(${userId} AS uuid) FOR NO KEY UPDATE
    `;
    if (locked.length !== 1) {
      throw new AcceptanceStop({
        audit: failureAudit(meta, 'user_missing', invitation.companyId, invitation.id),
        status: 400,
        message: 'Sign-in could not be completed',
      });
    }
  }

  private async assertEmailLink(
    tx: TenantTransaction,
    user: { id: string; isPlatformOwner: boolean },
    invitation: { id: string; companyId: string },
    meta: RequestMeta,
  ): Promise<void> {
    const entra = await tx.userIdentity.findFirst({
      where: { userId: user.id, provider: 'entra' },
      select: { id: true },
    });
    if (entra) {
      throw new AcceptanceStop({
        audit: denialAudit(meta, 'account_identity_conflict', invitation.companyId, invitation.id, 'user_identity'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
    if (user.isPlatformOwner) {
      throw new AcceptanceStop({
        audit: denialAudit(meta, 'platform_owner_link', invitation.companyId, invitation.id, 'user_account'),
        status: 403,
        message: NOT_PROVISIONED,
      });
    }
  }
}

function parseAssignments(value: unknown): InvitationRoleAssignment[] | undefined {
  const parsed = z.array(invitationRoleAssignmentSchema).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function denialAudit(
  meta: RequestMeta,
  reason: string,
  companyId: string | null,
  objectId: string | null,
  objectType: string,
): AuditRecord {
  return {
    companyId,
    actorType: 'system',
    action: 'auth.login',
    objectType,
    objectId,
    outcome: 'denied',
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { method: 'oidc', reason },
  };
}

function failureAudit(
  meta: RequestMeta,
  reason: string,
  companyId: string | null,
  objectId: string | null,
): AuditRecord {
  return {
    companyId,
    actorType: 'system',
    action: 'auth.login',
    objectType: 'invitation',
    objectId,
    outcome: 'failure',
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { method: 'oidc', reason },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error && (error.code === 'P2002' || error.code === '23505')) {
    return true;
  }
  return 'cause' in error && isUniqueViolation(error.cause);
}
