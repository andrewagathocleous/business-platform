import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../authz/public.decorator';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../database/prisma.service';
import { readyPayload, type ReadyBody } from './ready-body';

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Process is up' })
  @ApiOkResponse({ schema: { properties: { status: { type: 'string', example: 'ok' } } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Database is reachable as bp_app' })
  @ApiOkResponse({ schema: { properties: { status: { type: 'string', example: 'ok' } } } })
  async ready(): Promise<ReadyBody> {
    await this.prisma.client.$queryRaw`SELECT 1`;
    return readyPayload(this.config.appEnv, process.env['E2E_RUN_ID']);
  }
}
