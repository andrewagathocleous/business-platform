import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { IdentityModule } from '../identity/identity.module';
import { CompanyController } from './company.controller';
import { CompanyReadService } from './company-read.service';
import { CompanySetupController } from './company-setup.controller';
import { CompanySetupService } from './company-setup.service';
import { InvitationAdminService } from './invitation-admin.service';
import { MembershipService } from './membership.service';
import { ServiceIdentityService } from './service-identity.service';

@Module({
  imports: [AuditModule, AuthorizationModule, IdentityModule],
  controllers: [CompanyController, CompanySetupController],
  providers: [
    CompanyReadService,
    CompanySetupService,
    MembershipService,
    InvitationAdminService,
    ServiceIdentityService,
  ],
})
export class TenancyModule {}
