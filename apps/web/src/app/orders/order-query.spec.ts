import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';
import { isCanonicalOrderQuery, ordersHttpParams, parseOrderQuery, serializeOrderQuery } from './order-query';

describe('order query', () => {
  it('uses one canonical state for the table and the request', () => {
    const pageSize = convertToParamMap({ page: '2', pageSize: '10' });
    const parsedSize = parseOrderQuery(pageSize);
    expect(parsedSize.page).toBe(2);
    expect(parsedSize.pageSize).toBe(50);
    expect(serializeOrderQuery(parsedSize)).toEqual({ page: '2' });
    expect(isCanonicalOrderQuery(pageSize)).toBe(false);
    expect(ordersHttpParams(parsedSize).get('page')).toBe('2');
    expect(ordersHttpParams(parsedSize).get('pageSize')).toBe('50');
    expect(ordersHttpParams(parsedSize).get('sort')).toBe('-sourceCreatedAt');

    const leadingZero = convertToParamMap({ page: '02' });
    const parsedPage = parseOrderQuery(leadingZero);
    expect(parsedPage.page).toBe(1);
    expect(serializeOrderQuery(parsedPage)).toEqual({});
    expect(isCanonicalOrderQuery(leadingZero)).toBe(false);
    expect(ordersHttpParams(parsedPage).get('page')).toBe('1');

    const unknownSort = convertToParamMap({ sort: '-sourceUpdatedAt' });
    const parsedSort = parseOrderQuery(unknownSort);
    expect(parsedSort.sortField).toBe('sourceCreatedAt');
    expect(parsedSort.sortDirection).toBe('desc');
    expect(serializeOrderQuery(parsedSort)).toEqual({});
    expect(isCanonicalOrderQuery(unknownSort)).toBe(false);
    expect(ordersHttpParams(parsedSort).get('sort')).toBe('-sourceCreatedAt');

    const repeated = convertToParamMap({
      fulfilmentStatus: ['new', 'nope', 'ready'],
      paymentStatus: ['paid', 'later'],
    });
    const parsedRepeated = parseOrderQuery(repeated);
    expect(parsedRepeated.fulfilmentStatus).toEqual(['new', 'ready']);
    expect(parsedRepeated.paymentStatus).toEqual(['paid']);
    expect(serializeOrderQuery(parsedRepeated)).toEqual({
      fulfilmentStatus: ['new', 'ready'],
      paymentStatus: ['paid'],
    });
    expect(ordersHttpParams(parsedRepeated).getAll('fulfilmentStatus')).toEqual(['new', 'ready']);
    expect(ordersHttpParams(parsedRepeated).getAll('paymentStatus')).toEqual(['paid']);
    expect(isCanonicalOrderQuery(convertToParamMap(serializeOrderQuery(parsedRepeated)))).toBe(true);
  });
});
