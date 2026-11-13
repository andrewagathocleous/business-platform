import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePhase } from './args';
import { giftMessageFromShopifyPayload, giftMessageSha256, readGiftFixture } from './gift';
import { formatTable, hasFailure, scrub } from './report';
import { repositoryRoot } from './root';
import { E4_TOTALS, parseState, totalsEqual, writeState, type MilestoneState } from './state';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('parsePhase', () => {
  it('accepts either flag form', () => {
    expect(parsePhase(['--phase', 'initial'])).toBe('initial');
    expect(parsePhase(['--phase=after-restart'])).toBe('after-restart');
  });

  it('rejects a missing phase', () => {
    expect(() => parsePhase([])).toThrow('usage:');
  });
});

describe('formatTable', () => {
  it('prints PASS and FAIL and scrubs a service token', () => {
    const table = formatTable([
      { item: '1 dev login', result: 'PASS', detail: 'ok' },
      { item: '12 service token', result: 'FAIL', detail: 'saw bps_abc.def' },
    ]);
    expect(table).toContain('PASS');
    expect(table).toContain('FAIL');
    expect(table).toContain('bps_[redacted]');
    expect(table).not.toContain('bps_abc');
    expect(hasFailure([{ item: 'x', result: 'FAIL', detail: 'no' }])).toBe(true);
    expect(hasFailure([{ item: 'x', result: 'PASS', detail: 'yes' }])).toBe(false);
    expect(scrub('postgresql://bp_app:secret@postgres/db')).toBe('postgresql://[redacted]');
  });
});

describe('milestone state', () => {
  it('round-trips and writes mode 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bp-milestone-'));
    directories.push(directory);
    const file = join(directory, 'nested', 'milestone-state.json');
    writeState(file, sampleState());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(parseState(readFileSync(file, 'utf8'))).toEqual(sampleState());
  });

  it('compares totals as strings', () => {
    expect(totalsEqual(E4_TOTALS, { ...E4_TOTALS })).toBe(true);
    expect(totalsEqual(E4_TOTALS, { ...E4_TOTALS, total: '20.230' })).toBe(false);
  });

  it('rejects a state file without the gift hash', () => {
    expect(() => parseState('{}')).toThrow('milestone state is unreadable');
  });
});

describe('gift message hash', () => {
  it('changes when one byte of the fixture message changes', () => {
    const message = readGiftFixture();
    expect(message.includes('Με αγάπη, \n')).toBe(true);
    const hash = giftMessageSha256(message);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(giftMessageSha256(message)).toBe(hash);
    expect(giftMessageSha256(message.replace('Με αγάπη, ', 'Με αγάπη,'))).not.toBe(hash);
    expect(giftMessageFromShopifyPayload({ customAttributes: [{ key: 'Gift Message', value: message }] })).toBe(
      message,
    );
  });
});

describe('stack contract', () => {
  const root = repositoryRoot();
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

  it('keeps production compose free of the dev login, seed and CREATEDB', () => {
    const prod = read('infra/compose/compose.prod.yml');
    expect(prod).toContain('BP_OWNER_CREATEDB: "off"');
    expect(prod).not.toContain('BP_OWNER_CREATEDB: "on"');
    expect(prod).not.toContain('N8N_SECURE_COOKIE');
    expect(prod).not.toContain('demo:import');
    expect(prod).not.toContain('db:seed');
    expect(prod).not.toContain('target: tools');
    expect(prod).toContain('AUTH_DEV_LOGIN_ENABLED: "false"');
    expect(prod).not.toContain('AUTH_DEV_LOGIN_ENABLED: "true"');
    expect(prod).toContain('TRUST_PROXY_HOPS: "1"');
    expect(prod).not.toContain('default /opt/business-platform/env');
    const runner = prod.slice(prod.indexOf('  n8n-runner:'));
    expect(runner).toContain('n8n-runner.env');
    expect(runner).not.toContain('n8n.env');
    expect(read('infra/docker/api.Dockerfile')).toContain("createRequire(require.resolve('@bp/db'))");
    expect(read('infra/docker/api.Dockerfile')).toContain('prisma CLI must not be in the runtime image');
    const webImage = read('infra/docker/web.Dockerfile');
    expect(webImage).toContain('65532');
    expect(webImage).not.toContain('apk add');
    expect(webImage).not.toContain('setcap');
    expect(prod).toContain('127.0.0.1:5678:5678');
    expect(prod).toContain('80:80');
    expect(prod).toContain('443:443');
    expect(prod).toContain('/tmp/bp-worker-heartbeat');
    expect(prod).toContain('60000');
    expect(prod).toContain('stop_grace_period: 45s');
    expect(prod).toContain('service_completed_successfully');
    expect(read('apps/api/src/automation/jobs/worker-heartbeat.ts')).toContain("'/tmp/bp-worker-heartbeat'");
  });

  it('binds the local stack to loopback and the demo profile', () => {
    const local = read('infra/compose/compose.local.yml');
    expect(local).toContain('name: business-platform-local');
    expect(local).toContain('127.0.0.1:8443:443');
    expect(local).toContain('127.0.0.1:15678:5678');
    expect(local).not.toContain('0.0.0.0');
    expect(local).not.toContain('80:80');
    expect(local).toContain('profiles: ["demo"]');
    expect(local).toContain('target: tools');
    expect(local).toContain('--with-prestashop-order');
    expect(local).toContain('APP_ENV: development');
    expect(local).toContain('AUTH_DEV_LOGIN_ENABLED: "true"');
    expect(local).toContain('SESSION_COOKIE_SECURE: "true"');
    expect(local).toContain('N8N_SECURE_COOKIE: "false"');
    expect(local).toContain('.env.local-stack');
    const caddy = local.slice(local.indexOf('  caddy:'), local.indexOf('  api:'));
    expect(caddy).toContain('env_file: !reset []');
    expect(caddy).not.toContain('.env.local-stack');
    const runner = local.slice(local.indexOf('  n8n-runner:'));
    expect(runner).toContain('env_file: !reset []');
    expect(runner).toContain('N8N_RUNNERS_AUTH_TOKEN');
  });

  it('serves the SPA CSP without n8n or an inline script', () => {
    const app = read('infra/caddy/app.caddy');
    const prod = read('infra/caddy/Caddyfile');
    const local = read('infra/caddy/Caddyfile.local');
    expect(prod).toContain('{$APP_DOMAIN}');
    expect(prod).toContain('{$ACME_EMAIL}');
    expect(prod).toContain('Strict-Transport-Security');
    expect(local).toContain('tls internal');
    expect(local).not.toContain('Strict-Transport-Security');
    expect(app).toContain('reverse_proxy api:3000');
    expect(app).not.toContain('n8n');
    expect(app).toContain('max_size 1MiB');
    expect(app).toContain('/main-*.js');
    expect(app).toContain('/chunk-*.js');
    expect(app).toContain('/polyfills-*.js');
    expect(app).toContain('/styles-*.css');
    expect(app).toContain('/media/*');
    expect(app).not.toContain('*.ico');
    expect(app).toContain('PrimeNG');
    expect(app).toContain('inlineCritical');
    expect(app).toContain("script-src 'self'");
    expect(app).not.toContain('unsafe-eval');
    expect(app).toContain("frame-ancestors 'none'");
    expect(app).toContain('no-cache');
    expect(app).toContain('immutable');
    expect(read('apps/web/project.json')).toContain('"inlineCritical": false');
  });

  it('re-exports the Caddy CA on every verify run', () => {
    const source = read('tools/milestone/verify.ts');
    const ca = source.slice(source.indexOf('function ensureCa'), source.indexOf('const UNCHECKED'));
    expect(ca).toContain('caddy:/data/caddy/pki/authorities/local/root.crt');
    expect(ca).not.toContain('if (!existsSync(caPath))');
  });

  it('gives only POST client import previews 4 MiB before the general 1 MiB body limit', () => {
    const app = read('infra/caddy/app.caddy');
    const matchers = [
      app.match(/@clientImport\s*\{\s*([\s\S]*?)\n\t\}/)?.[1],
      app.match(/@standardBody\s*\{\s*not\s*\{\s*([\s\S]*?)\n\t\t\}\s*\}/)?.[1],
    ];
    for (const matcher of matchers) {
      expect(matcher?.trim().split(/\n\s*/)).toEqual([
        'method POST',
        "expression {http.request.orig_uri}.matches('^/api/c/[^/?]+/clients/imports/?([?].*)?$')",
      ]);
    }
    // Anchors, one company segment and case sensitivity agree with Express; req.path excludes queries.
    const express = read('apps/api/src/http/configure-http.ts');
    expect(express).toContain("req.method === 'POST'");
    expect(express).toContain(String.raw`/^\/api\/c\/[^/]+\/clients\/imports\/?$/.test(req.path)`);
    expect(app).toMatch(/request_body @clientImport\s*\{\s*max_size 4MiB\s*\}/);
    expect(app).toMatch(/request_body @standardBody\s*\{\s*max_size 1MiB\s*\}/);
    expect(app.match(/request_body\s/g)).toHaveLength(2);
    expect(app.indexOf('request_body @clientImport')).toBeLessThan(
      app.indexOf('request_body @standardBody'),
    );
  });

  it('uses the same fictional PrestaShop number in the import and the milestone', () => {
    expect(read('apps/api/src/demo-import-args.ts')).toContain('#P-1001');
    expect(read('tools/milestone/verify.ts')).toContain('#P-1001');
    expect(read('apps/api/src/auth.integration.test.ts')).toContain(
      'completes an OIDC login and records whether amr includes mfa',
    );
  });
});

function sampleState(): MilestoneState {
  const id = '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e4f';
  return {
    companyA: id,
    companyB: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e50',
    clientId: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e51',
    invoiceId: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e52',
    invoiceTotals: E4_TOTALS,
    orderId: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e53',
    giftSha256: 'a'.repeat(64),
    printJobId: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e54',
    fileId: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e55',
    prestashopOrderId: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e56',
    connectionB: '018f6c2e-7b1a-7c3d-8e4f-9a0b1c2d3e57',
    printSwitchChanged: false,
  };
}
