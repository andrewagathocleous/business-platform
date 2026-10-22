import { HttpParams } from '@angular/common/http';
import { ParamMap, Params } from '@angular/router';
import { boundedText, dateParam, isCanonical, isRealCalendarDate, uuidParam } from '../core/url-state';

const STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type InvoiceStatusFilter = '' | (typeof STATUSES)[number];

function invoiceStatus(value: string | null): InvoiceStatusFilter {
  for (const status of STATUSES) {
    if (value === status) {
      return status;
    }
  }
  return '';
}

export type InvoiceQuery = {
  q: string;
  status: InvoiceStatusFilter;
  clientId: string;
  from: string;
  to: string;
};

export function defaultInvoiceQuery(): InvoiceQuery {
  return { q: '', status: '', clientId: '', from: '', to: '' };
}

export function parseInvoiceQuery(params: ParamMap): InvoiceQuery {
  return {
    q: boundedText(params.get('q'), 200),
    status: invoiceStatus(params.get('status')),
    clientId: uuidParam(params.get('clientId')),
    from: dateParam(params.get('from')),
    to: dateParam(params.get('to')),
  };
}

export function serializeInvoiceQuery(query: InvoiceQuery): Params {
  const params: Params = {};
  if (query.q.length > 0) {
    params['q'] = query.q;
  }
  if (query.status.length > 0) {
    params['status'] = query.status;
  }
  if (query.clientId.length > 0) {
    params['clientId'] = query.clientId;
  }
  if (query.from.length > 0) {
    params['from'] = query.from;
  }
  if (query.to.length > 0) {
    params['to'] = query.to;
  }
  return params;
}

export function isCanonicalInvoiceQuery(params: ParamMap): boolean {
  return isCanonical(params, serializeInvoiceQuery(parseInvoiceQuery(params)));
}

export function invalidInvoiceFilters(params: ParamMap): string[] {
  const invalid: string[] = [];
  const q = params.get('q');
  if (q !== null && q.length > 200) {
    invalid.push('q');
  }
  const status = params.get('status');
  if (status !== null && status.length > 0 && invoiceStatus(status) === '') {
    invalid.push('status');
  }
  const clientId = params.get('clientId');
  if (clientId !== null && clientId.length > 0 && uuidParam(clientId) === '') {
    invalid.push('clientId');
  }
  if (invalidDate(params.get('from'))) {
    invalid.push('from');
  }
  if (invalidDate(params.get('to'))) {
    invalid.push('to');
  }
  return invalid;
}

function invalidDate(value: string | null): boolean {
  return value !== null && value.length > 0 && !isRealCalendarDate(value);
}

export function invoicesHttpParams(query: InvoiceQuery): HttpParams {
  let http = new HttpParams();
  if (query.q.length > 0) {
    http = http.set('q', query.q);
  }
  if (query.status.length > 0) {
    http = http.set('status', query.status);
  }
  if (query.clientId.length > 0) {
    http = http.set('clientId', query.clientId);
  }
  if (query.from.length > 0) {
    http = http.set('from', query.from);
  }
  if (query.to.length > 0) {
    http = http.set('to', query.to);
  }
  return http;
}

/** Calendar dates stay on the day that was stored. They are not instants. */
export function calendarDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return '';
  }
  const year = value.slice(0, 4);
  const month = value.slice(5, 7);
  const day = value.slice(8, 10);
  return `${day}/${month}/${year}`;
}
