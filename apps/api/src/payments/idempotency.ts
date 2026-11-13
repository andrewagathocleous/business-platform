import { createHash } from 'node:crypto';
import type { Prisma, TenantTransaction } from '@bp/db';
import { CommerceError } from '../commerce/errors';

export type PaymentOperation = 'payment.record' | 'allocation.create' | 'refund.record';
export type IdempotentResult = { status: number; body: Prisma.JsonValue };

/** Sort object keys recursively, preserving arrays and the parsed body's string values. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function idempotencyKey(value: unknown): string {
  if (value === undefined) {
    throw new CommerceError(
      400,
      'idempotency_key_required',
      'idempotency_record',
      null,
      'idempotency_key_required',
    );
  }
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,200}$/.test(value)) {
    throw new CommerceError(
      400,
      'invalid_idempotency_key',
      'idempotency_record',
      null,
      'Idempotency-Key must be 1–200 printable ASCII characters',
    );
  }
  return value;
}

/** Must be the first lock in the caller's tenant transaction. Results and writes commit together. */
export async function idempotent(
  tx: TenantTransaction,
  companyId: string,
  actor: string,
  operation: PaymentOperation,
  key: string,
  body: unknown,
  run: () => Promise<Prisma.InputJsonObject>,
): Promise<IdempotentResult> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify(canonical({ operation, body })))
    .digest('hex');
  const lock = JSON.stringify([companyId, operation, key]);
  // Cast void to text: Prisma cannot deserialize PostgreSQL's void return type.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))::text`;
  const previous = await tx.idempotencyRecord.findUnique({
    where: { companyId_operation_key: { companyId, operation, key } },
  });
  if (previous) {
    if (previous.requestHash !== requestHash) {
      throw new CommerceError(
        409,
        'idempotency_key_reused',
        'idempotency_record',
        previous.id,
        'idempotency_key_reused',
      );
    }
    return { status: previous.statusCode, body: previous.response };
  }
  const response = await run();
  const stored = await tx.idempotencyRecord.create({
    data: { companyId, operation, key, requestHash, statusCode: 200, response, createdById: actor },
  });
  return { status: stored.statusCode, body: stored.response };
}
