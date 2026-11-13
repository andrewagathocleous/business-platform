import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import {
  clientsHttpParams,
  invalidClientFilters,
  isCanonicalClientQuery,
  parseClientQuery,
  serializeClientQuery,
} from './client-query';

describe('parseClientQuery', () => {
  it('drops an over-long search and keeps includeArchived', () => {
    const params = convertToParamMap({ q: 'a'.repeat(201), includeArchived: 'true' });
    const parsed = parseClientQuery(params);
    expect(parsed.q).toBe('');
    expect(parsed.includeArchived).toBe(true);
    expect(clientsHttpParams(parsed).get('q')).toBeNull();
    expect(clientsHttpParams(parsed).get('includeArchived')).toBe('true');
  });

  it('keeps the import id beside filters in the URL but never sends it to the list API', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const params = convertToParamMap({ q: 'Demo', includeArchived: 'true', importId: id });
    const query = parseClientQuery(params);
    expect(query.importId).toBe(id);
    expect(serializeClientQuery(query)).toEqual({
      q: 'Demo',
      includeArchived: 'true',
      importId: id,
    });
    expect(isCanonicalClientQuery(params)).toBe(true);
    expect(clientsHttpParams(query).has('importId')).toBe(false);
    expect(invalidClientFilters(convertToParamMap({ importId: 'bad/id' }))).toContain('importId');
    expect(parseClientQuery(convertToParamMap({ importId: 'bad/id' })).importId).toBe('');
  });
});
