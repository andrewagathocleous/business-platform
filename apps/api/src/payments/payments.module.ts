import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';

@Module({
  imports: [AuditModule],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentsModule {}
