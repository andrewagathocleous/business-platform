import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  assertReadyRun,
  busyPortMessage,
  childGone,
  groupAlive,
  harnessPortBusy,
  PLAYWRIGHT_BASE_URL,
  resetAfterGroups,
  runE2e,
  shutdownGroups,
  stoppedLine,
  stopProcessGroups,
  unexpectedChildFailure,
  visibleChildText,
} from './e2e.mjs';

describe('e2e shutdown', () => {
  it('hides an expected stop and still fails when a child exits on its own', () => {
    const noise = 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL\n';
    expect(visibleChildText(noise, true)).toBe('');
    expect(visibleChildText(noise, false)).toContain('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL');
    expect(stoppedLine('api')).toBe('stopped api');
    expect(unexpectedChildFailure('api', true, 1, null)).toBeNull();
    expect(unexpectedChildFailure('worker', false, null, null)).toBeNull();
    expect(unexpectedChildFailure('web', false, null, 'SIGTERM')).toContain(
      'web exited before Playwright finished',
    );
    expect(childGone({ unexpected: null, child: { exitCode: 0 } })).toBe(true);
    expect(childGone({ unexpected: null, child: { exitCode: null } })).toBe(false);
  });

  it('refuses when port 4300 accepts a connection and does not reset the database', async () => {
    const server = createServer();
    let ownServer = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(4300, '127.0.0.1', () => resolve());
      });
      ownServer = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error;
      }
    }
    const calls: string[] = [];
    try {
      const code = await runE2e({
        resetDatabase: async () => {
          calls.push('reset');
        },
        reportError: () => {},
      });
      expect(code).not.toBe(0);
      expect(calls).toEqual([]);
      expect(busyPortMessage([4300])).toContain('4300');
    } finally {
      if (ownServer) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
  });

  it('refuses when only ::1 accepts on port 4300 and does not reset the database', async () => {
    const server = createServer();
    let ownServer = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(4300, '::1', () => resolve());
      });
      ownServer = true;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') {
        throw error;
      }
    }
    const calls: string[] = [];
    try {
      const code = await runE2e({
        resetDatabase: async () => {
          calls.push('reset');
          throw new Error('reset must not run while ::1 is busy');
        },
        reportError: () => {},
      });
      expect(code).not.toBe(0);
      expect(calls).toEqual([]);
      expect(await harnessPortBusy(4300)).toBe(true);
    } finally {
      if (ownServer) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    }
  });

  it('gives Playwright the IPv4 origin the preflight verified', () => {
    expect(PLAYWRIGHT_BASE_URL).toBe('http://127.0.0.1:4300');
  });

  it('sends SIGKILL to a group whose wrapper would already have exited', async () => {
    const killed: string[] = [];
    const alive = new Map<number, boolean>([[42, true]]);
    await stopProcessGroups([{ pid: 42, label: 'api' }], {
      signal: (pid, name) => {
        killed.push(`${String(pid)}:${name}`);
        if (name === 'SIGKILL') {
          alive.set(pid, false);
        }
      },
      alive: (pid) => alive.get(pid) === true,
      wait: async () => {},
      graceMs: 0,
    });
    expect(killed).toEqual(['42:SIGTERM', '42:SIGKILL']);
  });

  it('reaps a descendant that ignores SIGTERM after the wrapper exits', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "process.on('SIGTERM', () => process.exit(0));",
          "const grandchild = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); process.on(\"SIGHUP\", () => {}); setInterval(() => {}, 500);'], { stdio: 'ignore' });",
          'grandchild.unref();',
          "setTimeout(() => process.stdout.write('descendant\\n'), 300);",
          'setInterval(() => {}, 500);',
        ].join('\n'),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('descendant did not start')), 5000);
        child.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('descendant')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      process.kill(-child.pid!, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(groupAlive(child.pid)).toBe(true);
      await stopProcessGroups([{ pid: child.pid, label: 'wrapper' }], { graceMs: 200, deadlineMs: 4000 });
      expect(groupAlive(child.pid)).toBe(false);
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('includes Playwright in the groups that must be gone before reset', () => {
    expect(shutdownGroups([{ pid: 4, label: 'web' }], 91)).toEqual([
      { pid: 4, label: 'web' },
      { pid: 91, label: 'playwright' },
    ]);
    expect(shutdownGroups([{ pid: 4, label: 'api' }], null)).toEqual([{ pid: 4, label: 'api' }]);
  });

  it('resets only after a detached playwright group is gone', async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        [
          "const { spawn } = require('node:child_process');",
          "const grandchild = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); process.on(\"SIGHUP\", () => {}); setInterval(() => {}, 500);'], { stdio: 'ignore' });",
          'grandchild.unref();',
          "process.on('SIGTERM', () => process.exit(0));",
          "setTimeout(() => process.stdout.write('playwright-ready\\n'), 200);",
          'setInterval(() => {}, 500);',
        ].join('\n'),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('playwright stand-in did not start')), 5000);
        child.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('playwright-ready')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      let aliveWhenReset = true;
      await resetAfterGroups(shutdownGroups([], child.pid), async () => {
        aliveWhenReset = groupAlive(child.pid);
      }, { graceMs: 200, deadlineMs: 4000 });
      expect(aliveWhenReset).toBe(false);
      expect(groupAlive(child.pid)).toBe(false);
    } finally {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });

  it('resets the database only after every group is gone', async () => {
    const order: string[] = [];
    await resetAfterGroups([{ pid: 7, label: 'api' }], async () => {
      order.push('reset');
    }, {
      signal: () => {},
      alive: () => false,
      wait: async () => {},
    });
    await expect(
      resetAfterGroups([{ pid: 8, label: 'web' }], async () => {
        order.push('reset-too-soon');
      }, {
        signal: () => {},
        alive: () => true,
        wait: async () => {},
        graceMs: 0,
        deadlineMs: 0,
      }),
    ).rejects.toThrow(/still running/);
    expect(order).toEqual(['reset']);
  });

  it('rejects a ready response that is not this harness run', async () => {
    await expect(
      assertReadyRun(
        async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }),
        ['http://127.0.0.1:3100'],
        '11111111-1111-4111-8111-111111111111',
      ),
    ).rejects.toThrow(/not this harness run/);
  });
});
