import { spawn } from 'node:child_process';

const scripts = ['dev:api', 'dev:worker', 'dev:web'];
let stopping = false;

const children = scripts.map((script) => {
  const child = spawn('pnpm', [script], {
    stdio: 'inherit',
    detached: true,
    env: process.env,
  });
  child.on('error', (error) => {
    console.error(`pnpm ${script} failed to start: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) {
      return;
    }
    console.error(`pnpm ${script} exited (${signal ?? code ?? 'unknown'})`);
    stop(typeof code === 'number' && code !== 0 ? code : 1);
  });
  return child;
});

function stop(code) {
  if (stopping) {
    return;
  }
  stopping = true;
  for (const child of children) {
    if (!child.pid) {
      continue;
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => {
    process.exit(code);
  }, 1000).unref();
}

process.on('SIGINT', () => {
  stop(0);
});
process.on('SIGTERM', () => {
  stop(0);
});
