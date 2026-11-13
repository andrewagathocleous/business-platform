import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { StorageModule } from '../storage/storage.module';
import { CreditNoteController } from './credit-note.controller';
import { CreditNoteService } from './credit-note.service';
import { InvoiceController } from './invoice.controller';
import { InvoiceService } from './invoice.service';
import { QuoteController } from './quote.controller';

@Module({
  imports: [AuditModule, StorageModule],
  controllers: [InvoiceController, CreditNoteController, QuoteController],
  providers: [InvoiceService, CreditNoteService],
})
export class InvoicesModule {}
