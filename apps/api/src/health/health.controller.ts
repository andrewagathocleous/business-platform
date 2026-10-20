import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../authz/public.decorator';
import { PrismaService } from '../database/prisma.service';

@ApiTags('health')
@Controller('health')
@Public()
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('live')
  @ApiOperation({ summary: 'Process is up' })
  @ApiOkResponse({ schema: { properties: { status: { type: 'string', example: 'ok' } } } })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Database is reachable as bp_app' })
  @ApiOkResponse({ schema: { properties: { status: { type: 'string', example: 'ok' } } } })
  async ready(): Promise<{ status: 'ok' }> {
    await this.prisma.client.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
