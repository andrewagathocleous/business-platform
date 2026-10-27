import { Injectable, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { AuditModule } from '../audit/audit.module';
import {
  CREDENTIAL_LOG,
  CredentialVault,
  MASTER_KEY_RING,
  type CredentialLog,
  type MasterKeyRing,
} from './credential-vault';

@Injectable()
class NestCredentialLog implements CredentialLog {
  private readonly logger = new Logger(CredentialVault.name);

  info(payload: Record<string, unknown>, message: string): void {
    this.logger.log(`${message} ${JSON.stringify(payload)}`);
  }
}

@Module({
  imports: [AuditModule],
  providers: [
    {
      provide: MASTER_KEY_RING,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): MasterKeyRing => ({
        keys: config.masterKeys,
        activeKeyId: config.activeMasterKeyId,
      }),
    },
    { provide: CREDENTIAL_LOG, useClass: NestCredentialLog },
    CredentialVault,
  ],
  exports: [CredentialVault],
})
export class VaultModule {}
