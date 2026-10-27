import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthController } from './auth.controller';
import { CLOCK, SystemClock } from './clock';
import { DevLoginService } from './dev-login.service';
import { InvitationService } from './invitation.service';
import { MeController } from './me.controller';
import { OidcService } from './oidc.service';
import { OwnerEnrolmentService } from './owner-enrolment.service';
import { SessionService } from './session.service';

@Module({
  imports: [AuditModule],
  controllers: [AuthController, MeController],
  providers: [
    SystemClock,
    { provide: CLOCK, useExisting: SystemClock },
    SessionService,
    DevLoginService,
    InvitationService,
    OwnerEnrolmentService,
    OidcService,
  ],
  exports: [SessionService, CLOCK],
})
export class IdentityModule {}
