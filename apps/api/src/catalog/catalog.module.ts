import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [AuditModule],
  controllers: [CatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}
