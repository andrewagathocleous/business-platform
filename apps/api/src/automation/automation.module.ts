import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { AutomationController } from './automation.controller';

@Module({
  imports: [AuditModule, AuthorizationModule],
  controllers: [AutomationController],
})
export class AutomationModule {}
