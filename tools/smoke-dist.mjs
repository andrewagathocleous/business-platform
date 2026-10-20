import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');

loadEnv({ path: resolve(root, '.env') });

for (const relative of ['packages/db/dist/index.js', 'packages/domain/dist/index.js']) {
  require(resolve(root, relative));
  console.log(`loaded ${relative}`);
}

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
  console.error('DATABASE_URL_TEST is required to smoke-check the built API');
  process.exit(1);
}

const port = await freePort();
const env = {
  ...process.env,
  APP_ENV: 'test',
  AUTH_DEV_LOGIN_ENABLED: 'false',
  SESSION_COOKIE_SECURE: 'false',
  CSRF_SECRET: 'smoke-dist-csrf-secret',
  AUTH_REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  OIDC_ISSUER: '',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
  OIDC_REDIRECT_URI: '',
  APP_MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(32, 3).toString('base64') }),
  APP_MASTER_KEY_ACTIVE: 'k1',
  DATABASE_URL: databaseUrl,
  PORT: String(port),
  HOST: '127.0.0.1',
  THROTTLE_ENABLED_IN_TEST: 'false',
};

await smokeHttp(env, port);
await smokeWorker(env);
console.log('built API ready and both processes exited 0');

async function smokeHttp(childEnv, listenPort) {
  const child = start(resolve(root, 'apps/api/dist/main.js'), childEnv);
  try {
    await waitForReady(listenPort, child);
    console.log(`GET /api/health/ready 200 on port ${String(listenPort)}`);
    await stop(child, 'api');
  } catch (error) {
    await stop(child, 'api').catch(() => undefined);
    console.error(scrub(child.output()));
    throw error;
  }
}

async function smokeWorker(childEnv) {
  const child = start(resolve(root, 'apps/api/dist/main.worker.js'), childEnv);
  try {
    await waitForOutput(child, 'worker ready');
    console.log('worker ready');
    await stop(child, 'worker');
  } catch (error) {
    await stop(child, 'worker').catch(() => undefined);
    console.error(scrub(child.output()));
    throw error;
  }
}

function start(script, childEnv) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk) => {
    output += chunk.toString();
    if (output.length > 20_000) {
      output = output.slice(-20_000);
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return {
    child,
    output: () => output,
    includes: (text) => output.includes(text),
  };
}

async function waitForReady(listenPort, running) {
  const deadline = Date.now() + 20_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) {
      throw new Error(`api exited ${String(running.child.exitCode)} before ready`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(listenPort)}/api/health/ready`);
      if (response.status === 200) {
        return;
      }
      last = `status ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await delay(200);
  }
  throw new Error(`GET /api/health/ready did not return 200 (${last})`);
}

async function waitForOutput(running, text) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (running.includes(text)) {
      return;
    }
    if (running.child.exitCode !== null) {
      throw new Error(`worker exited ${String(running.child.exitCode)} before ${text}`);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${text}`);
}

async function stop(running, name) {
  if (running.child.exitCode !== null) {
    if (running.child.exitCode !== 0) {
      throw new Error(`${name} already exited ${String(running.child.exitCode)}`);
    }
    return;
  }
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      running.child.kill('SIGKILL');
      reject(new Error(`${name} did not exit 0 after SIGTERM`));
    }, 10_000);
    running.child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited ${String(code)}`));
    });
  });
  running.child.kill('SIGTERM');
  await exited;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const listenPort = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (listenPort < 1) {
          reject(new Error('could not allocate a port'));
          return;
        }
        resolvePort(listenPort);
      });
    });
  });
}

function scrub(text) {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]');
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
