import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, queryRecord, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { ClientService, type ClientListQuery } from './client.service';
import { clientCreate, clientFields } from './client-input';

const clientPatch = z
  .strictObject({
    expectedVersion: z.number().int().nonnegative(),
    archived: z.boolean().optional(),
    ...optional(clientFields),
  })
  .refine((body) => Object.keys(body).some((key) => key !== 'expectedVersion'), {
    message: 'no changes',
  });

const duplicateBody = z
  .strictObject({
    displayName: z.string().max(500).optional(),
    email: z.string().max(320).optional(),
    vatNumber: z.string().max(40).optional(),
    excludeClientId: z.string().optional(),
  })
  .refine(
    (body) =>
      body.displayName !== undefined || body.email !== undefined || body.vatNumber !== undefined,
    {
      message: 'nothing to check',
    },
  );

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const idParam = ApiParam({
  name: 'id',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

@ApiTags('clients')
@companyIdParam
@Controller('c/:companyId/clients')
export class ClientController {
  constructor(@Inject(ClientService) private readonly clients: ClientService) {}

  @Get()
  @RequirePermission('client.view')
  @ApiOperation({ summary: 'List clients in this company' })
  @ApiOkResponse({
    description:
      'Clients with contacts and addresses. Archived clients are omitted unless asked for.',
  })
  async list(@Req() req: Request, @Param('companyId') companyId: string) {
    const clients = await this.clients.list(
      requireContext(req, companyId),
      parseListQuery(queryRecord(req)),
    );
    return { clients };
  }

  @Post('duplicate-check')
  @HttpCode(200)
  @RequirePermission('client.manage')
  @ApiOperation({
    summary: 'Find clients with the same normalised name, email or VAT in this company',
  })
  async duplicateCheck(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = duplicateBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const matches = await this.clients.duplicateCheck(
      requireContext(req, companyId),
      parsed.data,
      requestMeta(req),
    );
    return { matches };
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('client.manage')
  @ApiOperation({ summary: 'Create a client. There is no delete; archive it instead.' })
  async create(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = clientCreate.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const client = await this.clients.create(
      requireContext(req, companyId),
      parsed.data,
      requestMeta(req),
    );
    return { client };
  }

  @Get(':id')
  @idParam
  @RequirePermission('client.view')
  @ApiOperation({ summary: 'One client, including an archived client' })
  async get(@Req() req: Request, @Param('companyId') companyId: string, @Param('id') id: string) {
    const client = await this.clients.get(requireContext(req, companyId), id, requestMeta(req));
    return { client };
  }

  @Patch(':id')
  @idParam
  @RequirePermission('client.manage')
  @ApiOperation({ summary: 'Edit a client. expectedVersion must match. A mismatch is 409.' })
  async update(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = clientPatch.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const client = await this.clients.update(
      requireContext(req, companyId),
      id,
      parsed.data,
      requestMeta(req),
    );
    return { client };
  }
}

function optional<T extends z.ZodType>(
  fields: Record<string, T>,
): Record<string, z.ZodOptional<T>> {
  const result: Record<string, z.ZodOptional<T>> = {};
  for (const [key, schema] of Object.entries(fields)) {
    result[key] = schema.optional();
  }
  return result;
}

function parseListQuery(query: Record<string, unknown>): ClientListQuery {
  const includeArchived = query.includeArchived;
  if (includeArchived !== undefined && includeArchived !== 'true' && includeArchived !== 'false') {
    throw new BadRequestException('includeArchived is invalid');
  }
  const q = query.q;
  if (q !== undefined && (typeof q !== 'string' || q.length === 0 || q.length > 200)) {
    throw new BadRequestException('q is invalid');
  }
  return { q, includeArchived: includeArchived === 'true' };
}
