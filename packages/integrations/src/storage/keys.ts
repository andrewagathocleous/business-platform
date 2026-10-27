import { StoragePathError } from './path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z0-9_]+$/;

/**
 * Server-generated object key. The caller never supplies the path.
 * Shape: `companies/<companyId>/<kind>/<yyyy>/<mm>/<uuid>.pdf`.
 */
export function storageKey(input: { companyId: string; kind: string; id: string; at: Date }): string {
  const companyId = input.companyId.toLowerCase();
  const id = input.id.toLowerCase();
  if (!UUID.test(companyId) || !UUID.test(id) || !KIND.test(input.kind)) {
    throw new StoragePathError('storage key is invalid');
  }
  const year = String(input.at.getUTCFullYear()).padStart(4, '0');
  const month = String(input.at.getUTCMonth() + 1).padStart(2, '0');
  return `companies/${companyId}/${input.kind}/${year}/${month}/${id}.pdf`;
}
