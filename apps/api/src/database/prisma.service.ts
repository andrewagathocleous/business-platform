import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@bp/db';
import { APP_CONFIG, type AppConfig } from '../config/env';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = createPrismaClient(config.databaseUrl);
  }

  onModuleDestroy(): Promise<void> {
    return this.client.$disconnect();
  }
}
