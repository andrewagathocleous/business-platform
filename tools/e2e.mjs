import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { connect as connectPort } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { databaseName, refuseUnlessTestDatabase } from './test-db-guard.mjs';

const root = resolve(import.meta.dirname, '..');
const children = [];
let aborted = false;

export const HARNESS_PORTS = [3100, 4300];

/** Hosts the preflight must refuse. `localhost` is included because it can resolve to `::1` first. */
export const PROBE_HOSTS = ['127.0.0.1', '::1', 'localhost'];

/** The origin the preflight actually checked. Playwright must use this, not `localhost`. */
export const PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:4300';

export function visibleChildText(text, expectedStop) {
  return expectedStop ? '' : scrub(text);
}

export function stoppedLine(label) {
  return `stopped ${label}`;
}

export function unexpectedChildFailure(label, expectedStop, code, signal) {
  if (expectedStop || (code === null && (signal === null || signal === undefined))) {
    return null;
  }
  return `${label} exited before Playwright finished (${String(code ?? signal)})`;
}

export function busyPortMessage(ports) {
  return `refusing to run: port ${ports.join(' and ')} already accepts a connection`;
}

/** True when any probe host accepts on this port. */
export async function harnessPortBusy(port, probe = acceptsConnection) {
  for (const host of PROBE_HOSTS) {
    if (await probe(port, host)) {
      return true;
    }
  }
  return false;
}

/**
 * Stack groups plus the Playwright group. Reset waits until every one of these is gone,
 * including descendants of the Corepack wrapper.
 */
export function shutdownGroups(stack, playwrightPid) {
  const groups = stack.map((record) => ({ pid: record.pid, label: record.label }));
  if (playwrightPid) {
    groups.push({ pid: playwrightPid, label: 'playwright' });
  }
  return groups;
}

/** True when something on this machine accepts a TCP connection on the port. */
export function acceptsConnection(port, host = '127.0.0.1', timeoutMs = 400) {
  return new Promise((resolvePromise) => {
    const socket = connectPort({ port, host });
    let settled = false;
    const finish = (busy) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolvePromise(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** `process.kill(-pgid, 0)`: the group is alive while any member remains, including after the wrapper exits. */
export function groupAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Signal each process group on its own. A numeric exit from the wrapper does not
 * mean its descendants are gone, so SIGKILL follows the grace period whenever
 * `kill(-pgid, 0)` still succeeds.
 */
export async function stopProcessGroups(groups, options = {}) {
  const signal = options.signal ?? ((pid, name) => process.kill(-pid, name));
  const alive = options.alive ?? groupAlive;
  const wait = options.wait ?? delay;
  const graceMs = options.graceMs ?? 1000;
  const deadlineMs = options.deadlineMs ?? 5000;
  for (const group of groups) {
    if (!group.pid) {
      continue;
    }
    try {
      signal(group.pid, 'SIGTERM');
    } catch (error) {
      if (!isMissingProcess(error)) {
        throw error;
      }
    }
  }
  await wait(graceMs);
  for (const group of groups) {
    if (!group.pid || !alive(group.pid)) {
      continue;
    }
    try {
      signal(group.pid, 'SIGKILL');
    } catch (error) {
      if (!isMissingProcess(error)) {
        throw error;
      }
    }
  }
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (groups.every((group) => !group.pid || !alive(group.pid))) {
      return;
    }
    await wait(50);
  }
  const stuck = groups.filter((group) => group.pid && alive(group.pid)).map((group) => group.label);
  throw new Error(`process group still running: ${stuck.join(', ')}`);
}

/** Reset the database only after every launched group has gone. */
export async function resetAfterGroups(groups, reset, options) {
  await stopProcessGroups(groups, options);
  await reset();
}

export async function assertReadyRun(fetchImpl, origins, runId) {
  for (const origin of origins) {
    const response = await fetchImpl(`${origin}/api/health/ready`);
    if (!response.ok) {
      throw new Error(`ready check failed at ${origin} (${String(response.status)})`);
    }
    const body = await response.json();
    if (!body || body.runId !== runId) {
      throw new Error(`ready check at ${origin} is not this harness run`);
    }
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(import.meta.filename)).href;
}

if (isDirectRun()) {
  const code = await runE2e();
  process.exit(code);
}

export async function runE2e(deps = {}) {
  const reportError = deps.reportError ?? ((message) => console.error(scrub(message)));
  const probe = deps.probePort ?? acceptsConnection;
  const busy = [];
  for (const port of HARNESS_PORTS) {
    if (await harnessPortBusy(port, probe)) {
      busy.push(port);
    }
  }
  if (busy.length > 0) {
    reportError(busyPortMessage(busy));
    return 1;
  }

  loadEnv({ path: resolve(import.meta.dirname, '../.env') });
  const appUrl = process.env.DATABASE_URL_TEST;
  const ownerUrl = process.env.DATABASE_URL_OWNER_TEST;
  if (!appUrl || !ownerUrl) {
    reportError('DATABASE_URL_TEST and DATABASE_URL_OWNER_TEST are required');
    return 1;
  }

  const database = databaseName(ownerUrl);
  console.log(`e2e database: ${database}`);
  if (database !== 'business_platform_test') {
    reportError('refusing to run: the database name is not business_platform_test');
    return 1;
  }

  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_URL_OWNER = ownerUrl;
  refuseUnlessTestDatabase();

  const resetDatabase =
    deps.resetDatabase ?? ((env) => run('pnpm', ['db:reset:test'], env));

  process.on('SIGINT', () => {
    aborted = true;
  });
  process.on('SIGTERM', () => {
    aborted = true;
  });

  const storage = resolve(root, 'var/e2e/storage');
  const mockPrint = resolve(root, 'var/e2e/mock-print');
  const tokenFile = resolve(root, 'var/e2e/service-identities.json');
  const apiOrigin = 'http://127.0.0.1:3100';
  const webOrigin = 'http://127.0.0.1:4300';
  const webBaseUrl = PLAYWRIGHT_BASE_URL;
  const runId = randomUUID();
  const testEnv = {
    ...process.env,
    DATABASE_URL: appUrl,
    DATABASE_URL_OWNER: ownerUrl,
    BP_SEED_TARGET: 'test',
  };
  const apiEnv = {
    ...testEnv,
    PORT: '3100',
    HOST: '127.0.0.1',
    STORAGE_ROOT: storage,
    MOCK_PRINT_ROOT: mockPrint,
    E2E_RUN_ID: runId,
  };

  let exitCode = 1;
  let stopWatching = () => {};
  let playwright = null;
  try {
    throwIfAborted();
    await resetDatabase(testEnv);
    throwIfAborted();
    await run('pnpm', ['db:seed'], testEnv);
    throwIfAborted();
    await mkdir(storage, { recursive: true, mode: 0o700 });
    await mkdir(mockPrint, { recursive: true, mode: 0o700 });

    const api = start('pnpm', ['--filter', '@bp/api', 'dev'], apiEnv, 'api');
    await waitForHttp(`${apiOrigin}/api/health/ready`, api, 'api');
    throwIfAborted();
    await run('pnpm', ['demo:import-fixtures', '--', '--company', 'A'], {
      ...testEnv,
      DEMO_API_ORIGIN: apiOrigin,
      DEMO_TOKEN_FILE: tokenFile,
    });
    throwIfAborted();
    const worker = start('pnpm', ['--filter', '@bp/api', 'dev:worker'], apiEnv, 'worker');
    await waitForText(worker, 'worker ready', 'worker');
    throwIfAborted();
    const web = start(
      'pnpm',
      ['exec', 'nx', 'serve', 'web', '--host=127.0.0.1', '--port=4300'],
      { ...process.env, PORT: '4300', WEB_API_ORIGIN: apiOrigin },
      'web',
    );
    await waitForHttp(`${webOrigin}/`, web, 'web', 180_000);
    throwIfAborted();
    await confirmHarness(api, [apiOrigin], runId);
    await confirmHarness(web, [webOrigin], runId);
    await confirmHarness(api, [apiOrigin], runId);
    playwright = spawn('pnpm', ['exec', 'playwright', 'test', '-c', 'apps/web-e2e/playwright.config.mts'], {
      cwd: root,
      env: { ...process.env, BASE_URL: webBaseUrl },
      stdio: 'inherit',
      detached: true,
    });
    const watched = watchChildren();
    stopWatching = watched.stop;
    exitCode = await Promise.race([
      new Promise((resolvePromise, reject) => {
        playwright.on('exit', (code, signal) => {
          if (aborted) {
            reject(new Error('e2e harness aborted'));
            return;
          }
          resolvePromise(code ?? (signal ? 1 : 0));
        });
      }),
      watched.done,
    ]);
  } catch (error) {
    reportError(error instanceof Error ? error.message : 'e2e harness failed');
    exitCode = 1;
  } finally {
    stopWatching();
    const current = children.splice(0, children.length);
    for (const record of current) {
      record.expectedStop = true;
    }
    try {
      await resetAfterGroups(
        shutdownGroups(
          current.map((record) => ({ pid: record.child.pid, label: record.label })),
          playwright?.pid ?? null,
        ),
        () =>
          resetDatabase({
            ...process.env,
            DATABASE_URL: process.env.DATABASE_URL_TEST,
            DATABASE_URL_OWNER: process.env.DATABASE_URL_OWNER_TEST,
            BP_SEED_TARGET: 'test',
          }),
        deps.stopOptions,
      );
      for (const record of current) {
        console.log(stoppedLine(record.label));
      }
    } catch (error) {
      reportError(error instanceof Error ? error.message : 'test database reset failed');
      if (exitCode === 0) {
        exitCode = 1;
      }
    }
  }

  return exitCode;
}

async function confirmHarness(started, origins, runId) {
  if (childGone(started)) {
    throw new Error(`${started.label} exited before it was ready\n${started.output.text}`);
  }
  await assertReadyRun(fetch, origins, runId);
  if (childGone(started)) {
    throw new Error(`${started.label} exited before it was ready\n${started.output.text}`);
  }
}

export function childGone(started) {
  return Boolean(started.unexpected || started.child.exitCode !== null);
}

function start(command, args, env, label) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, output: { text: '' }, label, expectedStop: false, unexpected: null };
  const onData = (chunk) => {
    const text = String(chunk);
    record.output.text += scrub(text);
    const visible = visibleChildText(text, record.expectedStop);
    if (visible.length > 0) {
      process.stdout.write(visible);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('exit', (code, signal) => {
    record.unexpected = unexpectedChildFailure(label, record.expectedStop, code, signal);
  });
  children.push(record);
  return record;
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      if (aborted) {
        reject(new Error('e2e harness aborted'));
        return;
      }
      if (code === 0) {
        resolvePromise(0);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited ${String(code ?? signal)}`));
    });
  });
}

function watchChildren() {
  let stop = () => {};
  const done = new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      if (error) {
        reject(error);
        return;
      }
      resolvePromise(undefined);
    };
    const timer = setInterval(() => {
      for (const record of children) {
        if (record.unexpected) {
          finish(new Error(`${record.unexpected}\n${record.output.text}`));
          return;
        }
      }
    }, 250);
    stop = () => finish();
  });
  return { done, stop };
}

async function waitForHttp(url, started, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    throwIfAborted();
    if (childGone(started)) {
      throw new Error(`${label} exited before it was ready\n${started.output.text}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        if (childGone(started)) {
          throw new Error(`${label} exited before it was ready\n${started.output.text}`);
        }
        return;
      }
      last = String(response.status);
    } catch (error) {
      if (error instanceof Error && error.message.includes('exited before it was ready')) {
        throw error;
      }
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await delay(500);
  }
  throw new Error(`${label} was not ready (${scrub(last)})`);
}

async function waitForText(started, needle, label) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    throwIfAborted();
    if (started.output.text.includes(needle)) {
      if (childGone(started)) {
        throw new Error(`${label} exited before it was ready\n${started.output.text}`);
      }
      return;
    }
    if (childGone(started)) {
      throw new Error(`${label} exited before it was ready\n${started.output.text}`);
    }
    await delay(200);
  }
  throw new Error(`${label} was not ready`);
}

function throwIfAborted() {
  if (aborted) {
    throw new Error('e2e harness aborted');
  }
}

function isMissingProcess(error) {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

function scrub(text) {
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted')
    .replace(/bps_[A-Za-z0-9._-]+/g, 'bps_redacted');
}

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
