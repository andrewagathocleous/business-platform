import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, MetadataScanner } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module';
import { IdentityModule } from '../identity/identity.module';
import { AuthorizationGuard } from './authorization.guard';
import { CompanyAccessService } from './company-access.service';
import { RoutePolicyChecker } from './route-policy';
import { ServiceIdentityAuthenticator } from './service-identity-auth';

@Module({
  imports: [DiscoveryModule, AuditModule, IdentityModule],
  providers: [
    MetadataScanner,
    RoutePolicyChecker,
    CompanyAccessService,
    ServiceIdentityAuthenticator,
    {
      provide: APP_GUARD,
      useClass: AuthorizationGuard,
    },
  ],
  exports: [CompanyAccessService, ServiceIdentityAuthenticator],
})
export class AuthorizationModule {}
