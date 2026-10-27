import { Module } from '@nestjs/common';
import { LocalFsStorage } from '@bp/integrations';
import { APP_CONFIG, type AppConfig } from '../config/env';

export const STORAGE = Symbol('STORAGE');

@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new LocalFsStorage(config.storageRoot),
    },
  ],
  exports: [STORAGE],
})
export class StorageModule {}
