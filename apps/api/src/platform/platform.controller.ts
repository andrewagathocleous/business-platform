import { BadRequestException, Controller, Get, HttpCode, Inject, Post, Put, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { PlatformOwner } from '../authz/platform-owner.decorator';
import { requestMeta } from '../identity/request-meta';
import { readStaffSession } from '../identity/staff-session';
import { PlatformService } from './platform.service';

const companyBody = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    tradingName: z.string().trim().min(1).max(200),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .regex(/^[A-Za-z]{2}$/)
      .default('CY'),
    timezone: z.string().trim().min(1).max(64).default('Asia/Nicosia'),
    defaultCurrency: z
      .string()
      .trim()
      .length(3)
      .regex(/^[A-Za-z]{3}$/)
      .default('EUR'),
    isFictional: z.boolean().default(false),
  })
  .strict();

const switchBody = z
  .object({
    enabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

@ApiTags('platform')
@Controller('platform')
@PlatformOwner()
export class PlatformController {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Get('companies')
  @ApiOperation({ summary: 'List companies. Platform owner only.' })
  @ApiOkResponse({ description: 'Every company, including ones the owner has no membership in' })
  async companies() {
    return { companies: await this.platform.listCompanies() };
  }

  @Post('companies')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a company, copy role templates, add example tax codes and set switches off',
  })
  async createCompany(@Req() req: Request) {
    const parsed = companyBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    if (!isTimezone(parsed.data.timezone)) {
      throw new BadRequestException('timezone is invalid');
    }
    const session = requireOwner(req);
    return {
      company: await this.platform.createCompany(
        session.userId,
        session.email,
        {
          legalName: parsed.data.legalName,
          tradingName: parsed.data.tradingName,
          countryCode: parsed.data.countryCode.toUpperCase(),
          timezone: parsed.data.timezone,
          defaultCurrency: parsed.data.defaultCurrency.toUpperCase(),
          isFictional: parsed.data.isFictional,
        },
        requestMeta(req),
      ),
    };
  }

  @Put('switches/outbound.all')
  @ApiOperation({ summary: 'Set the global outbound.all switch. Platform owner only.' })
  async outboundAll(@Req() req: Request) {
    const parsed = switchBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    const session = requireOwner(req);
    return this.platform.setOutboundAll(session.userId, session.email, parsed.data.enabled, parsed.data.reason, requestMeta(req));
  }
}

function requireOwner(req: Request): { userId: string; email: string } {
  const session = readStaffSession(req);
  if (!session) {
    throw new BadRequestException('Authentication is required');
  }
  return { userId: session.userId, email: session.email };
}

function isTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function unknownBody(req: Request): unknown {
  return req.body as unknown;
}

function issueMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join(', ');
}
