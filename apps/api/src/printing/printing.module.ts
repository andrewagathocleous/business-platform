import { Module } from '@nestjs/common';
import { MockPrintProvider, PrintNodeProvider, type SafeFetch } from '@bp/integrations';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { OutboundModule, SAFE_FETCH } from '../outbound/outbound.module';
import { StorageModule } from '../storage/storage.module';
import { VaultModule } from '../vault/vault.module';
import { PrintController } from './print.controller';
import { createPrintProviderRegistry, PrintProviderRegistry } from './print-providers';
import { PrintProcessor } from './print.processor';
import { PrintService } from './print.service';
import { MOCK_PRINT_PROVIDER } from './print.tokens';
import { PrintNodeCredentials } from './printnode-credentials';

@Module({
  imports: [AuditModule, AuthorizationModule, StorageModule, OutboundModule, VaultModule],
  controllers: [PrintController],
  providers: [
    PrintService,
    PrintProcessor,
    PrintNodeCredentials,
    {
      provide: MOCK_PRINT_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MockPrintProvider | null =>
        config.appEnv === 'development' || config.appEnv === 'test'
          ? new MockPrintProvider(config.mockPrintRoot)
          : null,
    },
    {
      provide: PrintProviderRegistry,
      inject: [APP_CONFIG, MOCK_PRINT_PROVIDER, SAFE_FETCH, PrintNodeCredentials],
      useFactory: (
        config: AppConfig,
        mock: MockPrintProvider | null,
        fetch: SafeFetch,
        keys: PrintNodeCredentials,
      ) =>
        createPrintProviderRegistry({
          appEnv: config.appEnv,
          mock,
          printnode: new PrintNodeProvider({
            fetch,
            apiKeyFor: (companyId) => keys.apiKeyFor(companyId),
            ...(config.printNodeBaseUrl ? { baseUrl: config.printNodeBaseUrl } : {}),
          }),
        }),
    },
  ],
  exports: [PrintProcessor, PrintService, MOCK_PRINT_PROVIDER, PrintProviderRegistry],
})
export class PrintingModule {}
