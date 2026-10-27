import { HttpParams } from '@angular/common/http';
import { ParamMap, Params } from '@angular/router';
import { FULFILMENT_STATUSES, PAYMENT_STATUSES } from './labels';

export const PAGE_SIZES = [25, 50, 100] as const;
export const SORT_FIELDS = [
  'sourceCreatedAt',
  'externalNumber',
  'total',
  'fulfilmentStatus',
  'paymentStatus',
] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type AssignedFilter = 'any' | 'me' | 'none';
export type SortDirection = 'asc' | 'desc';

export type OrderQuery = {
  q: string;
  fulfilmentStatus: string[];
  paymentStatus: string[];
  storeId: string;
  assigned: AssignedFilter;
  from: string;
  to: string;
  sortField: SortField;
  sortDirection: SortDirection;
  page: number;
  pageSize: number;
};

export function defaultOrderQuery(): OrderQuery {
  return {
    q: '',
    fulfilmentStatus: [],
    paymentStatus: [],
    storeId: '',
    assigned: 'any',
    from: '',
    to: '',
    sortField: 'sourceCreatedAt',
    sortDirection: 'desc',
    page: 1,
    pageSize: 50,
  };
}

export function parseOrderQuery(params: ParamMap): OrderQuery {
  const sort = parseSort(params.get('sort'));
  return {
    q: params.get('q') ?? '',
    fulfilmentStatus: params.getAll('fulfilmentStatus').filter((status) => includes(FULFILMENT_STATUSES, status)),
    paymentStatus: params.getAll('paymentStatus').filter((status) => includes(PAYMENT_STATUSES, status)),
    storeId: params.get('storeId') ?? '',
    assigned: assigned(params.get('assigned')),
    from: dateParam(params.get('from')),
    to: dateParam(params.get('to')),
    sortField: sort.field,
    sortDirection: sort.direction,
    page: positiveInt(params.get('page'), 1),
    pageSize: pageSize(params.get('pageSize')),
  };
}

/** HTTP params for one already-canonical query. The table state uses the same object. */
export function ordersHttpParams(query: OrderQuery): HttpParams {
  let http = new HttpParams();
  if (query.q.length > 0) {
    http = http.set('q', query.q);
  }
  for (const status of query.fulfilmentStatus) {
    http = http.append('fulfilmentStatus', status);
  }
  for (const status of query.paymentStatus) {
    http = http.append('paymentStatus', status);
  }
  if (query.storeId.length > 0) {
    http = http.set('storeId', query.storeId);
  }
  http = http.set('assigned', query.assigned);
  if (query.from.length > 0) {
    http = http.set('from', query.from);
  }
  if (query.to.length > 0) {
    http = http.set('to', query.to);
  }
  const sort = query.sortDirection === 'desc' ? `-${query.sortField}` : query.sortField;
  http = http.set('sort', sort);
  http = http.set('page', String(query.page));
  http = http.set('pageSize', String(query.pageSize));
  return http;
}

/** True when the URL already equals `serializeOrderQuery(parseOrderQuery(params))`. */
export function isCanonicalOrderQuery(params: ParamMap): boolean {
  const canonical = serializeOrderQuery(parseOrderQuery(params));
  const keys = new Set<string>([...params.keys, ...Object.keys(canonical)]);
  for (const key of keys) {
    const actual = params.getAll(key);
    const expected = paramValues(canonical[key]);
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      return false;
    }
  }
  return true;
}

export function serializeOrderQuery(query: OrderQuery): Params {
  const params: Params = {};
  if (query.q.length > 0) {
    params['q'] = query.q;
  }
  if (query.fulfilmentStatus.length > 0) {
    params['fulfilmentStatus'] = query.fulfilmentStatus;
  }
  if (query.paymentStatus.length > 0) {
    params['paymentStatus'] = query.paymentStatus;
  }
  if (query.storeId.length > 0) {
    params['storeId'] = query.storeId;
  }
  if (query.assigned !== 'any') {
    params['assigned'] = query.assigned;
  }
  if (query.from.length > 0) {
    params['from'] = query.from;
  }
  if (query.to.length > 0) {
    params['to'] = query.to;
  }
  const sort = query.sortDirection === 'desc' ? `-${query.sortField}` : query.sortField;
  if (sort !== '-sourceCreatedAt') {
    params['sort'] = sort;
  }
  if (query.page !== 1) {
    params['page'] = String(query.page);
  }
  if (query.pageSize !== 50) {
    params['pageSize'] = String(query.pageSize);
  }
  return params;
}

export function isSortField(value: unknown): value is SortField {
  return typeof value === 'string' && includes(SORT_FIELDS, value);
}

function parseSort(value: string | null): { field: SortField; direction: SortDirection } {
  if (!value) {
    return { field: 'sourceCreatedAt', direction: 'desc' };
  }
  const direction: SortDirection = value.startsWith('-') ? 'desc' : 'asc';
  const field = value.startsWith('-') ? value.slice(1) : value;
  if (!isSortField(field)) {
    return { field: 'sourceCreatedAt', direction: 'desc' };
  }
  return { field, direction };
}

function assigned(value: string | null): AssignedFilter {
  if (value === 'me' || value === 'none' || value === 'any') {
    return value;
  }
  return 'any';
}

function dateParam(value: string | null): string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function pageSize(value: string | null): number {
  const parsed = positiveInt(value, 50);
  return parsed === 25 || parsed === 50 || parsed === 100 ? parsed : 50;
}

function positiveInt(value: string | null, fallback: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    return fallback;
  }
  let result = 0;
  for (const char of value) {
    result = result * 10 + (char.charCodeAt(0) - 48);
  }
  return result > 0 ? result : fallback;
}

function includes(values: readonly string[], value: string): boolean {
  return values.some((item) => item === value);
}

function paramValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return [];
}
