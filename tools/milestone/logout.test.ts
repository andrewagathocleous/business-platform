import { describe, expect, it } from 'vitest';
import { assertRevokedSession } from './logout';

describe('assertRevokedSession', () => {
  it('requires 204 and replays the saved cookie against /api/me', async () => {
    const seen: string[] = [];
    const detail = await assertRevokedSession({
      sessionCookie: '__Host-bp_session=before-logout',
      logout: () => {
        seen.push('logout');
        return Promise.resolve({ status: 204 });
      },
      me: (cookie) => {
        seen.push(cookie);
        return Promise.resolve({ status: 401 });
      },
    });
    expect(detail).toBe('204');
    expect(seen).toEqual(['logout', '__Host-bp_session=before-logout']);
  });

  it('rejects a logout that returns 200', async () => {
    await expect(
      assertRevokedSession({
        sessionCookie: 'bp_session=old',
        logout: () => Promise.resolve({ status: 200 }),
        me: () => Promise.resolve({ status: 401 }),
      }),
    ).rejects.toThrow('expected 204, got 200');
  });

  it('rejects when the saved cookie is still a session', async () => {
    await expect(
      assertRevokedSession({
        sessionCookie: 'bp_session=old',
        logout: () => Promise.resolve({ status: 204 }),
        me: (cookie) => {
          expect(cookie).toBe('bp_session=old');
          return Promise.resolve({ status: 200 });
        },
      }),
    ).rejects.toThrow('expected 401, got 200');
  });
});
