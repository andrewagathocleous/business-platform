import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { asOfProblem, exportFileName, periodProblem, reportFailure } from './report-view';

describe('report date validation', () => {
  it.each([
    ['2026-01-01', '2026-01-01'],
    ['2024-01-01', '2024-12-31'],
    ['2025-01-01', '2026-01-01'],
    ['0099-01-01', '0099-01-01'],
  ])('accepts inclusive periods up to 366 days: %s to %s', (from, to) => {
    expect(periodProblem(from, to)).toBeNull();
  });
  it.each([
    ['2024-01-01', '2025-01-01', 'reports.errors.period'],
    ['2026-02-29', '2026-03-01', 'reports.errors.date'],
    ['0000-01-01', '0000-01-01', 'reports.errors.date'],
    ['2026-1-01', '2026-01-02', 'reports.errors.date'],
  ])('refuses %s to %s', (from, to, key) => {
    expect(periodProblem(from, to)).toBe(key);
  });
  it('accepts today and a past asOf but rejects invalid dates and tomorrow', () => {
    expect(asOfProblem('2026-10-29', '2026-10-29')).toBeNull();
    expect(asOfProblem('2026-01-01', '2026-10-29')).toBeNull();
    expect(asOfProblem('2026-10-30', '2026-10-29')).toBe('reports.errors.future');
    expect(asOfProblem('2026-02-30', '2026-10-29')).toBe('reports.errors.date');
  });
  it('maps period and asOf API 422 codes and keeps the correlation id', () => {
    const error = new HttpErrorResponse({
      status: 422,
      error: { error: { code: 'invalid_date', correlationId: 'corr-date' } },
    });
    expect(reportFailure(error)).toEqual({
      key: 'reports.errors.dates',
      correlationId: 'corr-date',
    });
    expect(reportFailure(error, true)).toEqual({
      key: 'reports.errors.asOf',
      correlationId: 'corr-date',
    });
  });
  it('uses a generic message and correlation header for unreadable errors', () => {
    expect(
      reportFailure(
        new HttpErrorResponse({
          status: 502,
          error: 'unreadable',
          headers: new HttpHeaders({ 'X-Correlation-Id': 'corr-header' }),
        }),
      ),
    ).toEqual({ key: 'reports.errors.failed', correlationId: 'corr-header' });
  });
});

describe('export filename', () => {
  it('falls back from malformed encoded names to an ordinary filename', () => {
    expect(
      exportFileName(
        'attachment; filename="fallback.zip"; filename*=UTF-8\'\'%broken',
        '2026-01-01',
        '2026-01-31',
      ),
    ).toBe('fallback.zip');
  });
  it('accepts an unquoted ordinary filename', () => {
    expect(exportFileName('attachment; filename=plain.zip', '2026-01-01', '2026-01-31')).toBe(
      'plain.zip',
    );
  });
});
