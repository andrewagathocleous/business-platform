import { parseArgs } from 'node:util';
import type { Prisma, PrismaClient } from '@bp/db';
import { redactDetails } from '../audit/redact-details';
import { uuidv7 } from '../correlation/correlation';
import { hashToken, randomToken } from '../identity/tokens';

export const ENROLMENT_TTL_MS = 30 * 60 * 1000;

export type OwnerCliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = [
  'usage: owner <command>',
  '  enrol --email <address> --name <display name> --origin <https origin> [--entra-oid <object id>] [--relink]',
  '  list',
  '  revoke-sessions --email <address>',
  '  disable --email <address>',
].join('\n');

type Tx = Prisma.TransactionClient;

/** A refusal: the command's transaction rolls back, a denial is audited, and the exit code is 1. */
class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly objectId: string | null,
  ) {
    super(reason);
  }
}

class UsageError extends Error {}

/**
 * The platform-owner CLI. It runs with `DATABASE_URL_OWNER` (bp_owner), never inside the API.
 * It is the only code that sets `is_platform_owner` or creates an enrolment.
 * Every command writes one audit event (actor type system, label `cli`, no company),
 * refusals included. Tokens and their hashes never reach the audit or `list`.
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */
export async function runOwnerCli(argv: readonly string[], prisma: PrismaClient, io: OwnerCliIo): Promise<number> {
  const [command, ...rest] = argv;
  const correlationId = uuidv7();
  try {
    switch (command) {
      case 'enrol':
        return await enrol(rest, prisma, io, correlationId);
      case 'list':
        return await list(rest, prisma, io, correlationId);
      case 'revoke-sessions':
        return await revokeSessions(rest, prisma, io, correlationId);
      case 'disable':
        return await disable(rest, prisma, io, correlationId);
      default:
        throw new UsageError(command ? `unknown command ${command}` : 'missing command');
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err(USAGE);
      return 2;
    }
    if (error instanceof Refusal) {
      return 1;
    }
    io.err(`owner ${command ?? ''} failed: ${error instanceof Error ? error.name : 'Error'}`);
    return 1;
  }
}

async function enrol(args: readonly string[], prisma: PrismaClient, io: OwnerCliIo, correlationId: string) {
  const { values } = parse(args, {
    email: { type: 'string' },
    name: { type: 'string' },
    origin: { type: 'string' },
    'entra-oid': { type: 'string' },
    relink: { type: 'boolean' },
  });
  const email = requireEmail(values.email);
  const name = requireName(values.name);
  const origin = requireOrigin(values.origin);
  const expectedEntraOid = optionalEntraOid(values['entra-oid']);
  const relink = values.relink === true;
  const token = randomToken();
  const action = 'platform.owner_enrolment_created';
  const done = await refusable(prisma, io, correlationId, action, async (tx) => {
    const found = await tx.userAccount.findFirst({ where: { email }, select: { id: true } });
    let userId: string;
    let created = false;
    let relinked = false;
    if (found) {
      // Same lock order as the OIDC callback: open enrolments, then the user row.
      await lockOpenEnrolments(tx, found.id);
      // FOR NO KEY UPDATE: it still serialises with sign-ins and invitations (which take the
      // same mode), but leaves the KEY SHARE that a foreign key to this account needs.
      await tx.$queryRaw`SELECT id FROM user_account WHERE id = ${found.id}::uuid FOR NO KEY UPDATE`;
      const user = await tx.userAccount.findUniqueOrThrow({ where: { id: found.id } });
      if (user.status !== 'active') {
        throw new Refusal('user_disabled', user.id);
      }
      const linked = await tx.userIdentity.count({ where: { userId: user.id, provider: 'entra' } });
      if (linked > 0 && !relink) {
        io.err(`${email} already has a Microsoft sign-in. Use --relink to replace it.`);
        throw new Refusal('identity_linked', user.id);
      }
      if (linked > 0) {
        await tx.userIdentity.deleteMany({ where: { userId: user.id, provider: 'entra' } });
        await revokeUserSessions(tx, user.id, 'owner_relink');
        relinked = true;
      }
      if (!user.isPlatformOwner) {
        await tx.userAccount.update({ where: { id: user.id }, data: { isPlatformOwner: true } });
      }
      userId = user.id;
    } else {
      const user = await tx.userAccount.create({
        data: { email, displayName: name, locale: 'en', isPlatformOwner: true, status: 'active' },
        select: { id: true },
      });
      userId = user.id;
      created = true;
    }
    await tx.platformOwnerEnrolment.updateMany({
      where: { userId, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const expiresAt = new Date(Date.now() + ENROLMENT_TTL_MS);
    const enrolment = await tx.platformOwnerEnrolment.create({
      data: { userId, tokenHash: hashToken(token), expectedEntraOid, expiresAt },
      select: { id: true },
    });
    await writeAudit(tx, correlationId, action, 'success', 'user_account', userId, {
      enrolmentId: enrolment.id,
      created,
      relinked,
      matchesBy: expectedEntraOid ? 'entra_oid' : 'verified_email',
      expiresAt: expiresAt.toISOString(),
    });
    return { expiresAt };
  });
  io.out(`Enrolment link for ${email}. It works once and expires at ${done.expiresAt.toISOString()}:`);
  io.out(`${origin}/api/auth/oidc/start?enrolment=${token}`);
  return 0;
}

async function list(args: readonly string[], prisma: PrismaClient, io: OwnerCliIo, correlationId: string) {
  parse(args, {});
  const owners = await prisma.userAccount.findMany({
    where: { isPlatformOwner: true },
    orderBy: [{ email: 'asc' }],
    select: {
      email: true,
      displayName: true,
      status: true,
      identities: { where: { provider: 'entra' }, select: { lastLoginAt: true } },
    },
  });
  await prisma.$transaction((tx) =>
    writeAudit(tx, correlationId, 'platform.owners_listed', 'success', 'user_account', null, {
      count: owners.length,
    }),
  );
  for (const owner of owners) {
    const identity = owner.identities[0];
    const lastLogin = identity?.lastLoginAt ? identity.lastLoginAt.toISOString() : 'never';
    io.out(
      [owner.email, owner.displayName, owner.status, identity ? 'microsoft: linked' : 'microsoft: not linked', `last login: ${lastLogin}`].join(
        '\t',
      ),
    );
  }
  if (owners.length === 0) {
    io.out('No platform owners.');
  }
  return 0;
}

async function revokeSessions(
  args: readonly string[],
  prisma: PrismaClient,
  io: OwnerCliIo,
  correlationId: string,
) {
  const { values } = parse(args, { email: { type: 'string' } });
  const email = requireEmail(values.email);
  const action = 'platform.owner_sessions_revoked';
  const revoked = await refusable(prisma, io, correlationId, action, async (tx) => {
    const user = await requireOwner(tx, email, io);
    const count = await revokeUserSessions(tx, user.id, 'owner_cli');
    await writeAudit(tx, correlationId, action, 'success', 'user_account', user.id, { revoked: count });
    return count;
  });
  io.out(`Revoked ${String(revoked)} session(s) for ${email}.`);
  return 0;
}

async function disable(args: readonly string[], prisma: PrismaClient, io: OwnerCliIo, correlationId: string) {
  const { values } = parse(args, { email: { type: 'string' } });
  const email = requireEmail(values.email);
  const action = 'platform.owner_disabled';
  await refusable(prisma, io, correlationId, action, async (tx) => {
    const target = await requireOwner(tx, email, io);
    await lockOpenEnrolments(tx, target.id);
    // Every active owner, in id order, so two disables cannot both see another owner left.
    // FOR NO KEY UPDATE, not FOR UPDATE: an invitation acceptance that holds its own account
    // lock and inserts a role granted by one of these owners needs KEY SHARE on that owner.
    const active = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM user_account
      WHERE is_platform_owner AND status = 'active'
      ORDER BY id
      FOR NO KEY UPDATE
    `;
    if (!active.some((row) => row.id === target.id)) {
      io.err(`${email} is already disabled.`);
      throw new Refusal('user_disabled', target.id);
    }
    if (active.length < 2) {
      io.err(`${email} is the last active platform owner. Enrol another owner first.`);
      throw new Refusal('last_owner', target.id);
    }
    await tx.userAccount.update({ where: { id: target.id }, data: { status: 'disabled' } });
    const sessions = await revokeUserSessions(tx, target.id, 'owner_disabled');
    await tx.platformOwnerEnrolment.updateMany({
      where: { userId: target.id, consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(tx, correlationId, action, 'success', 'user_account', target.id, { sessionsRevoked: sessions });
  });
  io.out(`Disabled ${email}.`);
  return 0;
}

/**
 * Runs `work` in one transaction. A refusal rolls it back and is audited on its own
 * transaction with outcome `denied`, so the refusal itself is on record.
 * One advisory lock serialises every owner command, so an enrol or relink commits before a
 * disable starts and each then locks enrolments before accounts, as the OIDC callback does.
 */
async function refusable<T>(
  prisma: PrismaClient,
  io: OwnerCliIo,
  correlationId: string,
  action: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('bp-owner-cli', 0::bigint))`;
      return work(tx);
    });
  } catch (error) {
    if (error instanceof Refusal) {
      await prisma.$transaction((tx) =>
        writeAudit(tx, correlationId, action, 'denied', 'user_account', error.objectId, { reason: error.reason }),
      );
      io.err(`Refused: ${error.reason}`);
    }
    throw error;
  }
}

async function requireOwner(tx: Tx, email: string, io: OwnerCliIo): Promise<{ id: string }> {
  const user = await tx.userAccount.findFirst({ where: { email }, select: { id: true, isPlatformOwner: true } });
  if (!user) {
    io.err(`No account for ${email}.`);
    throw new Refusal('user_not_found', null);
  }
  if (!user.isPlatformOwner) {
    io.err(`${email} is not a platform owner.`);
    throw new Refusal('not_platform_owner', user.id);
  }
  return user;
}

async function lockOpenEnrolments(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM platform_owner_enrolment
    WHERE user_id = ${userId}::uuid AND consumed_at IS NULL AND revoked_at IS NULL
    ORDER BY id
    FOR UPDATE
  `;
}

async function revokeUserSessions(tx: Tx, userId: string, reason: string): Promise<number> {
  const result = await tx.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

async function writeAudit(
  tx: Tx,
  correlationId: string,
  action: string,
  outcome: 'success' | 'denied',
  objectType: string,
  objectId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  // A platform row (no company) is visible to INSERT … RETURNING only with platform scope on.
  await tx.$queryRaw`SELECT set_config('app.platform_scope', 'on', true)`;
  await tx.auditEvent.create({
    data: {
      companyId: null,
      actorType: 'system',
      actorId: null,
      actorLabel: 'cli',
      action,
      objectType,
      objectId,
      outcome,
      correlationId,
      details: redactDetails(details),
    },
    select: { id: true },
  });
}

function parse<T extends Record<string, { type: 'string' | 'boolean' }>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : 'invalid arguments');
  }
}

function requireEmail(value: string | boolean | undefined): string {
  if (typeof value !== 'string') {
    throw new UsageError('--email is required');
  }
  const email = value.trim();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new UsageError('--email is not an email address');
  }
  return email;
}

const ENTRA_OID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Entra object id (a GUID) from the Entra admin center, or null when not given. */
function optionalEntraOid(value: string | boolean | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || !ENTRA_OID.test(value.trim())) {
    throw new UsageError('--entra-oid must be the Entra object id, a GUID');
  }
  return value.trim().toLowerCase();
}

function requireName(value: string | boolean | undefined): string {
  if (typeof value !== 'string') {
    throw new UsageError('--name is required');
  }
  const name = value.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new UsageError('--name must be 1 to 200 characters with no control characters');
  }
  return name;
}

/** `https://…`, or `http://` only for localhost or 127.0.0.1. No path, query or fragment. */
export function requireOrigin(value: string | boolean | undefined): string {
  if (typeof value !== 'string') {
    throw new UsageError('--origin is required, for example https://localhost:8443');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError('--origin is not a URL');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  // The URL parser drops a default port (`:443`, `:80`), so compare parts, not text.
  if (
    !schemeOk ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new UsageError('--origin must be an https origin (or http://localhost) with no path');
  }
  return url.origin;
}
