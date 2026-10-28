import {
  BadRequestException,
  Controller,
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
import { issueMessage, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { CreditNoteService } from './credit-note.service';

/** A reason has a character that is not whitespace. Kept as typed. */
const reason = z
  .string()
  .max(500)
  .refine((value) => /\S/.test(value), 'reason is required');

const createBody = z
  .object({
    reason,
    full: z.literal(true).optional(),
    lines: z
      .array(z.object({ invoiceLineId: z.uuid(), quantity: z.unknown() }).strict())
      .min(1)
      .max(200)
      .optional(),
  })
  .strict()
  .refine((body) => (body.full === true) !== (body.lines !== undefined), {
    message: 'send either full: true or lines',
  });

const patchBody = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    reason: reason.optional(),
    lines: z
      .array(z.object({ id: z.uuid(), quantity: z.unknown() }).strict())
      .min(1)
      .max(200)
      .optional(),
  })
  .strict()
  .refine((body) => body.reason !== undefined || body.lines !== undefined, {
    message: 'a field is required',
  });

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

@ApiTags('credit-notes')
@companyIdParam
@Controller('c/:companyId')
export class CreditNoteController {
  constructor(@Inject(CreditNoteService) private readonly creditNotes: CreditNoteService) {}

  @Post('invoices/:id/credit-notes')
  @HttpCode(200)
  @idParam
  @RequirePermission('invoice.credit')
  @ApiOperation({
    summary:
      'Create a draft credit note against an issued invoice: { reason, full: true } or { reason, lines: [{ invoiceLineId, quantity }] }. Everything else comes from the original. 409 over_credit when a line would be credited beyond its quantity.',
  })
  async create(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = createBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const creditNote = await this.creditNotes.create(
      requireContext(req, companyId),
      id,
      parsed.data,
      requestMeta(req),
    );
    return { creditNote };
  }

  @Patch('credit-notes/:id')
  @idParam
  @RequirePermission('invoice.credit')
  @ApiOperation({
    summary:
      'Edit a draft credit note: only the reason and the quantities of its lines. expectedVersion must match.',
  })
  async update(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('id') id: string,
  ) {
    const parsed = patchBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const creditNote = await this.creditNotes.update(
      requireContext(req, companyId),
      id,
      parsed.data,
      requestMeta(req),
    );
    return { creditNote };
  }
}
