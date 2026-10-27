import { describe, expect, it } from 'vitest';
import { redactDetails } from './redact-details';

describe('redactDetails', () => {
  it('replaces sensitive keys and keeps other fields', () => {
    expect(
      redactDetails({
        token: 'super-secret-token',
        nested: { password: 'super-secret-password', note: 'visible' },
        authorization: 'Bearer super-secret-authorization',
      }),
    ).toEqual({
      token: '[Redacted]',
      nested: { password: '[Redacted]', note: 'visible' },
      authorization: '[Redacted]',
    });
  });
});
