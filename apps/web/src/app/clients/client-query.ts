import { HttpParams } from '@angular/common/http';
import { ParamMap, Params } from '@angular/router';
import { boundedText, isCanonical } from '../core/url-state';

export type ClientQuery = {
  q: string;
  includeArchived: boolean;
};

export function defaultClientQuery(): ClientQuery {
  return { q: '', includeArchived: false };
}

export function parseClientQuery(params: ParamMap): ClientQuery {
  return {
    q: boundedText(params.get('q'), 200),
    includeArchived: params.get('includeArchived') === 'true',
  };
}

export function serializeClientQuery(query: ClientQuery): Params {
  const params: Params = {};
  if (query.q.length > 0) {
    params['q'] = query.q;
  }
  if (query.includeArchived) {
    params['includeArchived'] = 'true';
  }
  return params;
}

export function isCanonicalClientQuery(params: ParamMap): boolean {
  return isCanonical(params, serializeClientQuery(parseClientQuery(params)));
}

export function invalidClientFilters(params: ParamMap): string[] {
  const invalid: string[] = [];
  const q = params.get('q');
  if (q !== null && q.length > 200) {
    invalid.push('q');
  }
  const archived = params.get('includeArchived');
  if (archived !== null && archived !== 'true' && archived !== 'false') {
    invalid.push('includeArchived');
  }
  return invalid;
}

export function clientsHttpParams(query: ClientQuery): HttpParams {
  let http = new HttpParams();
  if (query.q.length > 0) {
    http = http.set('q', query.q);
  }
  if (query.includeArchived) {
    http = http.set('includeArchived', 'true');
  }
  return http;
}
