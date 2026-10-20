import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  InternalServerErrorException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { readRequestContext, type RequestContext } from '../authz/request-context';
import { invitationRoleAssignmentSchema } from '../identity/invitation.service';
import { requestMeta } from '../identity/request-meta';
import { CompanyReadService, parseAuditQuery } from './company-read.service';
import { InvitationAdminService } from './invitation-admin.service';
import { MembershipService } from './membership.service';
import { ServiceIdentityService } from './service-identity.service';

const invitationBody = z
  .object({
    email: z
      .string()
      .trim()
      .min(3)
      .max(320)
      .refine((value) => /^[^\s@]+@[^\s@]+$/.test(value), { message: 'email is invalid' }),
    assignments: z.array(invitationRoleAssignmentSchema).min(1).max(20),
  })
  .strict();

const membershipBody = z
  .object({
    status: z.enum(['active', 'suspended', 'removed']).optional(),
    assignments: z.array(invitationRoleAssignmentSchema).max(20).optional(),
  })
  .strict()
  .refine((body) => body.status !== undefined || body.assignments !== undefined, {
    message: 'status or assignments is required',
  });

const serviceIdentityBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(200),
    permissions: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const membershipIdParam = ApiParam({
  name: 'membershipId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const idParam = ApiParam({
  name: 'id',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

@ApiTags('company')
@companyIdParam
@Controller('c/:companyId')
export class CompanyController {
  constructor(
    @Inject(CompanyReadService) private readonly companyRead: CompanyReadService,
    @Inject(MembershipService) private readonly memberships: MembershipService,
    @Inject(InvitationAdminService) private readonly invitations: InvitationAdminService,
    @Inject(ServiceIdentityService) private readonly serviceIdentities: ServiceIdentityService,
  ) {}

  @Get('context')
  @RequirePermission('company.view')
  @ApiOperation({ summary: 'Company summary, caller grants, switches and MFA step-up' })
  @ApiOkResponse({ description: 'Read-only company context for the signed-in member' })
  async context(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.companyRead.context(requireContext(req, companyId));
  }

  @Get('members')
  @RequirePermission('member.view')
  @ApiOperation({ summary: 'List company members and their role assignments' })
  async members(@Param('companyId') companyId: string) {
    return { members: await this.memberships.list(companyId.toLowerCase()) };
  }

  @Get('members/:membershipId')
  @membershipIdParam
  @RequirePermission('member.view')
  @ApiOperation({ summary: 'One membership in this company' })
  async member(@Req() req: Request, @Param('companyId') companyId: string, @Param('membershipId') membershipId: string) {
    return this.memberships.get(requireContext(req, companyId), membershipId);
  }

  @Patch('members/:membershipId')
  @membershipIdParam
  @RequirePermission('member.manage')
  @ApiOperation({ summary: 'Change a member role assignment or membership status' })
  async updateMember(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('membershipId') membershipId: string,
  ) {
    const parsed = membershipBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return {
      member: await this.memberships.update(
        requireContext(req, companyId),
        membershipId,
        parsed.data,
        requestMeta(req),
      ),
    };
  }

  @Post('members/:membershipId/revoke-sessions')
  @membershipIdParam
  @HttpCode(200)
  @RequirePermission('member.sessions.revoke')
  @ApiOperation({ summary: "Revoke another member's sessions" })
  async revokeSessions(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('membershipId') membershipId: string,
  ) {
    return this.memberships.revokeSessions(requireContext(req, companyId), membershipId, requestMeta(req));
  }

  @Post('invitations')
  @HttpCode(200)
  @RequirePermission('member.invite')
  @ApiOperation({ summary: 'Create an invitation and return the accept link once. No email is sent.' })
  async invite(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = invitationBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const invitation = await this.invitations.create(
      requireContext(req, companyId),
      parsed.data.email,
      parsed.data.assignments,
      requestMeta(req),
    );
    return { invitation };
  }

  @Get('roles')
  @RequirePermission('member.view')
  @ApiOperation({ summary: 'List role bundles copied into this company' })
  async roles(@Param('companyId') companyId: string) {
    return { roles: await this.companyRead.roles(companyId.toLowerCase()) };
  }

  @Get('audit-events')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'Paginated audit events for this company' })
  async auditEvents(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.companyRead.auditEvents(requireContext(req, companyId), parseAuditQuery(queryRecord(req)));
  }

  @Get('service-identities')
  @RequirePermission('service_identity.manage')
  @ApiOperation({ summary: 'List automation tokens. Secrets are never returned.' })
  async listServiceIdentities(@Param('companyId') companyId: string) {
    return { identities: await this.serviceIdentities.list(companyId.toLowerCase()) };
  }

  @Post('service-identities')
  @HttpCode(200)
  @RequirePermission('service_identity.manage')
  @ApiOperation({ summary: 'Create an automation token. The token is returned once.' })
  async createServiceIdentity(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = serviceIdentityBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.serviceIdentities.create(
      requireContext(req, companyId),
      {
        name: parsed.data.name,
        purpose: parsed.data.purpose,
        permissions: parsed.data.permissions,
        expiresAt: parsed.data.expiresAt,
      },
      requestMeta(req),
    );
  }

  @Delete('service-identities/:id')
  @idParam
  @HttpCode(204)
  @RequirePermission('service_identity.manage')
  @ApiOperation({ summary: 'Revoke an automation token' })
  async revokeServiceIdentity(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.serviceIdentities.revoke(requireContext(req, companyId), id, requestMeta(req));
  }
}

function requireContext(req: Request, companyId: string): RequestContext {
  const ctx = readRequestContext(req);
  if (!ctx || ctx.companyId !== companyId.toLowerCase()) {
    throw new InternalServerErrorException('Company context is missing');
  }
  return ctx;
}

function unknownBody(req: Request): unknown {
  return req.body as unknown;
}

function queryRecord(req: Request): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query)) {
    query[key] = Array.isArray(value) ? value[0] : value;
  }
  return query;
}

function issueMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join(', ');
}
