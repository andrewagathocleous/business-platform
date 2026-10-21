import { BadRequestException } from '@nestjs/common';
import { FULFILMENT_STATUSES, PAYMENT_STATUSES, type FulfilmentStatus, type PaymentStatus } from '@bp/domain';
import type { Request } from 'express';
import { isUuid } from '../authz/company-path';
import { isSupportedBusinessDate } from './business-time';

const SORT_FIELDS = [
  'sourceCreatedAt',
  'sourceUpdatedAt',
  'externalNumber',
  'createdAt',
  'fulfilmentStatus',
  'paymentStatus',
  'total',
] as const;

export type OrderSortField = (typeof SORT_FIELDS)[number];

export type OrderListQuery = {
  q?: string;
  fulfilmentStatus: FulfilmentStatus[];
  paymentStatus: PaymentStatus[];
  storeId?: string;
  assigned: 'me' | 'none' | 'any';
  from?: string;
  to?: string;
  sortField: OrderSortField;
  sortDirection: 'asc' | 'desc';
  page: number;
  pageSize: number;
};

export function parseOrderListQuery(query: Request['query']): OrderListQuery {
  const q = optionalString(query['q'], 'q');
  if (q !== undefined && q.length > 200) {
    throw new BadRequestException('q is too long');
  }
  const storeId = optionalString(query['storeId'], 'storeId');
  if (storeId !== undefined && !isUuid(storeId)) {
    throw new BadRequestException('storeId must be a uuid');
  }
  const assigned = optionalString(query['assigned'], 'assigned') ?? 'any';
  if (assigned !== 'me' && assigned !== 'none' && assigned !== 'any') {
    throw new BadRequestException('assigned must be me, none or any');
  }
  const from = optionalDate(query['from'], 'from');
  const to = optionalDate(query['to'], 'to');
  const sort = optionalString(query['sort'], 'sort') ?? '-sourceCreatedAt';
  const parsedSort = parseSort(sort);
  return {
    ...(q !== undefined && q.length > 0 ? { q } : {}),
    fulfilmentStatus: enumList(query, 'fulfilmentStatus', FULFILMENT_STATUSES),
    paymentStatus: enumList(query, 'paymentStatus', PAYMENT_STATUSES),
    ...(storeId ? { storeId: storeId.toLowerCase() } : {}),
    assigned,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sortField: parsedSort.field,
    sortDirection: parsedSort.direction,
    page: integer(query['page'], 'page', 1, 1_000_000, 1),
    pageSize: integer(query['pageSize'], 'pageSize', 1, 100, 50),
  };
}

function parseSort(sort: string): { field: OrderSortField; direction: 'asc' | 'desc' } {
  const direction = sort.startsWith('-') ? 'desc' : 'asc';
  const field = sort.startsWith('-') ? sort.slice(1) : sort;
  if (!isSortField(field)) {
    throw new BadRequestException('sort is not supported');
  }
  return { field, direction };
}

function isSortField(value: string): value is OrderSortField {
  return (SORT_FIELDS as readonly string[]).includes(value);
}

function enumList<T extends string>(query: Request['query'], key: string, allowed: readonly T[]): T[] {
  const items = [...readList(query[key]), ...readList(query[`${key}[]`])];
  return items.map((item) => {
    if (!allowed.includes(item as T)) {
      throw new BadRequestException(`${key} is invalid`);
    }
    return item as T;
  });
}

function optionalDate(value: unknown, field: string): string | undefined {
  const text = optionalString(value, field);
  if (text === undefined) {
    return undefined;
  }
  if (!isSupportedBusinessDate(text)) {
    throw new BadRequestException(`${field} must be YYYY-MM-DD from 2000-01-01 to 2999-12-31`);
  }
  return text;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return value;
}

function integer(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new BadRequestException(`${field} must be an integer`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new BadRequestException(`${field} is out of range`);
  }
  return parsed;
}

function readList(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  throw new BadRequestException('query value must be a string');
}
