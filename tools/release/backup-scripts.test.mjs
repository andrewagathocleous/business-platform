import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const hasAge = spawnSync('which', ['age']).status === 0 && spawnSync('which', ['age-keygen']).status === 0;
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'bp-backup-test-'));
  directories.push(directory);
  return directory;
}

function keyPair() {
  const generated = spawnSync('age-keygen', [], { encoding: 'utf8' });
  const secret = generated.stdout.split('\n').find((line) => line.startsWith('AGE-SECRET-KEY-1')) ?? '';
  const publicKey = spawnSync('age-keygen', ['-y'], { input: `${secret}\n`, encoding: 'utf8' }).stdout.trim();
  return { secret, publicKey };
}

/** A release tree with the real backup and compose scripts, and a fake docker that emits fixed bytes. */
function setup(home) {
  const release = join(home, 'releases', 'abc1234');
  mkdirSync(join(release, 'infra', 'backup'), { recursive: true });
  mkdirSync(join(release, 'tools', 'release'), { recursive: true });
  copyFileSync(join(root, 'infra/backup/laptop-backup.sh'), join(release, 'infra/backup/laptop-backup.sh'));
  copyFileSync(join(root, 'infra/backup/laptop-restore.sh'), join(release, 'infra/backup/laptop-restore.sh'));
  copyFileSync(join(root, 'tools/release/laptop-compose.sh'), join(release, 'tools/release/laptop-compose.sh'));
  copyFileSync(join(root, 'tools/release/run-locked.pl'), join(release, 'tools/release/run-locked.pl'));
  chmodSync(join(release, 'tools/release/run-locked.pl'), 0o755);
  writeFileSync(join(release, 'RELEASE'), 'tag=abc1234\n');
  mkdirSync(join(home, 'env'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/bash',
      'args="$*"',
      'case "$args" in',
      '  *"pg_dump -U postgres -Fc business_platform"*) printf "DUMP-business_platform" ;;',
      '  *"pg_dump -U postgres -Fc n8n"*) printf "DUMP-n8n" ;;',
      '  *"files -C /var/lib/business-platform/storage -cf"*) printf "TAR-STORAGE" ;;',
      '  *"n8n-files -C /home/node/.n8n --exclude ./config -cf"*) printf "TAR-N8N" ;;',
      '  *"sleep-forever"*) sleep 30 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'osascript'), `#!/bin/bash\necho "$2" >> "${home}/notifications"\n`);
  chmodSync(join(bin, 'osascript'), 0o755);
  return { release, bin };
}

function runBackup(home, release, bin) {
  return spawnSync('/bin/bash', [join(release, 'infra/backup/laptop-backup.sh')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, BP_HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
}

describe.skipIf(!hasAge)('laptop-backup.sh', () => {
  it('writes encrypted files and a manifest that decrypt back to the dumps', () => {
    const home = temp();
    const { release, bin } = setup(home);
    const backups = join(home, 'Synced');
    mkdirSync(backups);
    const { secret, publicKey } = keyPair();
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=${publicKey}\n`);
    const result = runBackup(home, release, bin);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const names = readdirSync(join(backups, 'business-platform'));
    expect(names).toHaveLength(1);
    const dir = join(backups, 'business-platform', names[0] ?? '');
    expect(readdirSync(dir).sort()).toEqual([
      'MANIFEST.sha256',
      'RELEASE',
      'business_platform.dump.age',
      'n8n-data.tar.age',
      'n8n.dump.age',
      'storage.tar.age',
    ]);
    expect(spawnSync('shasum', ['-a', '256', '-c', 'MANIFEST.sha256'], { cwd: dir }).status).toBe(0);
    const decrypt = (file) =>
      spawnSync('age', ['-d', '-i', '-', join(dir, file)], { input: `${secret}\n`, encoding: 'utf8' }).stdout;
    expect(decrypt('business_platform.dump.age')).toBe('DUMP-business_platform');
    expect(decrypt('n8n.dump.age')).toBe('DUMP-n8n');
    expect(decrypt('storage.tar.age')).toBe('TAR-STORAGE');
    expect(decrypt('n8n-data.tar.age')).toBe('TAR-N8N');
    expect(readFileSync(join(dir, 'business_platform.dump.age')).toString('latin1')).not.toContain('DUMP-');
    expect(readFileSync(join(home, 'Library/Logs/business-platform-backup.log'), 'utf8')).toContain('backup done');
  });

  it('keeps the 14 newest backups and the first of each of the 6 newest months', () => {
    const home = temp();
    const { release, bin } = setup(home);
    const backups = join(home, 'Synced');
    const kept = join(backups, 'business-platform');
    mkdirSync(kept, { recursive: true });
    const { publicKey } = keyPair();
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=${publicKey}\n`);
    const old = [];
    for (let month = 1; month <= 9; month += 1) {
      for (const day of [1, 15]) {
        old.push(`2026${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}T030000Z`);
      }
    }
    for (let day = 1; day <= 20; day += 1) {
      old.push(`202610${String(day).padStart(2, '0')}T030000Z`);
    }
    for (const name of old) {
      mkdirSync(join(kept, name));
    }
    mkdirSync(join(kept, 'not-a-backup'));
    const result = runBackup(home, release, bin);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const all = readdirSync(kept).filter((name) => /^\d{8}T\d{6}Z$/.test(name)).sort();
    const newest = all.slice(-14);
    const firsts = [];
    let previous = '';
    for (const name of [...old, ...all].sort()) {
      if (name.slice(0, 6) !== previous) {
        firsts.push(name);
        previous = name.slice(0, 6);
      }
    }
    const expected = [...new Set([...newest, ...firsts.slice(-6)])].sort();
    expect(all).toEqual(expected);
    // The 14 newest are all in October; the first of October and of May to September stay too.
    expect(all).toHaveLength(14 + 6);
    expect(all).toContain('20261001T030000Z');
    expect(all).toContain('20260501T030000Z');
    expect(all).not.toContain('20260401T030000Z');
    expect(all).not.toContain('20260515T030000Z');
    expect(existsSync(join(kept, 'not-a-backup'))).toBe(true);
  });

  it('fails without writing anything when the recipient is not an age key, and notes it in the log', () => {
    const home = temp();
    const { release, bin } = setup(home);
    const backups = join(home, 'Synced');
    mkdirSync(backups);
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=not-a-key\n`);
    const result = runBackup(home, release, bin);
    expect(result.status).toBe(1);
    expect(existsSync(join(backups, 'business-platform'))).toBe(false);
    expect(readFileSync(join(home, 'Library/Logs/business-platform-backup.log'), 'utf8')).toContain('FAILED');
  });

  it('removes the partial backup when a dump fails', () => {
    const home = temp();
    const { release, bin } = setup(home);
    writeFileSync(join(bin, 'docker'), '#!/bin/bash\nexit 1\n');
    const backups = join(home, 'Synced');
    mkdirSync(backups);
    const { publicKey } = keyPair();
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=${publicKey}\n`);
    const result = runBackup(home, release, bin);
    expect(result.status).not.toBe(0);
    expect(readdirSync(join(backups, 'business-platform'))).toEqual([]);
  });
});

describe.skipIf(!hasAge)('laptop-backup.sh lock', () => {
  function configured() {
    const home = temp();
    const { release, bin } = setup(home);
    const backups = join(home, 'Synced');
    mkdirSync(backups);
    const { publicKey } = keyPair();
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=${publicKey}\n`);
    return { home, release, bin, backups };
  }

  async function holdLock(file, seconds) {
    const { spawn } = await import('node:child_process');
    mkdirSync(join(file, '..'), { recursive: true });
    const holder = spawn(join(root, 'tools/release/run-locked.pl'), [file, 'nowait', '/bin/sleep', String(seconds)], {
      stdio: 'ignore',
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    return holder;
  }

  it('is not blocked by a lock file left by a crash, and removes an interrupted folder', () => {
    const { home, release, bin, backups } = configured();
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'backup.lock'), '');
    mkdirSync(join(backups, 'business-platform', '.incomplete-20260101T000000Z'), { recursive: true });
    const result = runBackup(home, release, bin);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readdirSync(join(backups, 'business-platform')).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('stops while another backup holds the kernel lock', async () => {
    const { home, release, bin } = configured();
    const holder = await holdLock(join(home, 'state', 'backup.lock'), 5);
    const result = runBackup(home, release, bin);
    holder.kill();
    expect(result.status).toBe(1);
    expect(readFileSync(join(home, 'Library/Logs/business-platform-backup.log'), 'utf8')).toContain(
      'another backup or a restore is running',
    );
    expect(readFileSync(join(home, 'notifications'), 'utf8')).toContain('backup failed');
  });

  it('refuses to back up while a live restore is unfinished', () => {
    const { home, release, bin, backups } = configured();
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'restore-in-progress'), 'restore of x\n');
    const result = runBackup(home, release, bin);
    expect(result.status).toBe(1);
    expect(readFileSync(join(home, 'Library/Logs/business-platform-backup.log'), 'utf8')).toContain('did not finish');
    expect(existsSync(join(backups, 'business-platform'))).toBe(false);
  });

  it('cleans up the partial folder when it is killed, and the next backup runs', async () => {
    const { home, release, bin, backups } = configured();
    const docker = join(bin, 'docker');
    const normal = readFileSync(docker, 'utf8');
    writeFileSync(
      docker,
      // bash runs a trap after the foreground command returns, so the fake dump is short.
      '#!/bin/bash\ncase "$*" in *"Fc business_platform"*) printf DUMP; sleep 2 ;; *) exit 1 ;; esac\n',
    );
    const { spawn } = await import('node:child_process');
    const child = spawn('/bin/bash', [join(release, 'infra/backup/laptop-backup.sh')], {
      env: { ...process.env, HOME: home, BP_HOME: home, PATH: `${bin}:${process.env.PATH}` },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(join(backups, 'business-platform')) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    child.kill('SIGTERM');
    await new Promise((resolveExit) => child.on('exit', resolveExit));
    await new Promise((resolveWait) => setTimeout(resolveWait, 2500));
    expect(readdirSync(join(backups, 'business-platform')).filter((name) => name.startsWith('.'))).toEqual([]);
    writeFileSync(docker, normal);
    const next = runBackup(home, release, bin);
    expect(next.status, next.stdout + next.stderr).toBe(0);
  }, 20_000);
});

describe.skipIf(!hasAge)('laptop-restore.sh', () => {
  it('refuses a backup whose manifest does not match, before asking for the key', () => {
    const home = temp();
    const { release, bin } = setup(home);
    const backups = join(home, 'Synced');
    mkdirSync(backups);
    const { publicKey } = keyPair();
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=${publicKey}\n`);
    expect(runBackup(home, release, bin).status).toBe(0);
    const name = readdirSync(join(backups, 'business-platform'))[0] ?? '';
    const dir = join(backups, 'business-platform', name);
    writeFileSync(join(dir, 'n8n.dump.age'), 'tampered');
    const result = spawnSync('/bin/bash', [join(release, 'infra/backup/laptop-restore.sh'), dir], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, BP_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match its MANIFEST.sha256');
  });

  function backedUp() {
    const home = temp();
    const { release, bin } = setup(home);
    const backups = join(home, 'Synced');
    mkdirSync(backups);
    const { secret, publicKey } = keyPair();
    writeFileSync(join(home, 'backup.conf'), `BACKUP_DIR=${backups}\nAGE_RECIPIENT=${publicKey}\n`);
    expect(runBackup(home, release, bin).status).toBe(0);
    const name = readdirSync(join(backups, 'business-platform'))[0] ?? '';
    return { home, release, bin, dir: join(backups, 'business-platform', name), secret };
  }

  function restore({ home, release, bin }, dir, input) {
    const log = join(home, 'docker-calls');
    writeFileSync(join(bin, 'docker'), `#!/bin/bash\necho "$*" >> "${log}"\nexit 0\n`);
    const result = spawnSync('/bin/bash', [join(release, 'infra/backup/laptop-restore.sh'), dir], {
      encoding: 'utf8',
      input,
      env: { ...process.env, HOME: home, BP_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    return { result, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  }

  it('refuses a manifest that names a similar file instead of the real one', () => {
    const env = backedUp();
    const manifest = readFileSync(join(env.dir, 'MANIFEST.sha256'), 'utf8').replace(
      'business_platform.dump.age',
      'business_platformXdumpYage',
    );
    writeFileSync(join(env.dir, 'MANIFEST.sha256'), manifest);
    writeFileSync(join(env.dir, 'business_platformXdumpYage'), 'x');
    const { result, calls } = restore(env, env.dir, `${env.secret}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not cover business_platform.dump.age');
    expect(calls).toBe('');
  });

  it('refuses a key that does not open the backup, before touching Docker', () => {
    const env = backedUp();
    const other = keyPair().secret;
    const { result, calls } = restore(env, env.dir, `${other}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not decrypt with that key');
    expect(calls).toBe('');
  });

  it('waits for nothing and changes nothing while a backup holds the backup lock', async () => {
    const env = backedUp();
    const { spawn } = await import('node:child_process');
    const holder = spawn(join(root, 'tools/release/run-locked.pl'), [join(env.home, 'state', 'backup.lock'), 'nowait', '/bin/sleep', '5'], {
      stdio: 'ignore',
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const { result, calls } = restore(env, env.dir, `${env.secret}\n`);
    holder.kill();
    expect(result.status).toBe(75);
    expect(result.stderr).toContain('a backup or another restore is running');
    expect(calls).toBe('');
  });

  it('refuses a bad project name', () => {
    const home = temp();
    const { release } = setup(home);
    const result = spawnSync('/bin/bash', [join(release, 'infra/backup/laptop-restore.sh'), home, '--project', 'Bad Name'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, BP_HOME: home },
    });
    expect(result.status).toBe(2);
  });
});
