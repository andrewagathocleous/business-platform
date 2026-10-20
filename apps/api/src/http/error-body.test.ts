import { describe, expect, it } from 'vitest';
import { errorBody } from './error-body';

describe('errorBody', () => {
  it('hides stack traces and internal messages', () => {
    const error = new Error('SENTINEL_STACK_FRAME');
    error.stack = 'SENTINEL_STACK_FRAME\n    at secret (main.ts:1:1)';
    const rendered = errorBody(error, 'corr-12345678');
    expect(rendered.status).toBe(500);
    expect(rendered.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Internal server error',
        correlationId: 'corr-12345678',
      },
    });
    expect(JSON.stringify(rendered)).not.toContain('SENTINEL_STACK_FRAME');
    expect(JSON.stringify(rendered)).not.toContain('main.ts');
  });
});
