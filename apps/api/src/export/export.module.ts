import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { AccountantExportService } from './accountant-export.service';
import { ExportController } from './export.controller';

@Module({
  imports: [AuditModule, StorageModule],
  controllers: [ExportController],
  providers: [AccountantExportService],
})
export class ExportModule {}
