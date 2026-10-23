import { Inject, Injectable } from '@nestjs/common';
import { TenantDb } from '@bp/db';
import { ProviderRejected } from '@bp/integrations';
import { getCorrelationId } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import { CredentialVault } from '../vault/credential-vault';

/**
 * Loads the newest live PrintNode API key for one company.
 * The read and the decrypt each run in their own transaction. Neither is called
 * while another transaction is open.
 */
@Injectable()
export class PrintNodeCredentials {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) prisma: PrismaService,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async apiKeyFor(companyId: string): Promise<string> {
    const id = await this.newestId(companyId);
    if (!id) {
      throw new ProviderRejected('not_configured');
    }
    return this.vault.decrypt(companyId, id);
  }

  /** A non-revoked `printnode` / `api_key` row. The plaintext is not opened. */
  async hasUsableKey(companyId: string): Promise<boolean> {
    const id = await this.newestId(companyId);
    return id !== null;
  }

  private async newestId(companyId: string): Promise<string | null> {
    const correlationId = getCorrelationId();
    if (!correlationId) {
      throw new Error('printnode credential lookup requires a correlation id');
    }
    return this.tenants.run({ companyId, actor: 'system', correlationId }, async (tx) => {
      const row = await tx.integrationCredential.findFirst({
        where: {
          companyId,
          provider: 'printnode',
          label: 'api_key',
          revokedAt: null,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }
}
