import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sanitizeWorkflow } from './sanitize.mjs';

describe('sanitizeWorkflow', () => {
  it('strips pin data, static data, credential ids and execution metadata', () => {
    const result = sanitizeWorkflow({
      name: 'Demo',
      pinData: { Keep: 'no' },
      staticData: { secret: 'no' },
      versionId: 'v1',
      meta: { instanceId: 'abc' },
      nodes: [
        {
          name: 'HTTP',
          credentials: { httpHeaderAuth: { id: '42', name: 'Demo header' } },
        },
      ],
    });
    expect(result).toEqual({
      name: 'Demo',
      nodes: [{ name: 'HTTP', credentials: { httpHeaderAuth: { name: 'Demo header' } } }],
    });
  });

  it('fails when a secret-like value remains', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: 'postgresql://bp_app:super-secret@db/business_platform' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('fails when an HTTP header parameter carries a literal authorization token', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              headerParameters: {
                parameters: [
                  {
                    name: 'Authorization',
                    value: 'Bearer fictional-review-token-12345678901234567890',
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it.each([
    'authorization',
    'x-api-key',
    'api_key',
    'apikey',
    'token',
    'access_token',
    'x-shopify-access-token',
    'cookie',
    'password',
    'secret',
    'client_secret',
  ])('fails when a query parameter is named %s', (name) => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              queryParameters: {
                parameters: [{ name, value: 'literal-value' }],
              },
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('fails when a JSON body string contains a token', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              jsonBody: '{"token":"fictional-review-token-12345678901234567890"}',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('fails when parameters contain a basic credential literal', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { body: 'Basic dXNlcjpwYXNzd29yZA==' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects an authorization expression that only mentions $env', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              headerParameters: {
                parameters: [
                  {
                    name: 'Authorization',
                    value: '={{ "$env" && "Bearer fictional-token-1234" }}',
                  },
                ],
              },
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects a password inside expression-wrapped JSON', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { jsonBody: '={{ {"password":"fictional-password"} }}' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects credentials in a URL userinfo', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: 'https://demo:secret@example.test/data' } }],
      }),
    ).toThrow(/Possible secret/);
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: 'https://demo@example.test/data' } }],
      }),
    ).toThrow(/Possible secret/);
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: '={{ "https://demo:secret@example.test/data" }}' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects bearer and high-entropy string literals inside expressions', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { note: '={{ "Bearer fictional-token-1234" }}' } }],
      }),
    ).toThrow(/Possible secret/);
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              note: '={{ "fictional-review-token-12345678901234567890" }}',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects nested JSON secrets, including literals inside arrays', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { jsonBody: '{"auth":{"token":"literal-token"}}' } }],
      }),
    ).toThrow(/Possible secret/);
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              body: '{"auth":{"password":["fictional-password"]}}',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects a literal secret in a URL query parameter', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: 'https://example.test/?api_key=literal-key' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('allows ordinary API URLs and company URLs that contain a UUID', () => {
    const result = sanitizeWorkflow({
      nodes: [
        {
          parameters: {
            graph: 'https://graph.microsoft.com/v1.0/me/messages',
            company: 'https://example.test/companies/018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b/orders',
          },
        },
      ],
    });
    expect(result).toEqual({
      nodes: [
        {
          parameters: {
            graph: 'https://graph.microsoft.com/v1.0/me/messages',
            company: 'https://example.test/companies/018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b/orders',
          },
        },
      ],
    });
  });

  it('rejects a long non-UUID path segment and a high-entropy query value', () => {
    const segment = 'Ab9xK2mQ7pL4nR8sT1uV6wY3zC5dE0fGhIj';
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: `https://example.test/${segment}` } }],
      }),
    ).toThrow(/Possible secret/);
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              url: 'https://example.test/?note=Ab9xK2mQ7pL4nR8sT1uV6wY3zC5dE0fG',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects a sensitive binding initialised with a literal', () => {
    const bodies = [
      "={{ (() => { const password = 'fixture-pass'; return password; })() }}",
      '={{ (() => { let token = "x"; return token; })() }}',
      '={{ (() => { var { apiKey } = { apiKey: "x" }; return apiKey; })() }}',
    ];
    for (const jsonBody of bodies) {
      expect(() => sanitizeWorkflow({ nodes: [{ parameters: { jsonBody } }] }), jsonBody).toThrow(
        /Possible secret/,
      );
    }
    const allowed = sanitizeWorkflow({
      nodes: [
        {
          parameters: {
            jsonBody:
              '={{ (() => { const password = $credentials.shopify; const token = $env.SHOP_TOKEN; return password; })() }}',
          },
        },
      ],
    });
    expect(allowed).toEqual({
      nodes: [
        {
          parameters: {
            jsonBody:
              '={{ (() => { const password = $credentials.shopify; const token = $env.SHOP_TOKEN; return password; })() }}',
          },
        },
      ],
    });
    expect(
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              jsonBody: "={{ (() => { const label = 'fixture-pass'; return label; })() }}",
            },
          },
        ],
      }),
    ).toEqual({
      nodes: [
        {
          parameters: {
            jsonBody: "={{ (() => { const label = 'fixture-pass'; return label; })() }}",
          },
        },
      ],
    });
  });

  it('rejects sensitive assignments in bare, quoted and template keys', () => {
    const bodies = [
      '={{ { password: "fictional-password" } }}',
      "={{ { 'token': 'x' } }}",
      '={{ { "password": "fictional-password" } }}',
      '={{ { [`token`]: `secret` } }}',
    ];
    for (const jsonBody of bodies) {
      expect(() => sanitizeWorkflow({ nodes: [{ parameters: { jsonBody } }] })).toThrow(
        /Possible secret/,
      );
    }
    // A template literal is not a JavaScript property name, so the span does not parse.
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { jsonBody: '={{ { `token`: `secret` } }}' } }],
      }),
    ).toThrow(/unparseable expression; cannot verify it is secret-free/);
    const allowed = sanitizeWorkflow({
      nodes: [{ parameters: { jsonBody: '={{ { password: $credentials.shopify } }}' } }],
    });
    expect(allowed).toEqual({
      nodes: [{ parameters: { jsonBody: '={{ { password: $credentials.shopify } }}' } }],
    });
  });

  it('rejects URL userinfo in plain, expression and interpolated values', () => {
    for (const url of [
      'https://demo:secret@example.test/data',
      '={{ "https://demo:secret@example.test/data" }}',
      '=https://demo:secret@example.test/data/{{ $json.id }}',
    ]) {
      expect(() => sanitizeWorkflow({ nodes: [{ parameters: { url } }] })).toThrow(
        /Possible secret/,
      );
    }
    const ordinary = sanitizeWorkflow({
      nodes: [{ parameters: { url: 'https://example.test/data/{{ $json.id }}' } }],
    });
    expect(ordinary).toEqual({
      nodes: [{ parameters: { url: 'https://example.test/data/{{ $json.id }}' } }],
    });
  });

  it('rejects computed keys, escaped keys, concatenations and interpolated userinfo', () => {
    const bodies = [
      '={{ { ["password"]: "short" } }}',
      '={{ { \\u0070assword: "x" } }}',
      '={{ { password: $credentials.shopify + "literal-secret" } }}',
      '={{ headers["Authorization"] = $credentials.shopify + "literal-secret" }}',
      '={{ { ["pass" + "word"]: "short" } }}',
    ];
    for (const jsonBody of bodies) {
      expect(() => sanitizeWorkflow({ nodes: [{ parameters: { jsonBody } }] }), jsonBody).toThrow(
        /Possible secret/,
      );
    }
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              url: '=https://{{ $json.user }}:secret@example.test/data/{{ $json.id }}',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('allows ordinary field names, credential references and public URLs', () => {
    const result = sanitizeWorkflow({
      nodes: [
        {
          parameters: {
            status: '={{ $json.displayFulfillmentStatus }}',
            address: '={{ $json.customer.defaultAddress }}',
            graph: 'https://graph.microsoft.com/v1.0/me/messages',
            company: 'https://example.test/companies/018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b/orders',
            jsonBody: '={{ { password: $credentials.x.y } }}',
            token: '={{ $env["X"] }}',
          },
        },
      ],
    });
    expect(result).toEqual({
      nodes: [
        {
          parameters: {
            status: '={{ $json.displayFulfillmentStatus }}',
            address: '={{ $json.customer.defaultAddress }}',
            graph: 'https://graph.microsoft.com/v1.0/me/messages',
            company: 'https://example.test/companies/018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b/orders',
            jsonBody: '={{ { password: $credentials.x.y } }}',
            token: '={{ $env["X"] }}',
          },
        },
      ],
    });
  });

  it('accepts every workflow JSON file under workflows/n8n', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = await jsonFiles(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (isWorkflowExport(parsed)) {
        expect(() => sanitizeWorkflow(parsed), file).not.toThrow();
      }
    }
  });

  it('rejects a high-entropy type nested under parameters', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              type: 'n8n-nodes-base.Ab1cdEf2ghIj3klMnOp4qrSt5uvWx6yz',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('allows an n8n node type and still rejects a high-entropy type', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ type: 'n8n-nodes-base.scheduleTrigger', parameters: {} }],
      }),
    ).not.toThrow();
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ type: 'Ab1cdEf2ghIj3klMnOp4qrSt5uvWx6yz', parameters: {} }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('exports W0 inactive, posting store-sync with the header-auth name only', async () => {
    const file = fileURLToPath(new URL('../exports/w0-store-sync.json', import.meta.url));
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    expect(isWorkflowExport(parsed)).toBe(true);
    if (!isWorkflowExport(parsed) || typeof parsed !== 'object' || parsed === null) {
      return;
    }
    expect(() => sanitizeWorkflow(parsed)).not.toThrow();
    expect('active' in parsed && parsed.active).toBe(false);
    const text = JSON.stringify(parsed);
    expect(text).toContain(
      'http://api:3000/api/automation/v1/c/REPLACE_WITH_COMPANY_ID/store-sync',
    );
    expect(text).toContain('bp store-sync token');
    expect(text).not.toContain('bps_');
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });

  it('rejects a literal password beside an interpolated json field', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              jsonBody: '={"password":"short","id":"{{ $json.id }}"}',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects a token query hidden in an expression string', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { url: '={{ "https://example.test/?token=short" }}' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('allows a json body that interpolates $json and has no sensitive keys', () => {
    const jsonBody = '={"id":"{{ $json.id }}","note":"hello"}';
    expect(sanitizeWorkflow({ nodes: [{ parameters: { jsonBody } }] })).toEqual({
      nodes: [{ parameters: { jsonBody } }],
    });
  });

  it('rejects url userinfo hidden in a template literal', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [
          {
            parameters: {
              url: '={{ `https://${$json.user}:short@example.test/` }}',
            },
          },
        ],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects an unresolved computed key and a computed member assignment', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { jsonBody: '={{ { [k]: "short" } }}' } }],
      }),
    ).toThrow(/Possible secret/);
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { jsonBody: '={{ obj[k] = "short" }}' } }],
      }),
    ).toThrow(/Possible secret/);
  });

  it('rejects an object whose closing brace sits against the span end', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { jsonBody: '={{ { password:"short"}}}' } }],
      }),
    ).toThrow(/^Possible secret at nodes\.0\.parameters\.jsonBody$/);
  });

  it('rejects an expression that does not parse', () => {
    expect(() =>
      sanitizeWorkflow({
        nodes: [{ parameters: { note: '={{ { }}' } }],
      }),
    ).toThrow(/unparseable expression; cannot verify it is secret-free/);
  });

  it('allows credential and env expressions on sensitive headers', () => {
    const result = sanitizeWorkflow({
      nodes: [
        {
          parameters: {
            headerParameters: {
              parameters: [
                { name: 'Authorization', value: '={{ $credentials.httpHeaderAuth.value }}' },
                { name: 'X-Api-Key', value: '={{ $env.SHOPIFY_TOKEN }}' },
                { name: 'X-Auth-Token', value: "={{ $env['SHOPIFY_TOKEN'] }}" },
                { name: 'Content-Type', value: 'application/json' },
              ],
            },
          },
        },
      ],
    });
    expect(result).toEqual({
      nodes: [
        {
          parameters: {
            headerParameters: {
              parameters: [
                { name: 'Authorization', value: '={{ $credentials.httpHeaderAuth.value }}' },
                { name: 'X-Api-Key', value: '={{ $env.SHOPIFY_TOKEN }}' },
                { name: 'X-Auth-Token', value: "={{ $env['SHOPIFY_TOKEN'] }}" },
                { name: 'Content-Type', value: 'application/json' },
              ],
            },
          },
        },
      ],
    });
  });
});

async function jsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) {
      continue;
    }
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      files.push(...(await jsonFiles(path)));
    } else if (entry.endsWith('.json')) {
      files.push(path);
    }
  }
  return files;
}

function isWorkflowExport(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'nodes' in value && Array.isArray(value.nodes)
  );
}
