import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

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
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

export { PrismaClient };
