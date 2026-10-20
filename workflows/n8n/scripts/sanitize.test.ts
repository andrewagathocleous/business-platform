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
