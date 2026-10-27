import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ClientController } from './client.controller';
import { ClientService } from './client.service';

@Module({
  imports: [AuditModule],
  controllers: [ClientController],
  providers: [ClientService],
  exports: [ClientService],
})
export class ClientsModule {}
