import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthorizationModule } from './authz/authorization.module';
import { AppConfigModule } from './config/config.module';
import { APP_CONFIG, type AppConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { AutomationModule } from './automation/automation.module';
import { CatalogModule } from './catalog/catalog.module';
import { ClientsModule } from './clients/clients.module';
import { DocumentsModule } from './documents/documents.module';
import { ExportModule } from './export/export.module';
import { FinanceSettingsModule } from './finance-settings/finance-settings.module';
import { HealthModule } from './health/health.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { InvoicesModule } from './invoices/invoices.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { ReportsModule } from './reports/reports.module';
import { OutboundModule } from './outbound/outbound.module';
import { VaultModule } from './vault/vault.module';
import { ApiExceptionFilter } from './http/exception.filter';
import { IdentityModule } from './identity/identity.module';
import { LoggingModule } from './logging/logging.module';
import { PlatformModule } from './platform/platform.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { buildThrottlerOptions } from './throttler/throttler';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    DatabaseModule,
    AuditModule,
    AuthorizationModule,
    IdentityModule,
    TenancyModule,
    PlatformModule,
    AutomationModule,
    ClientsModule,
    DocumentsModule,
    ExportModule,
    CatalogModule,
    FinanceSettingsModule,
    IntegrationsModule,
    InvoicesModule,
    OrdersModule,
    PaymentsModule,
    ReportsModule,
    OutboundModule,
    VaultModule,
    HealthModule,
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildThrottlerOptions(config),
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
