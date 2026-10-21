import { Module } from '@nestjs/common';
import { MockPrintProvider } from '@bp/integrations';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { StorageModule } from '../storage/storage.module';
import { PrintController } from './print.controller';
import { PrintProcessor } from './print.processor';
import { PrintService } from './print.service';
import { PRINT_PROVIDER } from './print.tokens';

@Module({
  imports: [AuditModule, AuthorizationModule, StorageModule],
  controllers: [PrintController],
  providers: [
    PrintService,
    PrintProcessor,
    {
      provide: PRINT_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new MockPrintProvider(config.mockPrintRoot),
    },
  ],
  exports: [PrintProcessor, PrintService, PRINT_PROVIDER],
})
export class PrintingModule {}
