import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDatabaseNameIsTest,
  assertEnvConnectionsTargetTestDatabase,
  assertTestDatabaseUrls,
} from '../../../../tools/test-db-guard.mjs';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { configureHttp } from '../http/configure-http';
import { caseSensitiveAdapter } from '../http/express-adapter';
import { LOG_STREAM } from '../logging/logging.module';
import { AuditService } from '../audit/audit.service';
import { JobRunner } from './jobs/job-runner';

const COMPANY_A = 'Demo Company A Ltd (fictional)';
const fileRun = randomUUID().slice(0, 8);
const createdJobIds: string[] = [];

function testType(name: string): string {
  return `test.${name}.${fileRun}`;
}

describe('job runner', () => {
  beforeAll(async () => {
    const refusal = assertTestDatabaseUrls();
    if (refusal) {
      throw new Error(refusal);
    }
    await assertEnvConnectionsTargetTestDatabase();
    seedDatabase();
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_LOGIN_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECURE = 'false';
    process.env.CSRF_SECRET = 'integration-test-csrf-secret';
    process.env.AUTH_REQUIRE_MFA_FOR_PRIVILEGED = 'false';
    delete process.env.THROTTLE_ENABLED_IN_TEST;
    app = await bootApp();
    const prisma = app.get(PrismaService);
    const databases = await prisma.client.$queryRaw<
      { current_database: string; current_user: string }[]
    >`
      SELECT current_database() AS current_database, current_user AS current_user
    `;
    assertDatabaseNameIsTest(databases[0]?.current_database, 'DATABASE_URL');
    expect(databases[0]?.current_user).toBe('bp_app');
    companyA = (await prisma.client.company.findFirstOrThrow({ where: { legalName: COMPANY_A } }))
      .id;
    await prisma.client.job.deleteMany({ where: { type: { startsWith: 'test.' } } });
  }, 120_000);

  afterEach(async () => {
    if (!app || createdJobIds.length === 0) {
      return;
    }
    const ids = createdJobIds.splice(0, createdJobIds.length);
    await app.get(PrismaService).client.job.deleteMany({ where: { id: { in: ids } } });
  });

  afterAll(async () => {
    if (app) {
      await app
        .get(PrismaService)
        .client.job.deleteMany({ where: { type: { startsWith: 'test.' } } });
      await app.close();
    }
  });

  it('gives concurrent workers different jobs', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('claim'),
      concurrency: 4,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    const left = await enqueue(testType('claim'), { maxAttempts: 1 });
    const right = await enqueue(testType('claim'), { maxAttempts: 1 });
    const [firstAttempt, secondAttempt] = await Promise.all([
      jobs.claimOne('worker-a'),
      jobs.claimOne('worker-b'),
    ]);
    const first = firstAttempt ?? (await jobs.claimOne('worker-a'));
    const second = secondAttempt ?? (await jobs.claimOne('worker-b'));
    const ids = [first?.id, second?.id].sort();
    expect(ids).toEqual([left, right].sort());
    expect(first?.lockedBy).not.toBe(second?.lockedBy);
    expect(await jobs.claimOne('worker-c')).toBeNull();
    const rows = await prisma().job.findMany({ where: { id: { in: [left, right] } } });
    expect(rows.map((row) => row.attempts)).toEqual([1, 1]);
    expect(rows.every((row) => row.status === 'running')).toBe(true);
  });

  it('reclaims an expired non-retryable lease as uncertain without counting the attempt again', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('once'),
      concurrency: 1,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    const id = await enqueue(testType('once'), { maxAttempts: 1 });
    const claimed = await jobs.claimOne();
    expect(claimed?.id).toBe(id);
    expect(claimed?.attempts).toBe(1);
    await prisma().job.update({ where: { id }, data: { lockedUntil: new Date(0) } });
    expect(await jobs.reclaimExpired()).toBeGreaterThanOrEqual(1);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('uncertain');
    expect(row.lastError).toBe('lease_expired');
    expect(row.attempts).toBe(1);
    expect(row.lockedBy).toBeNull();
    expect(row.lockedUntil).toBeNull();
  });

  it('requeues an expired retryable lease with backoff', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('retry'),
      concurrency: 1,
      retryable: true,
      run: () => Promise.resolve(undefined),
    });
    const id = await enqueue(testType('retry'), { maxAttempts: 5 });
    expect((await jobs.claimOne())?.id).toBe(id);
    await prisma().job.update({ where: { id }, data: { lockedUntil: new Date(0) } });
    await jobs.reclaimExpired();
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    const now = await prisma().$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const clock = now[0]?.now.getTime() ?? 0;
    expect(row.status).toBe('queued');
    expect(row.lastError).toBe('lease_expired');
    expect(row.attempts).toBe(1);
    expect(row.lockedBy).toBeNull();
    expect(row.runAfter.getTime()).toBeGreaterThan(clock);
    expect(row.runAfter.getTime()).toBeLessThan(clock + 5_000);
  });

  it('backs off a retryable handler error', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('backoff'),
      concurrency: 1,
      retryable: true,
      run: () => Promise.reject(new Error('boom')),
    });
    const id = await enqueue(testType('backoff'), { maxAttempts: 5 });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    await jobs.execute(claimed);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    const now = await prisma().$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
    const clock = now[0]?.now.getTime() ?? 0;
    expect(row.status).toBe('queued');
    expect(row.lastError).toBe('boom');
    expect(row.attempts).toBe(1);
    expect(row.lockedBy).toBeNull();
    expect(row.runAfter.getTime()).toBeGreaterThan(clock);
  });

  it('rolls back the first handler when a second worker reclaims the expired lease', async () => {
    const type = testType('lease-lost');
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    let wrote!: () => void;
    const wroteDone = new Promise<void>((resolveWrote) => {
      wrote = resolveWrote;
    });
    let aborted = false;
    const first = runner();
    first.heartbeatMs = 20;
    first.register({
      type,
      concurrency: 1,
      retryable: true,
      run: async (job, tx, signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        const companyId = job.companyId;
        if (!companyId) {
          throw new Error('job has no company');
        }
        await tx.auditEvent.create({
          data: {
            companyId,
            actorType: 'system',
            action: 'test.lease_write',
            objectType: 'job',
            objectId: job.id,
            outcome: 'success',
            correlationId: job.correlationId,
            details: { token: job.lockedBy },
          },
        });
        wrote();
        await new Promise<void>((resolveHold) => {
          if (signal.aborted) {
            resolveHold();
            return;
          }
          const done = (): void => {
            resolveHold();
          };
          signal.addEventListener('abort', done, { once: true });
          void hold.then(() => {
            signal.removeEventListener('abort', done);
            resolveHold();
          });
        });
      },
    });
    const id = await enqueue(type, { maxAttempts: 5 });
    const claimed = await first.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    const pending = first.execute(claimed);
    await wroteDone;
    const expireLease = (): Promise<number> =>
      prisma().$executeRaw`
        UPDATE job
        SET locked_until = clock_timestamp() - interval '1 second'
        WHERE id = ${id}::uuid
          AND status = 'running'::"job_status"
          AND locked_by = ${claimed.lockedBy}
      `;
    await expireLease();
    const keepExpired = setInterval(() => {
      void expireLease();
    }, 10);
    try {
      await waitFor(() => aborted, 5_000);
      release();
      await pending;
    } finally {
      clearInterval(keepExpired);
      release();
    }
    const mid = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(mid.status).toBe('running');
    expect(mid.attempts).toBe(1);
    expect(mid.lockedBy).toBe(claimed.lockedBy);
    const second = runner();
    second.register({
      type,
      concurrency: 1,
      retryable: true,
      run: async (job, tx) => {
        const companyId = job.companyId;
        if (!companyId) {
          throw new Error('job has no company');
        }
        await tx.auditEvent.create({
          data: {
            companyId,
            actorType: 'system',
            action: 'test.lease_write',
            objectType: 'job',
            objectId: job.id,
            outcome: 'success',
            correlationId: job.correlationId,
            details: { token: job.lockedBy, winner: true },
          },
        });
      },
    });
    expect(await second.reclaimExpired()).toBeGreaterThanOrEqual(1);
    await prisma().$executeRaw`
      UPDATE job
      SET run_after = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'queued'::"job_status"
    `;
    const again = await second.claimOne();
    if (!again) {
      throw new Error('second worker did not reclaim the job');
    }
    await second.execute(again);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('succeeded');
    expect(row.attempts).toBe(2);
    const events = await jobAudits(id, 'test.lease_write');
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ winner: true, token: again.lockedBy });
  });

  it('does not let an old attempt complete a newer claim by the same worker', async () => {
    const jobs = runner();
    jobs.heartbeatMs = 60_000;
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      entered = resolveReady;
    });
    const type = testType('same-worker');
    jobs.register({
      type,
      concurrency: 1,
      retryable: true,
      run: () => {
        entered();
        return hold.then(() => undefined);
      },
    });
    const id = await enqueue(type, { maxAttempts: 5 });
    const first = await jobs.claimOne();
    if (!first) {
      throw new Error('job was not claimed');
    }
    const pending = jobs.execute(first);
    await ready;
    await prisma().$executeRaw`
      UPDATE job
      SET locked_until = clock_timestamp() - interval '1 second'
      WHERE id = ${id}::uuid
    `;
    expect(await jobs.reclaimExpired()).toBeGreaterThanOrEqual(1);
    await prisma().$executeRaw`
      UPDATE job
      SET run_after = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'queued'::"job_status"
    `;
    const second = await jobs.claimOne();
    if (!second) {
      throw new Error('the same worker did not reclaim the job');
    }
    expect(second.lockedBy).not.toBe(first.lockedBy);
    expect(second.lockedBy.startsWith(`${jobs.workerId}:`)).toBe(true);
    expect(first.lockedBy.startsWith(`${jobs.workerId}:`)).toBe(true);
    release();
    await pending;
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('running');
    expect(row.lockedBy).toBe(second.lockedBy);
    expect(row.attempts).toBe(2);
    await jobs.execute(second);
    expect((await prisma().job.findUniqueOrThrow({ where: { id } })).status).toBe('succeeded');
  });

  it('releases the newer claim when stop runs before that attempt starts', async () => {
    const jobs = runner();
    jobs.heartbeatMs = 60_000;
    jobs.shutdownGraceMs = 40;
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      entered = resolveReady;
    });
    const type = testType('same-worker-stop');
    jobs.register({
      type,
      concurrency: 1,
      retryable: true,
      run: () => {
        entered();
        return hold.then(() => undefined);
      },
    });
    const id = await enqueue(type, { maxAttempts: 5 });
    const first = await jobs.claimOne();
    if (!first) {
      throw new Error('job was not claimed');
    }
    const pending = jobs.execute(first);
    await ready;
    await prisma().$executeRaw`
      UPDATE job
      SET locked_until = clock_timestamp() - interval '1 second'
      WHERE id = ${id}::uuid
    `;
    expect(await jobs.reclaimExpired()).toBeGreaterThanOrEqual(1);
    await prisma().$executeRaw`
      UPDATE job
      SET run_after = clock_timestamp()
      WHERE id = ${id}::uuid AND status = 'queued'::"job_status"
    `;
    const second = await jobs.claimOne();
    if (!second) {
      throw new Error('the same worker did not reclaim the job');
    }
    expect(second.attempts).toBe(2);
    release();
    await pending;
    await jobs.stop();
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.lockedBy).toBeNull();
  });

  it('does not commit success when the completion fence passes the database deadline', async () => {
    const jobs = runner();
    jobs.heartbeatMs = 60_000;
    jobs.transactionTimeoutMs = 5_000;
    jobs.beforeFence = async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.45)`;
    };
    const type = testType('fence-deadline');
    jobs.register({
      type,
      concurrency: 1,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    const id = await enqueue(type, { maxAttempts: 1, timeoutMs: 150 });
    await jobs.drainOnce();
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).not.toBe('succeeded');
    expect(row.status).toBe('running');
  });

  it('does not succeed when a row lock is held past the database deadline', async () => {
    const jobs = runner();
    jobs.heartbeatMs = 60_000;
    jobs.transactionTimeoutMs = 15_000;
    let atFence!: () => void;
    const fenceReached = new Promise<void>((resolve) => {
      atFence = resolve;
    });
    jobs.beforeFence = () => {
      atFence();
      return Promise.resolve();
    };
    const type = testType('fence-lock');
    jobs.register({
      type,
      concurrency: 1,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    const id = await enqueue(type, { maxAttempts: 1, timeoutMs: 3_000 });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = prisma().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM job WHERE id = ${id}::uuid FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
    try {
      await lockHeld;
      await waitUntilDeadline(claimed.deadline, 800);
      const running = jobs.execute(claimed);
      await fenceReached;
      await delay(100);
      const open = await prisma().$queryRaw<{ open: boolean }[]>`
        SELECT clock_timestamp() < ${claimed.deadline}::timestamptz AS open
      `;
      expect(open[0]?.open).toBe(true);
      await waitUntilDeadline(claimed.deadline, -50);
      release();
      await held;
      await running;
    } finally {
      release();
      await held.catch(() => undefined);
    }
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).not.toBe('succeeded');
    expect(row.status).toBe('running');
  });

  it('returns from stop while another session holds the claim lock', async () => {
    const jobs = runner();
    jobs.pollMs = 20;
    jobs.shutdownGraceMs = 40;
    jobs.register({
      type: testType('lock-stop'),
      concurrency: 1,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = prisma().$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('bp-job-claim', 0::bigint))`;
        locked();
        await released;
      },
      { timeout: 20_000, maxWait: 5_000 },
    );
    try {
      await lockHeld;
      jobs.startLoop();
      await delay(80);
      const started = performance.now();
      const result = await Promise.race([
        jobs.stop().then(() => 'stopped' as const),
        delay(4_000).then(() => 'hung' as const),
      ]);
      expect(result).toBe('stopped');
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      release();
      await held;
    }
  });

  it('aborts from the monotonic lease budget when heartbeats fail', async () => {
    const jobs = runner();
    jobs.leaseMs = 30_000;
    jobs.heartbeatMs = 60_000;
    const type = testType('heartbeat-budget');
    let sawAbort = false;
    jobs.register({
      type,
      concurrency: 1,
      retryable: false,
      run: (_job, _tx, signal) =>
        new Promise((resolve) => {
          const note = (): void => {
            sawAbort = true;
            resolve(undefined);
          };
          if (signal.aborted) {
            note();
            return;
          }
          signal.addEventListener('abort', note, { once: true });
        }),
    });
    const id = await enqueue(type, { maxAttempts: 1, timeoutMs: 2_500 });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    jobs.leaseMs = 400;
    jobs.heartbeatMs = 50;
    jobs.heartbeatIo = {
      renew: () => Promise.reject(new Error('renew down')),
      verify: () => Promise.reject(new Error('verify down')),
    };
    const started = performance.now();
    await jobs.execute(claimed);
    const elapsed = performance.now() - started;
    expect(sawAbort).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(jobs.leaseMs - jobs.heartbeatMs - 80);
    expect(elapsed).toBeLessThan(2_000);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).not.toBe('succeeded');
    expect(row.status).toBe('running');
  });

  it('marks a started non-retryable job uncertain when SIGTERM exceeds the grace period', async () => {
    const jobs = runner();
    jobs.shutdownGraceMs = 40;
    const correlationId = `c2a-stop-once-${fileRun}`;
    const outcome = await stopDuring(jobs, testType('stop-once'), {
      retryable: false,
      maxAttempts: 1,
      correlationId,
      started: true,
    });
    expect(outcome.status).toBe('uncertain');
    expect(outcome.attempts).toBe(1);
    expect(outcome.lockedBy).toBeNull();
    expect(outcome.lastError).toBe('shutdown');
    const events = await audits(correlationId);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'job.uncertain',
        outcome: 'failure',
        actorType: 'system',
        objectType: 'job',
        objectId: outcome.id,
        correlationId,
      }),
    ]);
    expect(detailReason(events[0]?.details)).toBe('shutdown');
  });

  it('releases a started retryable job with backoff when SIGTERM exceeds the grace period', async () => {
    const jobs = runner();
    jobs.shutdownGraceMs = 40;
    const outcome = await stopDuring(jobs, testType('stop-retry'), {
      retryable: true,
      maxAttempts: 5,
      started: true,
    });
    const clock = await dbClock();
    expect(outcome.status).toBe('queued');
    expect(outcome.attempts).toBe(1);
    expect(outcome.lockedBy).toBeNull();
    expect(outcome.lastError).toBe('shutdown');
    expect(outcome.runAfter.getTime()).toBeGreaterThan(clock + 500);
  });

  it('restores the attempt when SIGTERM releases a claim whose handler never started', async () => {
    const jobs = runner();
    jobs.shutdownGraceMs = 40;
    jobs.register({
      type: testType('stop-unstarted'),
      concurrency: 1,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    const id = await enqueue(testType('stop-unstarted'), { maxAttempts: 3 });
    const claimed = await jobs.claimOne();
    expect(claimed?.attempts).toBe(1);
    await jobs.stop();
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(0);
    expect(row.lockedBy).toBeNull();
    expect(row.lockedUntil).toBeNull();
  });

  it('does not produce attempt 6 when SIGTERM interrupts attempt 5 of 5', async () => {
    const jobs = runner();
    jobs.shutdownGraceMs = 40;
    const type = testType('stop-exhausted');
    jobs.register({
      type,
      concurrency: 1,
      retryable: true,
      run: (_job, _tx, signal) => waitForAbort(signal),
    });
    const blocked = await enqueue(type, { maxAttempts: 5, attempts: 5 });
    expect(await jobs.claimOne()).toBeNull();
    expect((await prisma().job.findUniqueOrThrow({ where: { id: blocked } })).attempts).toBe(5);
    const correlationId = `c2a-stop-exhausted-${fileRun}`;
    const id = await enqueue(type, { maxAttempts: 5, attempts: 4, correlationId });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('attempt 5 was not claimed');
    }
    expect(claimed.attempts).toBe(5);
    let entered!: () => void;
    const ready = new Promise<void>((resolveReady) => {
      entered = resolveReady;
    });
    jobs.register({
      type,
      concurrency: 1,
      retryable: true,
      run: (_job, _tx, signal) => {
        entered();
        return waitForAbort(signal);
      },
    });
    const pending = jobs.execute(claimed);
    await ready;
    await Promise.all([pending, jobs.stop()]);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(5);
    expect(row.lockedBy).toBeNull();
    expect(await jobs.claimOne()).toBeNull();
    const events = await audits(correlationId);
    expect(events.map((event) => event.action)).toEqual(['job.failed']);
    expect(detailReason(events[0]?.details)).toBe('shutdown');
    expect((await prisma().job.findUniqueOrThrow({ where: { id: blocked } })).status).toBe(
      'queued',
    );
  });

  it('drains three database-due jobs and a job 80ms ahead of the database clock', async () => {
    for (let round = 0; round < 5; round += 1) {
      const type = testType(`due-${String(round)}`);
      const jobs = runner();
      jobs.register({
        type,
        concurrency: 4,
        retryable: false,
        run: () => Promise.resolve(undefined),
      });
      for (let index = 0; index < 3; index += 1) {
        await enqueue(type, { maxAttempts: 1 });
      }
      expect((await jobs.drainOnce()).processed).toBe(3);
    }
    const ahead = testType('ahead');
    const jobs = runner();
    jobs.register({
      type: ahead,
      concurrency: 1,
      retryable: false,
      run: () => Promise.resolve(undefined),
    });
    const id = await enqueue(ahead, { maxAttempts: 1 });
    await prisma().$executeRaw`
      UPDATE job
      SET run_after = clock_timestamp() + interval '80 milliseconds'
      WHERE id = ${id}::uuid
    `;
    expect((await jobs.drainOnce()).processed).toBe(1);
    expect((await prisma().job.findUniqueOrThrow({ where: { id } })).status).toBe('succeeded');
  });

  it('schedules retry backoff from the database clock', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('clock'),
      concurrency: 1,
      retryable: true,
      run: () => Promise.reject(new Error('boom')),
    });
    const id = await enqueue(testType('clock'), { maxAttempts: 5 });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    const before = await dbClock();
    await jobs.execute(claimed);
    const after = await dbClock();
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('queued');
    expect(row.runAfter.getTime()).toBeGreaterThanOrEqual(before + 1_000 - 20);
    expect(row.runAfter.getTime()).toBeLessThanOrEqual(after + 1_000 + 250);
  });

  it('does not run a 1s backoff immediately when the host clock is 2s behind', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('host-clock'),
      concurrency: 1,
      retryable: true,
      run: () => Promise.reject(new Error('boom')),
    });
    const id = await enqueue(testType('host-clock'), { maxAttempts: 5 });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    const realNow = Date.now;
    Date.now = () => realNow() - 2_000;
    try {
      await jobs.execute(claimed);
      expect(await jobs.claimOne()).toBeNull();
      const row = await prisma().job.findUniqueOrThrow({ where: { id } });
      const clock = await dbClock();
      expect(row.status).toBe('queued');
      expect(row.lastError).toBe('boom');
      expect(row.runAfter.getTime()).toBeGreaterThan(clock + 500);
    } finally {
      Date.now = realNow;
    }
  });

  it('retries a handler that resolves after a 5ms timeout', async () => {
    const jobs = runner();
    jobs.register({
      type: testType('timeout-retry'),
      concurrency: 1,
      retryable: true,
      run: () => delay(20).then(() => undefined),
    });
    const id = await enqueue(testType('timeout-retry'), { maxAttempts: 5, timeoutMs: 5 });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    await jobs.execute(claimed);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).not.toBe('succeeded');
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('timed_out');
  });

  it('marks a timed-out non-retryable handler uncertain', async () => {
    const jobs = runner();
    const correlationId = `c2a-timeout-once-${fileRun}`;
    jobs.register({
      type: testType('timeout-once'),
      concurrency: 1,
      retryable: false,
      run: () => delay(20).then(() => undefined),
    });
    const id = await enqueue(testType('timeout-once'), {
      maxAttempts: 1,
      timeoutMs: 5,
      correlationId,
    });
    const claimed = await jobs.claimOne();
    if (!claimed) {
      throw new Error('job was not claimed');
    }
    await jobs.execute(claimed);
    const row = await prisma().job.findUniqueOrThrow({ where: { id } });
    expect(row.status).not.toBe('succeeded');
    expect(row.status).toBe('uncertain');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('timed_out');
    const events = await audits(correlationId);
    expect(events.map((event) => event.action)).toEqual(['job.uncertain']);
    expect(detailReason(events[0]?.details)).toBe('timed_out');
  });
});

function runner(): JobRunner {
  if (!app) {
    throw new Error('the API was not started');
  }
  return new JobRunner(app.get(PrismaService), app.get(AuditService));
}

function prisma(): PrismaService['client'] {
  if (!app) {
    throw new Error('the API was not started');
  }
  return app.get(PrismaService).client;
}

async function enqueue(
  type: string,
  input: { maxAttempts: number; timeoutMs?: number; correlationId?: string; attempts?: number },
): Promise<string> {
  const row = await prisma().job.create({
    data: {
      companyId: companyA,
      type,
      payload: { ok: true },
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      correlationId: input.correlationId ?? `c2a-${randomUUID().slice(0, 8)}`,
      idempotencyKey: `c2a-${randomUUID()}`,
    },
    select: { id: true },
  });
  createdJobIds.push(row.id);
  return row.id;
}

async function stopDuring(
  jobs: JobRunner,
  type: string,
  input: { retryable: boolean; maxAttempts: number; correlationId?: string; started: boolean },
): Promise<{
  id: string;
  status: string;
  attempts: number;
  lockedBy: string | null;
  lastError: string | null;
  runAfter: Date;
}> {
  let entered!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    entered = resolveReady;
  });
  jobs.register({
    type,
    concurrency: 1,
    retryable: input.retryable,
    run: (_job, _tx, signal) => {
      entered();
      return waitForAbort(signal);
    },
  });
  const id = await enqueue(type, {
    maxAttempts: input.maxAttempts,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  });
  const claimed = await jobs.claimOne();
  if (!claimed) {
    throw new Error('job was not claimed');
  }
  const pending = jobs.execute(claimed);
  await ready;
  await Promise.all([pending, jobs.stop()]);
  const row = await prisma().job.findUniqueOrThrow({ where: { id } });
  return row;
}

function waitForAbort(signal: AbortSignal): Promise<undefined> {
  return new Promise<undefined>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

function waitFor(ready: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for the job runner'));
      }
    }, 10);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits until `deadline - clock_timestamp()` is at most `leadMs` (negative means past the deadline). */
async function waitUntilDeadline(deadline: Date, leadMs: number): Promise<void> {
  for (;;) {
    const rows = await prisma().$queryRaw<{ ms: number | string }[]>`
      SELECT EXTRACT(EPOCH FROM (${deadline}::timestamptz - clock_timestamp())) * 1000 AS ms
    `;
    const ms = Number(rows[0]?.ms ?? 0);
    if (ms <= leadMs) {
      return;
    }
    await delay(Math.min(50, Math.max(10, ms - leadMs)));
  }
}

async function audits(correlationId: string) {
  return prisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_scope', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
    return tx.auditEvent.findMany({ where: { correlationId }, orderBy: { occurredAt: 'asc' } });
  });
}

async function jobAudits(objectId: string, action: string) {
  return prisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
    return tx.auditEvent.findMany({ where: { objectId, action }, orderBy: { occurredAt: 'asc' } });
  });
}

function detailReason(details: unknown): string | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
}

async function dbClock(): Promise<number> {
  const rows = await prisma().$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!now) {
    throw new Error('database clock missing');
  }
  return now.getTime();
}

let companyA = '';

function seedDatabase(): void {
  const root = resolve(process.cwd(), '../..');
  const result = spawnSync('pnpm', ['--filter', '@bp/db', 'seed'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`seed exited ${String(result.status ?? result.signal)}`);
  }
}

async function bootApp(): Promise<INestApplication> {
  const stream = new Writable({
    write(_chunk: Buffer | string, _encoding, callback) {
      callback();
    },
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LOG_STREAM)
    .useValue(stream)
    .compile();
  const application = moduleRef.createNestApplication(caseSensitiveAdapter(), {
    bodyParser: false,
    abortOnError: false,
  });
  application.useLogger(application.get(Logger));
  configureHttp(application);
  await application.init();
  return application;
}

let app: INestApplication | undefined;
