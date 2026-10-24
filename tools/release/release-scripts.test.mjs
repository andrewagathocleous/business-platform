import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const root = resolve(here, '../..');
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'bp-release-test-'));
  directories.push(directory);
  return directory;
}

/** A fake `docker` that records its arguments and answers `image inspect` and `volume ls` as told. */
function fakeDocker(bin, { inspectOk = true, volumeLsOk = true } = {}) {
  mkdirSync(bin, { recursive: true });
  const log = join(bin, 'docker.log');
  const script = [
    '#!/bin/bash',
    `echo "$*" >> "${log}"`,
    `echo "BP_IMAGE_TAG=$BP_IMAGE_TAG BP_ENV_DIR=$BP_ENV_DIR" >> "${log}"`,
    'if [[ "$1 $2" == "image inspect" ]]; then',
    `  exit ${inspectOk ? 0 : 1}`,
    'fi',
    'if [[ "$1 $2" == "volume inspect" ]]; then',
    '  exit 1',
    'fi',
    'if [[ "$1 $2" == "volume ls" ]]; then',
    `  exit ${volumeLsOk ? 0 : 1}`,
    'fi',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(bin, 'docker'), script);
  chmodSync(join(bin, 'docker'), 0o755);
  return log;
}

function run(script, args, env) {
  return spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('laptop-env.sh', () => {
  it('writes private env files with consistent random secrets and prints none of them', () => {
    const home = temp();
    const result = run(join(here, 'laptop-env.sh'), [], { BP_HOME: home });
    expect(result.status, result.stderr).toBe(0);
    const envDir = join(home, 'env');
    expect(statSync(envDir).mode & 0o777).toBe(0o700);
    const files = ['postgres.env', 'migrate.env', 'api.env', 'n8n.env', 'n8n-runner.env'];
    const values = new Map();
    for (const file of files) {
      expect(statSync(join(envDir, file)).mode & 0o777).toBe(0o600);
      for (const line of readFileSync(join(envDir, file), 'utf8').trim().split('\n')) {
        const eq = line.indexOf('=');
        values.set(`${file}:${line.slice(0, eq)}`, line.slice(eq + 1));
      }
    }
    const owner = values.get('postgres.env:BP_OWNER_PASSWORD');
    const app = values.get('postgres.env:BP_APP_PASSWORD');
    expect(owner).toMatch(/^[0-9a-f]{64}$/);
    expect(values.get('migrate.env:DATABASE_URL_OWNER')).toBe(
      `postgresql://bp_owner:${owner}@postgres:5432/business_platform`,
    );
    expect(values.get('api.env:DATABASE_URL')).toBe(`postgresql://bp_app:${app}@postgres:5432/business_platform`);
    expect(values.get('n8n.env:DB_POSTGRESDB_PASSWORD')).toBe(values.get('postgres.env:N8N_DB_PASSWORD'));
    expect(values.get('n8n-runner.env:N8N_RUNNERS_AUTH_TOKEN')).toBe(values.get('n8n.env:N8N_RUNNERS_AUTH_TOKEN'));
    const master = JSON.parse(values.get('api.env:APP_MASTER_KEYS') ?? '{}');
    expect(Buffer.from(master.k1, 'base64')).toHaveLength(32);
    expect(values.get('api.env:APP_ENV')).toBe('production');
    expect(values.get('api.env:AUTH_DEV_LOGIN_ENABLED')).toBe('false');
    expect(values.get('api.env:OIDC_CLIENT_SECRET')).toBe('replace-me');
    const printed = result.stdout + result.stderr;
    for (const [key, value] of values) {
      if (/PASSWORD|SECRET|KEY|TOKEN|DATABASE_URL/.test(key) && value !== 'replace-me' && value.length > 8) {
        expect(printed).not.toContain(value);
      }
    }
  });

  it('stops when another run holds the lock', () => {
    const home = temp();
    mkdirSync(join(home, '.laptop-env.lock'), { recursive: true });
    const result = run(join(here, 'laptop-env.sh'), [], { BP_HOME: home });
    expect(result.status).toBe(1);
    expect(existsSync(join(home, 'env'))).toBe(false);
  });

  it('refuses to overwrite existing env files', () => {
    const home = temp();
    mkdirSync(join(home, 'env'));
    writeFileSync(join(home, 'env', 'api.env'), 'APP_ENV=production\n');
    const result = run(join(here, 'laptop-env.sh'), [], { BP_HOME: home });
    expect(result.status).toBe(1);
    expect(readFileSync(join(home, 'env', 'api.env'), 'utf8')).toBe('APP_ENV=production\n');
  });
});

describe('laptop-compose.sh', () => {
  it('runs compose for the live project with the release tag and env directory', () => {
    const home = temp();
    const release = join(home, 'releases', 'abc1234');
    mkdirSync(join(release, 'tools', 'release'), { recursive: true });
    mkdirSync(join(home, 'env'));
    writeFileSync(join(release, 'RELEASE'), 'tag=abc1234\ncommit=x\n');
    writeFileSync(join(release, 'tools', 'release', 'laptop-compose.sh'), readFileSync(join(here, 'laptop-compose.sh')));
    const bin = join(home, 'bin');
    const log = fakeDocker(bin);
    const result = run(join(release, 'tools', 'release', 'laptop-compose.sh'), ['ps'], {
      BP_HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, 'utf8');
    // The script resolves its release directory physically (macOS temp lives under /private).
    const physical = realpathSync(release);
    expect(calls).toContain(
      `compose -p business-platform-live -f ${physical}/infra/compose/compose.prod.yml -f ${physical}/infra/compose/compose.laptop.yml ps`,
    );
    expect(calls).toContain(`BP_IMAGE_TAG=abc1234 BP_ENV_DIR=${home}/env`);
  });

  it('refuses a release without a RELEASE file', () => {
    const home = temp();
    const release = join(home, 'releases', 'x');
    mkdirSync(join(release, 'tools', 'release'), { recursive: true });
    writeFileSync(join(release, 'tools', 'release', 'laptop-compose.sh'), readFileSync(join(here, 'laptop-compose.sh')));
    const result = run(join(release, 'tools', 'release', 'laptop-compose.sh'), ['ps'], { BP_HOME: home });
    expect(result.status).toBe(2);
  });
});

describe('deploy-laptop.sh', () => {
  function bundle(directory, name, content) {
    const file = join(directory, `${name}.tar`);
    writeFileSync(file, content);
    const sum = createHash('sha256').update(content).digest('hex');
    writeFileSync(join(directory, `${name}.tar.sha256`), `${sum}  ${name}.tar\n`);
    return file;
  }

  it('refuses a bundle whose checksum does not match, before touching Docker', () => {
    const home = temp();
    const bin = join(home, 'bin');
    const log = fakeDocker(bin);
    const file = bundle(home, 'bp-abc1234', 'original');
    writeFileSync(file, 'tampered');
    const result = run(join(here, 'deploy-laptop.sh'), [file], { BP_HOME: home, PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match its SHA-256');
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(home, 'releases'))).toBe(false);
  });

  it('refuses a bundle name that is not bp-<tag>.tar', () => {
    const home = temp();
    const file = join(home, 'other.tar');
    writeFileSync(file, 'x');
    expect(run(join(here, 'deploy-laptop.sh'), [file], { BP_HOME: home }).status).toBe(2);
  });

  it('stops when an env file still holds replace-me, before loading images', () => {
    const home = temp();
    const stage = join(home, 'stage');
    mkdirSync(join(stage, 'bp-abc1234'), { recursive: true });
    writeFileSync(join(stage, 'bp-abc1234', 'RELEASE'), 'tag=abc1234\n');
    spawnSync('tar', ['-cf', join(home, 'bp-abc1234.tar'), '-C', stage, 'bp-abc1234']);
    const content = readFileSync(join(home, 'bp-abc1234.tar'));
    writeFileSync(
      join(home, 'bp-abc1234.tar.sha256'),
      `${createHash('sha256').update(content).digest('hex')}  bp-abc1234.tar\n`,
    );
    mkdirSync(join(home, 'env'));
    for (const file of ['postgres.env', 'migrate.env', 'n8n.env', 'n8n-runner.env']) {
      writeFileSync(join(home, 'env', file), 'X=1\n');
    }
    writeFileSync(join(home, 'env', 'api.env'), 'OIDC_CLIENT_SECRET=replace-me\nCSRF_SECRET=not-printed-value\n');
    const bin = join(home, 'bin');
    const log = fakeDocker(bin);
    const result = run(join(here, 'deploy-laptop.sh'), [join(home, 'bp-abc1234.tar')], {
      BP_HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('replace-me');
    expect(result.stderr).toContain('api.env');
    expect(result.stderr).not.toContain('not-printed-value');
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(join(home, 'releases', 'abc1234', 'RELEASE'), 'utf8')).toBe('tag=abc1234\n');
  });
});

describe('deploy-laptop.sh bundle checks', () => {
  /** Builds bp-<tag>.tar from a staging tree and writes its exact sidecar. */
  function pack(home, tag, fill) {
    const stage = join(home, `stage-${Math.random().toString(16).slice(2)}`);
    const name = `bp-${tag}`;
    mkdirSync(join(stage, name), { recursive: true });
    fill(join(stage, name), stage);
    const file = join(home, `${name}.tar`);
    spawnSync('tar', ['-cf', file, '-C', stage, '.'], { encoding: 'utf8' });
    const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
    writeFileSync(`${file}.sha256`, `${sum}  ${name}.tar\n`);
    return file;
  }

  function envFiles(home) {
    mkdirSync(join(home, 'env'), { recursive: true });
    for (const file of ['postgres.env', 'migrate.env', 'api.env', 'n8n.env', 'n8n-runner.env']) {
      writeFileSync(join(home, 'env', file), 'X=1\n');
    }
  }

  it('refuses a sidecar that lists another file', () => {
    const home = temp();
    const file = pack(home, 'abc1234', (dir) => writeFileSync(join(dir, 'RELEASE'), 'tag=abc1234\n'));
    const other = join(home, 'bp-old.tar');
    writeFileSync(other, 'old');
    writeFileSync(`${file}.sha256`, `${createHash('sha256').update('old').digest('hex')}  bp-old.tar\n`);
    const result = run(join(here, 'deploy-laptop.sh'), [file], { BP_HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must hold one SHA-256 line');
    expect(existsSync(join(home, 'releases'))).toBe(false);
  });

  it('refuses a bundle with a symbolic link and installs nothing', () => {
    const home = temp();
    const file = pack(home, 'abc1234', (dir) => {
      writeFileSync(join(dir, 'RELEASE'), 'tag=abc1234\n');
      symlinkSync('/etc', join(dir, 'escape'));
    });
    const result = run(join(here, 'deploy-laptop.sh'), [file], { BP_HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symbolic link');
    expect(existsSync(join(home, 'releases', 'abc1234'))).toBe(false);
  });

  it('does not keep a rejected release, so a corrected bundle can be retried', () => {
    const home = temp();
    const bad = pack(home, 'abc1234', (dir) => writeFileSync(join(dir, 'RELEASE'), 'tag=wrong\n'));
    const rejected = run(join(here, 'deploy-laptop.sh'), [bad], { BP_HOME: home });
    expect(rejected.status).toBe(1);
    expect(existsSync(join(home, 'releases', 'abc1234'))).toBe(false);
    const good = pack(home, 'abc1234', (dir) => writeFileSync(join(dir, 'RELEASE'), 'tag=abc1234\n'));
    const retried = run(join(here, 'deploy-laptop.sh'), [good], { BP_HOME: home });
    expect(retried.stderr).toContain('laptop-env.sh first');
    expect(readFileSync(join(home, 'releases', 'abc1234', 'RELEASE'), 'utf8')).toBe('tag=abc1234\n');
  });

  it('refuses to reuse an installed release that contains a link', () => {
    const home = temp();
    const file = pack(home, 'abc1234', (dir) => {
      writeFileSync(join(dir, 'RELEASE'), 'tag=abc1234\n');
      mkdirSync(join(dir, 'tools'));
      writeFileSync(join(dir, 'tools', 'x.sh'), 'echo same\n');
    });
    const installed = join(home, 'releases', 'abc1234');
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, 'RELEASE'), 'tag=abc1234\n');
    const elsewhere = join(home, 'elsewhere-tools');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'x.sh'), 'echo same\n');
    symlinkSync(elsewhere, join(installed, 'tools'));
    const result = run(join(here, 'deploy-laptop.sh'), [file], { BP_HOME: home });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists with other contents');
  });

  it('stops when Docker cannot list volumes instead of skipping the backup', () => {
    const home = temp();
    envFiles(home);
    const file = pack(home, 'abc1234', (dir) => {
      writeFileSync(join(dir, 'RELEASE'), 'tag=abc1234\n');
      writeFileSync(join(dir, 'images.tar'), 'not really images');
    });
    const bin = join(home, 'bin');
    const log = fakeDocker(bin, { volumeLsOk: false });
    const result = run(join(here, 'deploy-laptop.sh'), [file], { BP_HOME: home, PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not list Docker volumes');
    expect(readFileSync(log, 'utf8')).not.toContain('compose');
  });
});

describe('export-images.sh', () => {
  it('refuses a tag that is not HEAD', () => {
    const result = run(join(here, 'export-images.sh'), ['not-head-tag', temp()], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not HEAD');
  });

  it('refuses when an image is missing', () => {
    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const bin = join(temp(), 'bin');
    fakeDocker(bin, { inspectOk: false });
    const out = temp();
    const result = run(join(here, 'export-images.sh'), [head, out], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`bp-api:${head} is missing`);
    expect(existsSync(join(out, `bp-${head}.tar`))).toBe(false);
  });
});

describe('install-launchd.sh', () => {
  it('refuses a home path with a backslash before touching launchd', () => {
    const result = run(join(here, 'install-launchd.sh'), [], { BP_HOME: '/Users/owner/business\\platform' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('backslash');
  });
});

describe('launchd template', () => {
  it('renders to a valid property list', () => {
    if (spawnSync('which', ['plutil']).status !== 0) {
      return;
    }
    const template = readFileSync(join(root, 'infra/launchd/com.business-platform.stack.plist.template'), 'utf8');
    const rendered = template.replaceAll('__BP_HOME__', '/Users/owner/business-platform').replaceAll('__HOME__', '/Users/owner');
    const file = join(temp(), 'stack.plist');
    writeFileSync(file, rendered);
    const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    expect(rendered).not.toContain('__');
  });
});
