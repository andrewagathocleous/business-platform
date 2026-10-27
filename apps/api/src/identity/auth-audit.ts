import type { AuditRecord, AuditService } from '../audit/audit.service';
import type { PrismaService } from '../database/prisma.service';

/** Writes one audit row in its own transaction. Denials that name a company set app.company_id. */
export async function writeAudit(prisma: PrismaService, audit: AuditService, input: AuditRecord): Promise<void> {
  await prisma.client.$transaction(async (tx) => {
    if (input.companyId) {
      await tx.$queryRaw`SELECT set_config('app.company_id', ${input.companyId}, true)`;
    }
    await audit.record(tx, input);
  });
}
