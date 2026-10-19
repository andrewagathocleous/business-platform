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

  it('allows credential and env expressions on sensitive headers', () => {
    const result = sanitizeWorkflow({
      nodes: [
        {
          parameters: {
            headerParameters: {
              parameters: [
                { name: 'Authorization', value: '={{ $credentials.httpHeaderAuth.value }}' },
                { name: 'X-Api-Key', value: '={{ $env.SHOPIFY_TOKEN }}' },
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
                { name: 'Content-Type', value: 'application/json' },
              ],
            },
          },
        },
      ],
    });
  });
});
