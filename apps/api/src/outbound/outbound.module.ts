import { Global, Module } from '@nestjs/common';
import { createSafeFetch } from '@bp/integrations';
import { AppConfigModule } from '../config/config.module';
import { APP_CONFIG, type AppConfig } from '../config/env';

/** One outbound client for every connector. PrintNode uses it; PrestaShop will too. */
export const SAFE_FETCH = Symbol('SAFE_FETCH');

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: SAFE_FETCH,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        createSafeFetch({
          appEnv: config.appEnv,
          allowLoopbackForTests: config.outboundAllowLoopbackForTests,
        }),
    },
  ],
  exports: [SAFE_FETCH],
})
export class OutboundModule {}
