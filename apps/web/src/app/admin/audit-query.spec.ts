import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { auditHttpParams, defaultAuditQuery, parseAuditQuery } from './audit-query';

describe('auditHttpParams', () => {
  it('converts a winter day in Asia/Nicosia to an exclusive next-day bound', () => {
    const params = auditHttpParams({ ...defaultAuditQuery(), from: '2026-01-15', to: '2026-01-15' }, 'Asia/Nicosia');
    expect(params.get('from')).toBe('2026-01-14T22:00:00.000Z');
    expect(params.get('to')).toBe('2026-01-15T22:00:00.000Z');
  });
});

describe('parseAuditQuery', () => {
  it('drops an impossible end date and keeps the action filter', () => {
    const params = convertToParamMap({ action: 'client.updated', to: '2026-13-01' });
    const parsed = parseAuditQuery(params);
    expect(parsed.action).toBe('client.updated');
    expect(parsed.to).toBe('');
    expect(auditHttpParams(parsed).get('action')).toBe('client.updated');
    expect(auditHttpParams(parsed).get('to')).toBeNull();
  });

  it('drops a filter longer than the API allows and keeps the valid one', () => {
    const params = convertToParamMap({ action: 'a'.repeat(201), objectType: 'client' });
    const parsed = parseAuditQuery(params);
    expect(parsed.action).toBe('');
    expect(parsed.objectType).toBe('client');
    expect(auditHttpParams(parsed).get('action')).toBeNull();
    expect(auditHttpParams(parsed).get('objectType')).toBe('client');
  });
});
