import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { VaultModule } from '../vault/vault.module';
import { IntegrationHealthController } from './integration-health.controller';
import { IntegrationHealthService } from './integration-health.service';
import { PrestashopConnectionController } from './prestashop-connection.controller';
import { PrestashopConnectionService } from './prestashop-connection.service';
import { PrintNodeAccountController } from './printnode-account.controller';
import { PrintNodeAccountService } from './printnode-account.service';

@Module({
  imports: [AuditModule, AuthorizationModule, VaultModule],
  controllers: [PrestashopConnectionController, PrintNodeAccountController, IntegrationHealthController],
  providers: [PrestashopConnectionService, PrintNodeAccountService, IntegrationHealthService],
})
export class IntegrationsModule {}
