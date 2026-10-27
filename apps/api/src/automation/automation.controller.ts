import { BadRequestException, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../authz/require-permission.decorator';
import { issueMessage, requireContext, unknownBody } from '../commerce/http';
import { requestMeta } from '../identity/request-meta';
import { AutomationRoute } from './automation-route.decorator';
import { InboxService } from './inbox.service';
import { StoreSyncService, type StoreSyncCounts } from './store-sync.service';

const eventBody = z
  .object({
    eventId: z.string().min(1).max(200),
    topic: z.enum(['orders/create', 'orders/updated']),
    occurredAt: z.string().min(1).max(64),
    payload: z.unknown(),
  })
  .strict();

const connectionIdParam = ApiParam({
  name: 'connectionId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

/**
 * Reachability check for a company service identity.
 * Session cookies are not accepted. The caller needs `store.events.ingest`.
 */
@ApiTags('automation')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@AutomationRoute()
@Controller('automation/v1/c/:companyId')
export class AutomationController {
  constructor(
    @Inject(InboxService) private readonly inbox: InboxService,
    @Inject(StoreSyncService) private readonly sync: StoreSyncService,
  ) {}

  @Post('store-sync')
  @HttpCode(202)
  @RequirePermission('store.sync.trigger')
  @ApiOperation({
    summary:
      'Enqueue a PrestaShop poll for each due live connection. Bearer token with store.sync.trigger. Writes no audit row.',
  })
  @ApiAcceptedResponse({
    description: 'How many connections were queued, not yet due, or skipped. A duplicate trigger in the same interval inserts nothing.',
  })
  storeSync(@Req() req: Request, @Param('companyId') companyId: string): Promise<StoreSyncCounts> {
    return this.sync.trigger(requireContext(req, companyId));
  }

  @Get('ping')
  @RequirePermission('store.events.ingest')
  @ApiOperation({
    summary: 'Automation ping. Bearer service token only; requires store.events.ingest.',
  })
  @ApiOkResponse({ description: 'The service identity is accepted for this company' })
  ping(): { ok: true } {
    return { ok: true };
  }

  @Post('store-connections/:connectionId/events')
  @connectionIdParam
  @HttpCode(202)
  @RequirePermission('store.events.ingest')
  @ApiOperation({ summary: 'Accept a mock store event and enqueue inbox.process in the same transaction' })
  @ApiAcceptedResponse({ description: 'The event was stored. Duplicate event ids do not create a second inbox row.' })
  async events(
    @Req() req: Request,
    @Param('companyId') companyId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<{ inboxId: string; status: 'accepted' | 'duplicate' }> {
    const parsed = eventBody.safeParse(unknownBody(req));
    if (!parsed.success) {
      throw new BadRequestException(issueMessage(parsed.error));
    }
    return this.inbox.ingest(requireContext(req, companyId), connectionId, parsed.data, requestMeta(req));
  }
}
