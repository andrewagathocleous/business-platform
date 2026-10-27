import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolClient } from 'pg';
import { PrismaClient } from './generated/prisma/client';

export { Prisma, PrismaClient } from './generated/prisma/client';

/**
 * Creates a Prisma client for one Postgres URL.
 * Pass DATABASE_URL (bp_app) for the API, the worker and integration tests.
 * Pass DATABASE_URL_OWNER (bp_owner) only for migrations and the seed.
 *
 * Company-scoped tables are protected by forced RLS. Use TenantDb.run for them.
 * A raw client query against those tables is a review defect: without a tenant
 * transaction it returns no rows, and with a leaked session setting it is unsafe.
 */
export function createPrismaClient(url: string): PrismaClient {
  const pool = new Pool({ connectionString: url });
  // Prisma's query compiler issues an `include` as overlapping queryRaw calls on one
  // interactive-transaction client. pg 8 queues the second call and warns that pg 9
  // will reject it. Run one query at a time on each pooled client.
  pool.on('connect', (client) => {
    serializeClientQueries(client);
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({ adapter });
}

/**
 * Serialises only the Promise form `query(text | config[, values])`.
 * Callback queries, COPY, and other Submittable streams are returned unchanged.
 * A rejected Promise query does not stall the next one.
 */
export function serializeClientQueries(client: PoolClient): void {
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  let tail: Promise<void> = Promise.resolve();
  client.query = ((...args: unknown[]) => {
    if (!isPromiseQuery(args)) {
      return original(...args);
    }
    const run = tail.then(() => original(...args));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }) as PoolClient['query'];
}

/** Promise form, and not a Submittable (an object with a `submit` function). */
function isPromiseQuery(args: readonly unknown[]): boolean {
  if (args.length < 1 || args.length > 2) {
    return false;
  }
  if (typeof args[args.length - 1] === 'function') {
    return false;
  }
  const first = args[0];
  if (isSubmittable(first)) {
    return false;
  }
  return typeof first === 'string' || (typeof first === 'object' && first !== null);
}

function isSubmittable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && typeof (value as { submit?: unknown }).submit === 'function';
}
