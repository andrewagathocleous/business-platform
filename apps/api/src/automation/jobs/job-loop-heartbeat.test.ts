import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../database/prisma.service';
import { type ClaimedJob, JobRunner } from './job-runner';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('job loop heartbeat', () => {
  it('does not touch the heartbeat again while claim never settles', async () => {
    const file = tempFile();
    let release: (value: null) => void = () => {};
    const hung = new Promise<null>((resolve) => {
      release = resolve;
    });
    const runner = runnerWith(file);
    runner.pollMs = 30;
    runner.tickIo = {
      reclaim: () => Promise.resolve(),
      claim: () => hung,
    };
    try {
      runner.startLoop();
      await waitUntil(() => existsSync(file));
      const first = statSync(file).mtimeMs;
      await delay(120);
      expect(statSync(file).mtimeMs).toBe(first);
    } finally {
      release(null);
      await delay(30);
      await runner.stop();
    }
  });

  it('touches the heartbeat again when a later tick finishes', async () => {
    const file = tempFile();
    const runner = runnerWith(file);
    runner.pollMs = 40;
    runner.tickIo = {
      reclaim: () => Promise.resolve(),
      claim: () => Promise.resolve(null),
    };
    try {
      runner.startLoop();
      await waitUntil(() => existsSync(file));
      const first = statSync(file).mtimeMs;
      await delay(90);
      expect(statSync(file).mtimeMs).toBeGreaterThan(first);
    } finally {
      await runner.stop();
    }
  });

  it('keeps the heartbeat fresh while one tick keeps claiming', async () => {
    const file = tempFile();
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    let now = start;
    const runner = runnerWith(file);
    runner.pollMs = 60_000;
    runner.heartbeatClock = () => new Date(now);
    vi.spyOn(runner, 'execute').mockResolvedValue(undefined);
    let release: (job: ClaimedJob | null) => void = () => {};
    runner.tickIo = {
      reclaim: () => Promise.resolve(),
      claim: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    try {
      runner.startLoop();
      await waitUntil(() => existsSync(file));
      await delay(20);
      expect(statSync(file).mtimeMs).toBe(start);
      now = start + 70_000;
      release(claimed('1'));
      await waitUntil(() => statSync(file).mtimeMs === start + 70_000);
      now = start + 140_000;
      release(claimed('2'));
      await waitUntil(() => statSync(file).mtimeMs === start + 140_000);
      expect(statSync(file).mtimeMs).toBe(start + 140_000);
    } finally {
      const stopping = runner.stop();
      release(null);
      await stopping;
    }
  });

  it('does not beat after stop', async () => {
    const file = tempFile();
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    let now = start;
    const runner = runnerWith(file);
    runner.pollMs = 60_000;
    runner.heartbeatClock = () => new Date(now);
    let release: (job: null) => void = () => {};
    runner.tickIo = {
      reclaim: () => Promise.resolve(),
      claim: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    runner.startLoop();
    await waitUntil(() => existsSync(file));
    await delay(20);
    expect(statSync(file).mtimeMs).toBe(start);
    now = start + 5_000;
    const stopping = runner.stop();
    release(null);
    await stopping;
    expect(statSync(file).mtimeMs).toBe(start);
  });

  it('does not beat after reclaim once stop begins', async () => {
    const file = tempFile();
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    let now = start;
    const runner = runnerWith(file);
    runner.pollMs = 60_000;
    runner.heartbeatClock = () => new Date(now);
    let release: () => void = () => {};
    runner.tickIo = {
      reclaim: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      claim: () => Promise.resolve(null),
    };
    runner.startLoop();
    await waitUntil(() => existsSync(file));
    await delay(20);
    expect(statSync(file).mtimeMs).toBe(start);
    now = start + 5_000;
    const stopping = runner.stop();
    release();
    await stopping;
    expect(statSync(file).mtimeMs).toBe(start);
  });

  it('does not beat after a claim that settles once stop begins', async () => {
    const file = tempFile();
    const start = Date.parse('2026-03-01T00:00:00.000Z');
    let now = start;
    const runner = runnerWith(file);
    runner.pollMs = 60_000;
    runner.heartbeatClock = () => new Date(now);
    const job = claimed('1');
    let release: (value: ClaimedJob) => void = () => {};
    runner.tickIo = {
      reclaim: () => Promise.resolve(),
      claim: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    };
    const settleShutdown = vi
      .spyOn(
        runner as unknown as {
          settleShutdown: (claimedJob: ClaimedJob, started: boolean) => Promise<void>;
        },
        'settleShutdown',
      )
      .mockResolvedValue(undefined);
    runner.startLoop();
    await waitUntil(() => existsSync(file));
    await delay(20);
    expect(statSync(file).mtimeMs).toBe(start);
    now = start + 5_000;
    const stopping = runner.stop();
    release(job);
    await stopping;
    expect(statSync(file).mtimeMs).toBe(start);
    expect(settleShutdown).toHaveBeenCalledTimes(1);
    expect(settleShutdown).toHaveBeenCalledWith(job, false);
  });
});

function runnerWith(file: string): JobRunner {
  const runner = new JobRunner({ client: {} } as PrismaService, {} as AuditService);
  runner.heartbeatFile = file;
  runner.shutdownGraceMs = 0;
  return runner;
}

function claimed(id: string): ClaimedJob {
  return {
    id,
    companyId: null,
    type: 'inbox.process',
    payload: {},
    attempts: 0,
    maxAttempts: 1,
    correlationId: id,
    timeoutMs: 1_000,
    lockedBy: id,
    deadline: new Date(0),
  };
}

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bp-loop-heartbeat-'));
  directories.push(directory);
  return join(directory, 'beat');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error('heartbeat file was not created');
    }
    await delay(5);
  }
}
