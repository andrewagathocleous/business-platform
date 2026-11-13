import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/**
 * Marks this file's queued jobs cancelled. Do not delete them: a print job's
 * queue row is referenced by `print_job`, and a delete would either fail or
 * drop that link. Cancelled rows are not due, so a later file's drain cannot
 * count or run them.
 */
export async function cancelQueuedJobs(
  app: INestApplication | undefined,
  companyIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(companyIds.filter((id) => id.length > 0))];
  if (!app || ids.length === 0) {
    return;
  }
  await app.get(PrismaService).client.job.updateMany({
    where: { companyId: { in: ids }, status: 'queued' },
    data: { status: 'cancelled' },
  });
}
