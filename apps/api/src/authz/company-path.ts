const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CompanyPath =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'id'; companyId: string };

export function companyIdFromPath(path: string): CompanyPath {
  const automation = /^\/api\/automation\/v1\/c\/([^/]+)(?:\/|$)/.exec(path);
  const staff = /^\/api\/c\/([^/]+)(?:\/|$)/.exec(path);
  const raw = automation?.[1] ?? staff?.[1];
  if (!raw) {
    return { kind: 'none' };
  }
  if (!UUID.test(raw)) {
    return { kind: 'invalid' };
  }
  return { kind: 'id', companyId: raw.toLowerCase() };
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
