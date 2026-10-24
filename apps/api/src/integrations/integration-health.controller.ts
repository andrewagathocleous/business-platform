import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../authz/require-permission.decorator';
import { requireActor, requireContext } from '../commerce/http';
import { IntegrationHealthService } from './integration-health.service';

const companyIdParam = ApiParam({
  name: 'companyId',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

@ApiTags('integrations')
@companyIdParam
@Controller('c/:companyId/integrations')
export class IntegrationHealthController {
  constructor(@Inject(IntegrationHealthService) private readonly health: IntegrationHealthService) {}

  @Get('health')
  @RequirePermission('integration.view')
  @ApiOperation({
    summary: 'Store connection and printing health from the database. Makes no provider call.',
  })
  async read(@Req() req: Request, @Param('companyId') companyId: string) {
    const ctx = requireContext(req, companyId);
    requireActor(ctx);
    return this.health.read(ctx);
  }
}
