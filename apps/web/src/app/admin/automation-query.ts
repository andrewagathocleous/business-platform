import { HttpParams } from '@angular/common/http';
import { ParamMap, Params } from '@angular/router';
import { isCanonical, positiveInt } from '../core/url-state';

const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'held', 'uncertain', 'cancelled'] as const;
const PRINT_STATUSES = [
  'queued',
  'held',
  'submitting',
  'submitted',
  'delivered_to_printer',
  'done_reported',
  'confirmed_printed',
  'not_printed',
  'failed',
  'uncertain',
  'cancelled',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type PrintStatus = (typeof PRINT_STATUSES)[number];

export type AutomationQuery = {
  jobStatus: '' | JobStatus;
  jobPage: number;
  printStatus: '' | PrintStatus;
  printPage: number;
};

export const AUTOMATION_PAGE_SIZE = 20;
export const AUTOMATION_PAGE_MAX = 1_000_000;

export function defaultAutomationQuery(): AutomationQuery {
  return { jobStatus: '', jobPage: 1, printStatus: '', printPage: 1 };
}

export function parseAutomationQuery(params: ParamMap): AutomationQuery {
  return {
    jobStatus: oneStatus(params.get('jobStatus'), JOB_STATUSES),
    jobPage: positiveInt(params.get('jobPage'), 1, AUTOMATION_PAGE_MAX),
    printStatus: oneStatus(params.get('printStatus'), PRINT_STATUSES),
    printPage: positiveInt(params.get('printPage'), 1, AUTOMATION_PAGE_MAX),
  };
}

export function serializeAutomationQuery(query: AutomationQuery): Params {
  const params: Params = {};
  if (query.jobStatus.length > 0) {
    params['jobStatus'] = query.jobStatus;
  }
  if (query.jobPage > 1) {
    params['jobPage'] = String(query.jobPage);
  }
  if (query.printStatus.length > 0) {
    params['printStatus'] = query.printStatus;
  }
  if (query.printPage > 1) {
    params['printPage'] = String(query.printPage);
  }
  return params;
}

export function isCanonicalAutomationQuery(params: ParamMap): boolean {
  return isCanonical(params, serializeAutomationQuery(parseAutomationQuery(params)));
}

export function jobsHttpParams(query: AutomationQuery): HttpParams {
  let http = new HttpParams().set('page', String(query.jobPage)).set('pageSize', String(AUTOMATION_PAGE_SIZE));
  if (query.jobStatus.length > 0) {
    http = http.set('status', query.jobStatus);
  }
  return http;
}

export function printJobsHttpParams(query: AutomationQuery): HttpParams {
  let http = new HttpParams().set('page', String(query.printPage)).set('pageSize', String(AUTOMATION_PAGE_SIZE));
  if (query.printStatus.length > 0) {
    http = http.set('status', query.printStatus);
  }
  return http;
}

function oneStatus<T extends string>(value: string | null, allowed: readonly T[]): '' | T {
  if (value === null) {
    return '';
  }
  for (const status of allowed) {
    if (status === value) {
      return status;
    }
  }
  return '';
}
