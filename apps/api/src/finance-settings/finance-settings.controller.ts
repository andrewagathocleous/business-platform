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
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireActor, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import {
  bankAccountCreateSchema,
  bankAccountPatchSchema,
  seriesCreateSchema,
  seriesPatchSchema,
  taxCodeCreateSchema,
  taxCodePatchSchema,
} from './finance-settings.schema';
import { FinanceSettingsService } from './finance-settings.service';

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

@ApiTags('finance settings')
@companyIdParam
@Controller('c/:companyId')
export class FinanceSettingsController {
  constructor(@Inject(FinanceSettingsService) private readonly settings: FinanceSettingsService) {}

  @Get('tax-codes')
  @RequirePermission('catalog.view')
  @ApiOperation({
    summary: 'Tax codes for this company, with whether an invoice line uses each one',
  })
  async taxCodes(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { taxCodes: await this.settings.listTaxCodes(ctx) };
  }

  @Post('tax-codes')
  @HttpCode(200)
  @RequirePermission('tax.manage')
  @ApiOperation({ summary: 'Create a tax code' })
  async createTaxCode(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(taxCodeCreateSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { taxCode: await this.settings.createTaxCode(ctx, parsed, requestMeta(req)) };
  }

  @Patch('tax-codes/:id')
  @idParam
  @RequirePermission('tax.manage')
  @ApiOperation({
    summary:
      'Edit or deactivate a tax code. expectedVersion must match. Rate, kind and notes are locked once an invoice line uses the code (409 tax_code_in_use).',
  })
  async updateTaxCode(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = parse(taxCodePatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { taxCode: await this.settings.updateTaxCode(ctx, id, parsed, requestMeta(req)) };
  }

  @Get('invoice-series')
  @RequirePermission('invoice.view')
  @ApiOperation({ summary: 'Invoice, credit-note and quote series' })
  async series(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { series: await this.settings.listSeries(ctx) };
  }

  @Post('invoice-series')
  @HttpCode(200)
  @RequirePermission('invoice.series.manage')
  @ApiOperation({ summary: 'Create a series for one document type. The type cannot change later.' })
  async createSeries(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(seriesCreateSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { series: await this.settings.createSeries(ctx, parsed, requestMeta(req)) };
  }

  @Patch('invoice-series/:id')
  @idParam
  @RequirePermission('invoice.series.manage')
  @ApiOperation({
    summary:
      'Edit or deactivate a series. expectedVersion must match. Prefix, padding and next number are locked once a number is issued (409 series_in_use).',
  })
  async updateSeries(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = parse(seriesPatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { series: await this.settings.updateSeries(ctx, id, parsed, requestMeta(req)) };
  }

  @Get('bank-accounts')
  @RequirePermission('company.bank.view')
  @ApiOperation({ summary: 'Company bank accounts' })
  async bankAccounts(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { bankAccounts: await this.settings.listBankAccounts(ctx) };
  }

  @Post('bank-accounts')
  @HttpCode(200)
  @RequirePermission('company.bank.manage')
  @ApiOperation({ summary: 'Add a bank account. The IBAN must pass the mod-97 check.' })
  async createBankAccount(@Req() req: Request, @Param('companyId') companyId: string) {
    const parsed = parse(bankAccountCreateSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return { bankAccount: await this.settings.createBankAccount(ctx, parsed, requestMeta(req)) };
  }

  @Patch('bank-accounts/:id')
  @idParam
  @RequirePermission('company.bank.manage')
  @ApiOperation({
    summary:
      'Edit, deactivate or show a bank account on invoices. expectedVersion must match. Showing one hides the others.',
  })
  async updateBankAccount(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = parse(bankAccountPatchSchema, unknownBody(req));
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return {
      bankAccount: await this.settings.updateBankAccount(ctx, id, parsed, requestMeta(req)),
    };
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(issueMessage(parsed.error));
  }
  return parsed.data;
}
