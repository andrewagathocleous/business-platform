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

  it('lists the failed field codes of a 422 and drops anything else', () => {
    const rendered = errorBody(
      new UnprocessableEntityException({
        code: 'invoice_incomplete',
        message: 'missing details',
        fields: ['seller.vatNumber', 'lines.2.legalNote', '<script>', 42],
      }),
      'corr-12345678',
    );
    expect(rendered.body.error.fields).toEqual(['seller.vatNumber', 'lines.2.legalNote']);
    const conflict = errorBody(
      new ConflictException({ code: 'not_draft', message: 'x', fields: ['seller.vatNumber'] }),
      'corr-12345678',
    );
    expect(conflict.body.error.fields).toBeUndefined();
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

  it('passes a possible duplicate match and drops anything else', () => {
    const rendered = errorBody(
      new ConflictException({
        code: 'possible_duplicate',
        message: 'possible_duplicate',
        details: {
          id: '01932a1e-7b4c-7c2a-8e10-222222222222',
          date: '2026-10-28',
          amount: '12.50',
          reference: '  Receipt\nA  ',
          recordedAt: '2026-10-28T10:15:00.000Z',
          notes: 'PRIVATE-NOTE-SENTINEL',
          createdBy: 'user-secret',
        },
      }),
      'corr-12345678',
    );
    expect(rendered.status).toBe(409);
    expect(rendered.body.error.code).toBe('possible_duplicate');
    expect(rendered.body.error.details).toEqual({
      id: '01932a1e-7b4c-7c2a-8e10-222222222222',
      date: '2026-10-28',
      amount: '12.50',
      reference: '  Receipt\nA  ',
      recordedAt: '2026-10-28T10:15:00.000Z',
    });
    expect(JSON.stringify(rendered)).not.toContain('PRIVATE-NOTE-SENTINEL');
    expect(JSON.stringify(rendered)).not.toContain('user-secret');
    const dropped = errorBody(
      new ConflictException({
        code: 'possible_duplicate',
        message: 'possible_duplicate',
        details: { id: 'not-a-uuid', notes: 'PRIVATE-NOTE-SENTINEL' },
      }),
      'corr-12345678',
    );
    expect(dropped.body.error.details).toBeUndefined();
    expect(JSON.stringify(dropped)).not.toContain('PRIVATE-NOTE-SENTINEL');
    const other = errorBody(
      new ConflictException({
        code: 'over_allocation',
        message: 'over_allocation',
        details: { id: '01932a1e-7b4c-7c2a-8e10-222222222222', notes: 'PRIVATE-NOTE-SENTINEL' },
      }),
      'corr-12345678',
    );
    expect(other.body.error.details).toBeUndefined();
    expect(JSON.stringify(other)).not.toContain('PRIVATE-NOTE-SENTINEL');
  });
});
