import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  imports: [AuditModule],
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
