import { BadRequestException, Controller, Get, Inject, Param, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { CompanyAutomationService, isJobStatus } from './company-automation.service';

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});
const keyParam = ApiParam({
  name: 'key',
  required: true,
  schema: { type: 'string' },
  description: 'Company switch key, such as printing or email.send. outbound.all is not a company switch.',
});

const switchBody = z
  .object({
    enabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Staff routes. These are not under /api/automation, so they use the session
 * and do not take @AutomationRoute().
 * A company admin may change the seven company switches. outbound.all is
 * platform-owner only and returns 404 switch_not_in_company here.
 */
@ApiTags('automation')
@companyIdParam
@Controller('c/:companyId/automation')
export class CompanyAutomationController {
  constructor(@Inject(CompanyAutomationService) private readonly automation: CompanyAutomationService) {}

  @Get('switches')
  @RequirePermission('automation.view')
  @ApiOperation({ summary: 'Company automation switches. The global outbound.all switch is not included.' })
  async listSwitches(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.automation.listSwitches(requireContext(req, companyId));
  }

  @Put('switches/:key')
  @keyParam
  @RequirePermission('automation.manage')
  @ApiOperation({ summary: 'Enable or disable a company switch. reason is required and the change is audited.' })
  async setSwitch(@Req() req: Request, @Param('companyId') companyId: string, @Param('key') key: string) {
    const parsed = switchBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.automation.setSwitch(
      requireContext(req, companyId),
      key,
      parsed.data.enabled,
      parsed.data.reason,
      requestMeta(req),
    );
  }

  @Get('jobs')
  @RequirePermission('automation.view')
  @ApiOperation({ summary: 'Jobs for this company. Payload is omitted. Filter with status.' })
  async listJobs(@Req() req: Request, @Param('companyId') companyId: string) {
    return this.automation.listJobs(requireContext(req, companyId), jobQuery(req));
  }
}

function jobQuery(req: Request): {
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'held' | 'uncertain' | 'cancelled';
  page: number;
  pageSize: number;
} {
  const statusRaw = req.query['status'];
  if (statusRaw !== undefined && (typeof statusRaw !== 'string' || !isJobStatus(statusRaw))) {
    throw new BadRequestException('status is not a job status');
  }
  return {
    ...(typeof statusRaw === 'string' && isJobStatus(statusRaw) ? { status: statusRaw } : {}),
    page: integer(req.query['page'], 'page', 1, 1_000_000, 1),
    pageSize: integer(req.query['pageSize'], 'pageSize', 1, 100, 50),
  };
}

function integer(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${name} is out of range`);
  }
  return parsed;
}
