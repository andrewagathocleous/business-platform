import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { VaultModule } from '../vault/vault.module';
import { PrestashopConnectionController } from './prestashop-connection.controller';
import { PrestashopConnectionService } from './prestashop-connection.service';
import { PrintNodeAccountController } from './printnode-account.controller';
import { PrintNodeAccountService } from './printnode-account.service';

@Module({
  imports: [AuditModule, AuthorizationModule, VaultModule],
  controllers: [PrestashopConnectionController, PrintNodeAccountController],
  providers: [PrestashopConnectionService, PrintNodeAccountService],
})
export class IntegrationsModule {}
