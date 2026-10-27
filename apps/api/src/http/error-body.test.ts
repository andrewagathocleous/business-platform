import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
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

  it('keeps a domain guard code on a 422', () => {
    const rendered = errorBody(
      new UnprocessableEntityException({
        code: 'payment_not_settled',
        message: 'payment_not_settled',
      }),
      'corr-12345678',
    );
    expect(rendered.status).toBe(422);
    expect(rendered.body.error.code).toBe('payment_not_settled');
    expect(rendered.body.error.message).toBe('payment_not_settled');
  });

  it('returns the existing print job id for already_printed', () => {
    const rendered = errorBody(
      new ConflictException({
        code: 'already_printed',
        message: 'already_printed',
        printJobId: '01932a1e-7b4c-7c2a-8e10-222222222222',
      }),
      'corr-12345678',
    );
    expect(rendered.status).toBe(409);
    expect(rendered.body.error.code).toBe('already_printed');
    expect(rendered.body.error.printJobId).toBe('01932a1e-7b4c-7c2a-8e10-222222222222');
  });
});
