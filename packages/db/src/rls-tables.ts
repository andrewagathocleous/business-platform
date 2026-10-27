/**
 * Tables that have company_id but are identity, tenancy or infrastructure.
 * They are not RLS-scoped. Only their owning services may touch them, and every
 * access is checked in application code (ADR-0003).
 *
 * Every other table with company_id has RLS enabled and forced.
 * Company-scoped rows are read and written only through TenantDb.run, which sets
 * app.company_id for the transaction. Do not query those models on the raw client.
 */
export const RLS_EXEMPT_TABLES = [
  'automation_switch',
  'invitation',
  'job',
  'membership',
  'role',
  'service_identity',
] as const;

export type RlsExemptTable = (typeof RLS_EXEMPT_TABLES)[number];

export function isRlsExempt(table: string): table is RlsExemptTable {
  return (RLS_EXEMPT_TABLES as readonly string[]).includes(table);
}
