import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';

@Module({
  imports: [AuditModule, StorageModule],
  controllers: [InvoiceController],
  providers: [InvoiceService],
})
export class InvoicesModule {}
