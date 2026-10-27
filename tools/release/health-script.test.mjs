import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '../../infra/health/laptop-health.sh');
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A home with fake curl, osascript and df. curl succeeds when $home/up exists. */
function setup({ freePercent = 50 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bp-health-test-'));
  directories.push(home);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const tool = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  tool('curl', `[[ -f "${home}/up" ]]`);
  tool('osascript', `echo "$2" >> "${home}/notifications"`);
  const size = 1000;
  tool('df', `echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/disk ${size} 0 ${(size * freePercent) / 100} 0% /"`);
  return { home, bin };
}

function check({ home, bin }) {
  const result = spawnSync('/bin/bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, BP_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(result.status, result.stderr).toBe(0);
}

function notifications(home) {
  return existsSync(join(home, 'notifications')) ? readFileSync(join(home, 'notifications'), 'utf8').trim().split('\n') : [];
}

describe('laptop-health.sh', () => {
  it('notifies after two failures in a row, then hourly, then once on recovery', () => {
    const env = setup();
    check(env);
    expect(notifications(env.home)).toEqual([]);
    check(env);
    expect(notifications(env.home)).toHaveLength(1);
    expect(notifications(env.home)[0]).toContain('not answering');
    for (let run = 3; run <= 13; run += 1) {
      check(env);
    }
    expect(notifications(env.home)).toHaveLength(1);
    check(env);
    expect(notifications(env.home)).toHaveLength(2);
    writeFileSync(join(env.home, 'up'), '');
    check(env);
    expect(notifications(env.home).at(-1)).toContain('answering again');
    check(env);
    expect(notifications(env.home)).toHaveLength(3);
    expect(readFileSync(join(env.home, 'Library/Logs/business-platform-health.log'), 'utf8')).toContain('recovered');
  });

  it('does not notify for a single failure', () => {
    const env = setup();
    check(env);
    writeFileSync(join(env.home, 'up'), '');
    check(env);
    expect(notifications(env.home)).toEqual([]);
  });

  it('warns about low disk space once a day', () => {
    const env = setup({ freePercent: 10 });
    writeFileSync(join(env.home, 'up'), '');
    check(env);
    check(env);
    expect(notifications(env.home)).toHaveLength(1);
    expect(notifications(env.home)[0]).toContain('20 percent');
  });
});
