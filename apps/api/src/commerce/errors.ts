import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../authz/request-context';
import type { RequestMeta } from '../identity/request-meta';

/** 409 reasons the client tells apart, so they keep their code in the error body. */
const CODED_CONFLICTS = new Set([
  'name_taken',
  'location_in_use',
  'code_taken',
  'tax_code_in_use',
  'series_in_use',
  'series_is_default',
  'currency_locked',
  'document_type_locked',
  'credit_note_draft',
]);

export class CommerceError extends Error {
  override readonly name = 'CommerceError';

  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly reason: string,
    readonly objectType: string,
    readonly objectId: string | null,
    message: string,
    readonly action?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function settleCommerceError(
  audit: AuditService,
  prisma: PrismaService,
  ctx: RequestContext,
  meta: RequestMeta,
  error: CommerceError,
): Promise<never> {
  const actorType = ctx.serviceIdentityId ? 'service' : 'user';
  const actorId = ctx.serviceIdentityId ?? ctx.userId;
  const details = { reason: error.reason, ...error.details };
  if (error.status === 404 || error.status === 403) {
    await audit.recordDenial({
      companyId: ctx.companyId,
      actorType,
      actorId,
      actorLabel: ctx.actorLabel,
      action: 'authorization.denied',
      objectType: error.objectType,
      objectId: error.objectId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details,
    });
    if (error.status === 403) {
      throw new ForbiddenException('Forbidden');
    }
    throw new NotFoundException('Not found');
  }
  if (error.status === 409 || error.status === 422) {
    await prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
      await audit.record(tx, {
        companyId: ctx.companyId,
        actorType,
        actorId,
        actorLabel: ctx.actorLabel,
        action: error.action ?? `${error.objectType}.update`,
        objectType: error.objectType,
        objectId: error.objectId,
        outcome: 'failure',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details,
      });
    });
    if (error.status === 422) {
      throw new UnprocessableEntityException({ code: error.reason, message: error.message });
    }
    if (error.reason === 'already_printed') {
      const printJobId = error.details?.printJobId;
      throw new ConflictException({
        code: 'already_printed',
        message: error.message,
        ...(typeof printJobId === 'string' ? { printJobId } : {}),
      });
    }
    if (error.reason === 'print_provider_not_configured') {
      throw new ConflictException({
        code: 'print_provider_not_configured',
        message: error.message,
      });
    }
    if (CODED_CONFLICTS.has(error.reason)) {
      throw new ConflictException({
        code: error.reason,
        message: error.message,
      });
    }
    throw new ConflictException(error.message);
  }
  if (error.reason === 'print_provider_unavailable') {
    throw new BadRequestException({
      code: 'print_provider_unavailable',
      message: error.message,
    });
  }
  throw new BadRequestException(error.message);
}
