import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authz/require-permission.decorator';
import { AutomationRoute } from './automation-route.decorator';

/**
 * Reachability check for a company service identity.
 * Session cookies are not accepted. The caller needs `store.events.ingest`.
 */
@ApiTags('automation')
@ApiParam({ name: 'companyId', required: true, schema: { type: 'string', format: 'uuid' } })
@AutomationRoute()
@Controller('automation/v1/c/:companyId')
export class AutomationController {
  @Get('ping')
  @RequirePermission('store.events.ingest')
  @ApiOperation({
    summary: 'Automation ping. Bearer service token only; requires store.events.ingest.',
  })
  @ApiOkResponse({ description: 'The service identity is accepted for this company' })
  ping(): { ok: true } {
    return { ok: true };
  }
}
