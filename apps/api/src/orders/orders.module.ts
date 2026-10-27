import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationModule } from '../authz/authorization.module';
import { OrderController, OrderFilterController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [AuditModule, AuthorizationModule],
  controllers: [OrderController, OrderFilterController],
  providers: [OrderService],
  exports: [OrderService],
})
export class OrdersModule {}