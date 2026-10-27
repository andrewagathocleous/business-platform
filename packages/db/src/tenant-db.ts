import type { PrismaClient } from './generated/prisma/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TenantContext = {
  companyId: string;
  actor: string;
  correlationId: string;
};

export type TenantTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$extends' | '$transaction'
>;

/**
 * The only supported way to touch company-scoped tables.
 * set_config(..., true) is transaction-local, so the company id cannot leak across the pool.
 */
export class TenantDb {
  constructor(private readonly prisma: PrismaClient) {}

  async run<T>(
    ctx: TenantContext,
    fn: (tx: TenantTransaction) => Promise<T>,
    options?: { timeoutMs?: number; maxWaitMs?: number },
  ): Promise<T> {
    if (!UUID.test(ctx.companyId)) {
      throw new Error('companyId must be a uuid');
    }
    if (ctx.actor.length === 0 || ctx.correlationId.length === 0) {
      throw new Error('actor and correlationId are required');
    }
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.company_id', ${ctx.companyId}, true)`;
        await tx.$queryRaw`SELECT set_config('app.actor_id', ${ctx.actor}, true)`;
        await tx.$queryRaw`SELECT set_config('app.correlation_id', ${ctx.correlationId}, true)`;
        return fn(tx);
      },
      {
        timeout: options?.timeoutMs ?? 15_000,
        // How long to wait for a pooled connection before the transaction starts.
        ...(options?.maxWaitMs ? { maxWait: options.maxWaitMs } : {}),
      },
    );
  }
}
