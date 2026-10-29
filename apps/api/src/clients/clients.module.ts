import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ClientCsvController } from './client-csv.controller';
import { ClientCsvService } from './client-csv.service';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';

@Module({
  imports: [AuditModule],
  controllers: [ClientCsvController, ClientController],
  providers: [ClientService, ClientCsvService],
  exports: [ClientService],
})
export class ClientsModule {}
