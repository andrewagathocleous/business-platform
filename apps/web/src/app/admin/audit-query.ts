import { HttpParams } from '@angular/common/http';
import { ParamMap, Params } from '@angular/router';
import { companyDayEndExclusive, companyDayStart } from '../format/company-date';
import { dateParam, isCanonical, isRealCalendarDate, nonNegativeInt, uuidParam } from '../core/url-state';

const OUTCOMES = ['success', 'denied', 'failure'] as const;
export type AuditOutcome = (typeof OUTCOMES)[number];

export type AuditQuery = {
  action: string;
  objectType: string;
  objectId: string;
  actorId: string;
  outcome: '' | AuditOutcome;
  from: string;
  to: string;
  offset: number;
};

export const AUDIT_PAGE_SIZE = 50;

export function defaultAuditQuery(): AuditQuery {
  return { action: '', objectType: '', objectId: '', actorId: '', outcome: '', from: '', to: '', offset: 0 };
}

export function parseAuditQuery(params: ParamMap): AuditQuery {
  return {
    action: textParam(params.get('action')),
    objectType: textParam(params.get('objectType')),
    objectId: uuidParam(params.get('objectId')),
    actorId: uuidParam(params.get('actor')),
    outcome: outcomeParam(params.get('outcome')),
    from: dateParam(params.get('from')),
    to: dateParam(params.get('to')),
    offset: nonNegativeInt(params.get('offset'), 0, 10_000),
  };
}

export function serializeAuditQuery(query: AuditQuery): Params {
  const params: Params = {};
  if (query.action.length > 0) {
    params['action'] = query.action;
  }
  if (query.objectType.length > 0) {
    params['objectType'] = query.objectType;
  }
  if (query.objectId.length > 0) {
    params['objectId'] = query.objectId;
  }
  if (query.actorId.length > 0) {
    params['actor'] = query.actorId;
  }
  if (query.outcome.length > 0) {
    params['outcome'] = query.outcome;
  }
  if (query.from.length > 0) {
    params['from'] = query.from;
  }
  if (query.to.length > 0) {
    params['to'] = query.to;
  }
  if (query.offset > 0) {
    params['offset'] = String(query.offset);
  }
  return params;
}

export function isCanonicalAuditQuery(params: ParamMap): boolean {
  return isCanonical(params, serializeAuditQuery(parseAuditQuery(params)));
}

export function invalidAuditFilters(params: ParamMap): string[] {
  const invalid: string[] = [];
  if (overlong(params.get('action'))) {
    invalid.push('action');
  }
  if (overlong(params.get('objectType'))) {
    invalid.push('objectType');
  }
  const objectId = params.get('objectId');
  if (objectId !== null && objectId.length > 0 && uuidParam(objectId) === '') {
    invalid.push('objectId');
  }
  const actor = params.get('actor');
  if (actor !== null && actor.length > 0 && uuidParam(actor) === '') {
    invalid.push('actor');
  }
  const outcome = params.get('outcome');
  if (outcome !== null && outcome.length > 0 && outcomeParam(outcome) === '') {
    invalid.push('outcome');
  }
  if (invalidDate(params.get('from'))) {
    invalid.push('from');
  }
  if (invalidDate(params.get('to'))) {
    invalid.push('to');
  }
  return invalid;
}

export function auditHttpParams(query: AuditQuery, timeZone = 'Asia/Nicosia'): HttpParams {
  let http = new HttpParams().set('limit', String(AUDIT_PAGE_SIZE)).set('offset', String(query.offset));
  if (query.action.length > 0) {
    http = http.set('action', query.action);
  }
  if (query.objectType.length > 0) {
    http = http.set('objectType', query.objectType);
  }
  if (query.objectId.length > 0) {
    http = http.set('objectId', query.objectId);
  }
  if (query.actorId.length > 0) {
    http = http.set('actorId', query.actorId);
  }
  if (query.outcome.length > 0) {
    http = http.set('outcome', query.outcome);
  }
  if (query.from.length > 0) {
    http = http.set('from', companyDayStart(query.from, timeZone).toISOString());
  }
  if (query.to.length > 0) {
    http = http.set('to', companyDayEndExclusive(query.to, timeZone).toISOString());
  }
  return http;
}

function textParam(value: string | null): string {
  if (value === null || value.length === 0 || value.length > 200) {
    return '';
  }
  return value;
}

function overlong(value: string | null): boolean {
  return value !== null && value.length > 200;
}

function invalidDate(value: string | null): boolean {
  return value !== null && value.length > 0 && !isRealCalendarDate(value);
}

function outcomeParam(value: string | null): '' | AuditOutcome {
  for (const outcome of OUTCOMES) {
    if (value === outcome) {
      return outcome;
    }
  }
  return '';
}
