import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { clientsHttpParams, parseClientQuery } from './client-query';

describe('parseClientQuery', () => {
  it('drops an over-long search and keeps includeArchived', () => {
    const params = convertToParamMap({ q: 'a'.repeat(201), includeArchived: 'true' });
    const parsed = parseClientQuery(params);
    expect(parsed.q).toBe('');
    expect(parsed.includeArchived).toBe(true);
    expect(clientsHttpParams(parsed).get('q')).toBeNull();
    expect(clientsHttpParams(parsed).get('includeArchived')).toBe('true');
  });
});
