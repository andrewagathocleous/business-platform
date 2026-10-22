import { describe, expect, it } from 'vitest';
import { validateCompose } from './check-compose-config.mjs';

describe('compose config', () => {
  it('rejects an extra published port, including one with no host address', () => {
    const local = localConfig();
    const caddy = service(local, 'caddy');
    caddy.ports.push({ target: 443, published: '9443', protocol: 'tcp' });
    const failures = validateCompose('local', local);
    expect(failures.some((failure) => failure.includes('9443'))).toBe(true);

    const missingHost = localConfig();
    service(missingHost, 'caddy').ports = [{ target: 443, published: '8443', protocol: 'tcp' }];
    expect(validateCompose('local', missingHost).some((failure) => failure.includes('public:'))).toBe(true);
  });

  it('rejects runner and caddy secrets and a production dev-login flag', () => {
    const prod = prodConfig();
    const runner = service(prod, 'n8n-runner');
    runner.environment.N8N_ENCRYPTION_KEY = 'not-printed';
    expect(validateCompose('prod', prod).some((failure) => failure.includes('n8n-runner receives secret N8N_ENCRYPTION_KEY'))).toBe(
      true,
    );

    const caddy = prodConfig();
    service(caddy, 'caddy').environment.DATABASE_URL = 'not-printed';
    expect(validateCompose('prod', caddy).some((failure) => failure.includes('caddy receives secret DATABASE_URL'))).toBe(true);

    const login = prodConfig();
    service(login, 'api').environment.AUTH_DEV_LOGIN_ENABLED = 'true';
    expect(validateCompose('prod', login).some((failure) => failure.includes('AUTH_DEV_LOGIN_ENABLED'))).toBe(true);
  });

  it('rejects N8N_SECURE_COOKIE=false on one service when another service sets true', () => {
    const prod = prodConfig();
    service(prod, 'n8n').environment.N8N_SECURE_COOKIE = 'false';
    service(prod, 'api').environment.N8N_SECURE_COOKIE = 'true';
    expect(validateCompose('prod', prod).some((failure) => failure.includes('N8N_SECURE_COOKIE'))).toBe(true);
  });

  it('accepts the loopback local ports and the production port set', () => {
    expect(validateCompose('local', localConfig())).toEqual([]);
    expect(validateCompose('prod', prodConfig())).toEqual([]);
  });
});

function localConfig() {
  return {
    name: 'business-platform-local',
    services: {
      caddy: {
        ports: [{ host_ip: '127.0.0.1', published: '8443', target: 443, protocol: 'tcp' }],
        networks: { edge: null },
        environment: { APP_DOMAIN: 'localhost' },
      },
      n8n: {
        ports: [{ host_ip: '127.0.0.1', published: '15678', target: 5678, protocol: 'tcp' }],
        networks: { internal: null },
        environment: { N8N_SECURE_COOKIE: 'false' },
      },
      'n8n-runner': {
        networks: { internal: null },
        environment: {
          N8N_RUNNERS_AUTH_TOKEN: 'not-printed',
          N8N_RUNNERS_TASK_BROKER_URI: 'http://n8n:5679',
        },
      },
      postgres: { networks: { internal: null }, environment: { BP_OWNER_CREATEDB: 'off' } },
      api: {
        networks: { edge: null, internal: null },
        environment: {
          AUTH_DEV_LOGIN_ENABLED: 'true',
          SESSION_COOKIE_SECURE: 'true',
          APP_ENV: 'development',
        },
      },
      seed: { environment: {} },
      'import-fixtures': { command: ['node', 'dist/main.js', '--with-prestashop-order'] },
    },
  };
}

function prodConfig() {
  return {
    name: 'business-platform',
    services: {
      caddy: {
        ports: [
          { published: '80', target: 80, protocol: 'tcp' },
          { published: '443', target: 443, protocol: 'tcp' },
          { published: '443', target: 443, protocol: 'udp' },
        ],
        networks: { edge: null },
        environment: { APP_DOMAIN: 'app.example.test', ACME_EMAIL: 'ops@example.test' },
      },
      n8n: {
        ports: [{ host_ip: '127.0.0.1', published: '5678', target: 5678, protocol: 'tcp' }],
        networks: { internal: null },
        environment: {},
      },
      'n8n-runner': {
        networks: { internal: null },
        environment: {
          N8N_RUNNERS_AUTH_TOKEN: 'not-printed',
          N8N_RUNNERS_TASK_BROKER_URI: 'http://n8n:5679',
        },
      },
      postgres: { networks: { internal: null }, environment: { BP_OWNER_CREATEDB: 'off' } },
      api: {
        networks: { edge: null, internal: null },
        environment: {
          AUTH_DEV_LOGIN_ENABLED: 'false',
          SESSION_COOKIE_SECURE: 'true',
        },
      },
    },
  };
}

/**
 * @param {{ services: Record<string, { ports?: unknown[], environment?: Record<string, string> }> }} config
 * @param {string} name
 */
function service(config, name) {
  const found = config.services[name];
  if (!found) {
    throw new Error(`${name} is missing`);
  }
  found.environment ??= {};
  found.ports ??= [];
  return found;
}
