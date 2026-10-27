/**
 * Proves logout revoked the session on the server.
 * The caller saves the session cookie before logout. The follow-up `/api/me`
 * sends that saved cookie, including when the logout response cleared the jar.
 */
export async function assertRevokedSession(input: {
  sessionCookie: string;
  logout: () => Promise<{ status: number }>;
  me: (sessionCookie: string) => Promise<{ status: number }>;
}): Promise<string> {
  if (input.sessionCookie.length === 0) {
    throw new Error('session cookie is missing');
  }
  const saved = input.sessionCookie;
  const logout = await input.logout();
  if (logout.status !== 204) {
    throw new Error(`expected 204, got ${String(logout.status)}`);
  }
  const me = await input.me(saved);
  if (me.status !== 401) {
    throw new Error(`expected 401, got ${String(me.status)}`);
  }
  return '204';
}
