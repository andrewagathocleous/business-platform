import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { isVersionConflict } from './api-error';

describe('isVersionConflict', () => {
  it('recognises both wordings of a stale version, and nothing else', () => {
    const conflict = (code: string, message: string) =>
      new HttpErrorResponse({
        status: 409,
        error: { error: { code, message, correlationId: 'corr-1' } },
      });
    expect(isVersionConflict(conflict('conflict', 'version conflict'))).toBe(true);
    expect(isVersionConflict(conflict('conflict', 'version_conflict'))).toBe(true);
    expect(isVersionConflict(conflict('version_conflict', 'stale'))).toBe(true);
    expect(isVersionConflict(conflict('over_credit', 'too much'))).toBe(false);
    expect(
      isVersionConflict(
        new HttpErrorResponse({
          status: 400,
          error: { error: { code: 'bad_request', message: 'version conflict' } },
        }),
      ),
    ).toBe(false);
  });
});
