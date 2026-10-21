import { describe, expect, it } from 'vitest';
import type { Clock } from '../identity/clock';
import { hashToken } from '../identity/tokens';
import { ServiceIdentityAuthenticator } from './service-identity-auth';

const ID = '00000000-0000-4000-8000-0000000000aa';
const COMPANY = '00000000-0000-4000-8000-0000000000bb';
const SECRET = 'unit-test-service-secret';
const NOW = new Date('2026-10-21T00:00:00.000Z');

const clock: Clock = { now: () => NOW };

function authenticator(expiresAt: Date | null) {
  const row = {
    id: ID,
    companyId: COMPANY,
    name: 'unit',
    permissions: ['store.events.ingest'],
    status: 'active',
    revokedAt: null,
    expiresAt,
    secretHash: hashToken(SECRET),
  };
  const prisma = {
    client: {
      serviceIdentity: {
        findUnique: () => Promise.resolve(row),
      },
    },
  };
  return new ServiceIdentityAuthenticator(prisma as never, clock);
}

describe('service identity expiry', () => {
  it('rejects a token whose expiry is missing', async () => {
    const result = await authenticator(null).authenticate({ id: ID, secret: SECRET });
    expect(result).toEqual({
      ok: false,
      reason: 'service_token_expired',
      companyId: COMPANY,
      identityId: ID,
    });
  });

  it('rejects a token that is already expired and accepts one that is still in force', async () => {
    const expired = await authenticator(new Date('2020-01-01T00:00:00.000Z')).authenticate({
      id: ID,
      secret: SECRET,
    });
    expect(expired).toMatchObject({ ok: false, reason: 'service_token_expired' });
    const current = await authenticator(new Date('2027-01-01T00:00:00.000Z')).authenticate({
      id: ID,
      secret: SECRET,
    });
    expect(current).toMatchObject({ ok: true, identity: { id: ID, companyId: COMPANY } });
  });
});
