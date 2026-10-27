import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantTransaction } from '@bp/db';
import type { AuditRecord } from '../audit/audit.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { writeAudit } from './auth-audit';
import { emailAtLink, type ParsedOidcClaims } from './claims';
import type { RequestMeta } from './request-meta';

const NOT_PROVISIONED = 'account not provisioned';

export type EnrolmentAcceptResult =
  | { ok: true; userId: string }
  | { ok: false; status: 400 | 403; message: string };

type EnrolmentRow = {
  id: string;
  user_id: string;
  expected_entra_oid: string | null;
  live: boolean;
};

class EnrolmentStop extends Error {
  constructor(
    readonly reason: string,
    readonly objectType: string,
    readonly objectId: string | null,
  ) {
    super(reason);
  }
}

/**
 * Links an Entra identity to a platform owner through a one-time enrolment that only the
 * owner CLI creates. The API never sets `is_platform_owner`.
 *
 * One transaction, locking in the same order as the CLI: the enrolment row
 * (`FOR UPDATE`), then the user row (`FOR NO KEY UPDATE`). So two callbacks with one link
 * cannot both pass, and a concurrent `owner enrol`, `--relink` or `disable` waits or wins.
 * A refusal is a 403 with a denial audit naming the reason; the enrolment stays open.
 *
 * Matching is stricter than for invitations: the link accepts either the Entra `oid` the
 * operator gave at enrolment, or a verified `email` equal to the account's email.
 * `preferred_username` is never enough for an owner.
 */
@Injectable()
export class OwnerEnrolmentService {
  private readonly logger = new Logger(OwnerEnrolmentService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async accept(input: {
    tokenHash: string;
    claims: ParsedOidcClaims;
    meta: RequestMeta;
  }): Promise<EnrolmentAcceptResult> {
    try {
      const userId = await this.prisma.client.$transaction((tx) => this.acceptLocked(tx, input));
      return { ok: true, userId };
    } catch (error) {
      if (error instanceof EnrolmentStop) {
        await writeAudit(
          this.prisma,
          this.audit,
          loginAudit(input.meta, 'denied', error.reason, error.objectType, error.objectId),
        );
        return { ok: false, status: 403, message: NOT_PROVISIONED };
      }
      this.logger.warn(`owner enrolment failed: ${errorName(error)}`);
      await writeAudit(
        this.prisma,
        this.audit,
        loginAudit(input.meta, 'failure', 'enrolment_invalid', 'platform_owner_enrolment', null),
      );
      return { ok: false, status: 400, message: 'Sign-in could not be completed' };
    }
  }

  private async acceptLocked(
    tx: TenantTransaction,
    input: { tokenHash: string; claims: ParsedOidcClaims; meta: RequestMeta },
  ): Promise<string> {
    const rows = await tx.$queryRaw<EnrolmentRow[]>`
      SELECT id::text AS id,
             user_id::text AS user_id,
             expected_entra_oid,
             (consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS live
      FROM platform_owner_enrolment
      WHERE token_hash = ${input.tokenHash}
      FOR UPDATE
    `;
    const enrolment = rows[0];
    if (!enrolment) {
      throw new EnrolmentStop('enrolment_not_found', 'platform_owner_enrolment', null);
    }
    if (!enrolment.live) {
      throw new EnrolmentStop('enrolment_unavailable', 'platform_owner_enrolment', enrolment.id);
    }
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM user_account WHERE id = CAST(${enrolment.user_id} AS uuid) FOR NO KEY UPDATE
    `;
    const user =
      locked.length === 1 ? await tx.userAccount.findUnique({ where: { id: enrolment.user_id } }) : null;
    if (!user || user.status !== 'active') {
      throw new EnrolmentStop('user_disabled', 'user_account', enrolment.user_id);
    }
    if (!user.isPlatformOwner) {
      throw new EnrolmentStop('not_platform_owner', 'user_account', user.id);
    }
    const mismatch = ownerIdentityMismatch(user.email, enrolment.expected_entra_oid, input.claims);
    if (mismatch) {
      throw new EnrolmentStop(mismatch, 'platform_owner_enrolment', enrolment.id);
    }
    const own = await tx.userIdentity.findFirst({
      where: { userId: user.id, provider: 'entra' },
      select: { id: true },
    });
    if (own) {
      throw new EnrolmentStop('account_identity_conflict', 'user_identity', user.id);
    }
    const taken = await tx.userIdentity.findUnique({
      where: {
        provider_issuer_subject: { provider: 'entra', issuer: input.claims.issuer, subject: input.claims.subject },
      },
      select: { id: true },
    });
    if (taken) {
      throw new EnrolmentStop('identity_conflict', 'user_identity', user.id);
    }
    try {
      await tx.userIdentity.create({
        data: {
          userId: user.id,
          provider: 'entra',
          issuer: input.claims.issuer,
          subject: input.claims.subject,
          tenantId: input.claims.tenantId ?? null,
          entraOid: input.claims.entraOid ?? null,
          emailAtLink: emailAtLink(input.claims),
          lastLoginAt: new Date(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new EnrolmentStop('identity_conflict', 'user_identity', user.id);
      }
      throw error;
    }
    const consumed = await tx.$queryRaw<{ id: string }[]>`
      UPDATE platform_owner_enrolment
      SET consumed_at = now()
      WHERE id = CAST(${enrolment.id} AS uuid) AND consumed_at IS NULL
      RETURNING id::text AS id
    `;
    if (consumed.length !== 1) {
      throw new EnrolmentStop('enrolment_unavailable', 'platform_owner_enrolment', enrolment.id);
    }
    await this.audit.record(tx, {
      companyId: null,
      actorType: 'user',
      actorId: user.id,
      actorLabel: user.email,
      action: 'platform.owner_enrolled',
      objectType: 'user_account',
      objectId: user.id,
      outcome: 'success',
      ip: input.meta.ip,
      userAgent: input.meta.userAgent,
      details: { method: 'oidc', enrolmentId: enrolment.id },
    });
    return user.id;
  }
}

/** Null when the claims prove the enrolled identity; otherwise the denial reason. */
export function ownerIdentityMismatch(
  email: string,
  expectedEntraOid: string | null,
  claims: ParsedOidcClaims,
): 'enrolment_oid_mismatch' | 'enrolment_email_mismatch' | null {
  if (expectedEntraOid !== null) {
    return claims.entraOid !== undefined && claims.entraOid.toLowerCase() === expectedEntraOid.toLowerCase()
      ? null
      : 'enrolment_oid_mismatch';
  }
  return claims.emailVerified && claims.email !== undefined && claims.email.toLowerCase() === email.toLowerCase()
    ? null
    : 'enrolment_email_mismatch';
}

function loginAudit(
  meta: RequestMeta,
  outcome: 'denied' | 'failure',
  reason: string,
  objectType: string,
  objectId: string | null,
): AuditRecord {
  return {
    companyId: null,
    actorType: 'system',
    action: 'auth.login',
    objectType,
    objectId,
    outcome,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { method: 'oidc', flow: 'owner_enrolment', reason },
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
