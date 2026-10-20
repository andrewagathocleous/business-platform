import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { IdentityModule } from '../identity/identity.module';
import { CompanyController } from './company.controller';
import { CompanyReadService } from './company-read.service';
import { InvitationAdminService } from './invitation-admin.service';
import { MembershipService } from './membership.service';
import { ServiceIdentityService } from './service-identity.service';

@Module({
  imports: [AuditModule, AuthorizationModule, IdentityModule],
  controllers: [CompanyController],
  providers: [CompanyReadService, MembershipService, InvitationAdminService, ServiceIdentityService],
})
export class TenancyModule {}
