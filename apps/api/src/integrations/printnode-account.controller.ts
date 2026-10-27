import { BadRequestException, Controller, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireActor, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { emptyBodySchema, printNodeKeySchema } from './printnode-account.schema';
import { PrintNodeAccountService } from './printnode-account.service';

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

@ApiTags('integrations')
@companyIdParam
@Controller('c/:companyId/print-accounts/printnode')
export class PrintNodeAccountController {
  constructor(@Inject(PrintNodeAccountService) private readonly accounts: PrintNodeAccountService) {}

  @Get()
  @RequirePermission('printer.manage')
  @ApiOperation({ summary: 'Whether a PrintNode key is stored. Does not call PrintNode.' })
  async get(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.accounts.get(ctx);
  }

  @Put()
  @RequirePermission('printer.manage')
  @ApiOperation({ summary: 'Store a PrintNode API key' })
  async save(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(printNodeKeySchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.accounts.save(ctx, parsed.key, requestMeta(req));
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermission('printer.manage')
  @ApiOperation({ summary: 'Call PrintNode whoami with the stored key' })
  async test(@Req() req: Request, @Param('companyId') companyId: string) {
    parse(emptyBodySchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.accounts.test(ctx, requestMeta(req));
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body === undefined ? {} : body);
  if (!parsed.success) {
    throw new BadRequestException(issueMessage(parsed.error));
  }
  return parsed.data;
}
