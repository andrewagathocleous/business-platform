import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FinanceSettingsController } from './finance-settings.controller';
import { FinanceSettingsService } from './finance-settings.service';

@Module({
  imports: [AuditModule],
  controllers: [FinanceSettingsController],
  providers: [FinanceSettingsService],
})
export class FinanceSettingsModule {}
