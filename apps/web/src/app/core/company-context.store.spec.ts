import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { CompanyContext, Grant } from './models';
import { CompanyContextStore } from './company-context.store';
import { NAVIGATE_ON_DENIED } from './navigate-on-denied';

const companyX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const companyY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const companyZ = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('CompanyContextStore', () => {
  it('drops the previous user grants on reset and ignores that user late response', async () => {
    const { store, http } = setup();
    const first = store.load(companyX);
    const opened = http.expectOne(`/api/c/${companyX}/context`);
    expect(opened.request.context.get(NAVIGATE_ON_DENIED)).toBe(true);
    opened.flush(context(companyX, 'order.view'));
    await first;
    expect(permissions(store.grants())).toEqual(['order.view']);

    store.reset();
    expect(store.grants()).toEqual([]);
    const next = store.load(companyX);
    http.expectOne(`/api/c/${companyX}/context`).flush(context(companyX, 'invoice.view'));
    await next;
    expect(permissions(store.grants())).toEqual(['invoice.view']);

    store.reset();
    const late = store.load(companyX);
    store.reset();
    const current = store.load(companyX);
    const requests = http.match(`/api/c/${companyX}/context`);
    expect(requests).toHaveLength(2);
    const latest = requests[1];
    const stale = requests[0];
    if (!latest || !stale) {
      throw new Error('expected two context requests');
    }
    latest.flush(context(companyX, 'client.view'));
    await current;
    stale.flush(context(companyX, 'order.view'));
    await late;
    expect(permissions(store.grants())).toEqual(['client.view']);
    http.verify();
  });

  it('keeps the latest company when an older response or error arrives afterwards', async () => {
    const { store, http } = setup();
    const loadA = store.load(companyX);
    const requestA = http.expectOne(`/api/c/${companyX}/context`);
    const loadB = store.load(companyY);
    const requestB = http.expectOne(`/api/c/${companyY}/context`);
    requestB.flush(context(companyY, 'client.view'));
    await loadB;
    requestA.flush(context(companyX, 'order.view'));
    await loadA;
    expect(store.companyId()).toBe(companyY);
    expect(permissions(store.grants())).toEqual(['client.view']);

    const stale = store.load(companyX);
    const staleRequest = http.expectOne(`/api/c/${companyX}/context`);
    const latest = store.load(companyZ);
    const latestRequest = http.expectOne(`/api/c/${companyZ}/context`);
    latestRequest.flush(context(companyZ, 'audit.view'));
    await latest;
    staleRequest.flush('nope', { status: 500, statusText: 'Server error' });
    await expect(stale).resolves.toBe('superseded');
    expect(store.companyId()).toBe(companyZ);
    expect(permissions(store.grants())).toEqual(['audit.view']);
    http.verify();
  });

  it('does not let a save reload replace a company switch', async () => {
    const { store, http } = setup();
    const loadA = store.load(companyX);
    http.expectOne(`/api/c/${companyX}/context`).flush(context(companyX, 'invoice.view', 'EUR'));
    await loadA;

    const loadB = store.load(companyY);
    const requestB = http.expectOne(`/api/c/${companyY}/context`);
    const reload = store.reload(companyX);
    expect(http.match(`/api/c/${companyX}/context`)).toEqual([]);
    await expect(reload).resolves.toBe('superseded');

    requestB.flush(context(companyY, 'order.view', 'USD', 'Europe/Athens'));
    await expect(loadB).resolves.toBe('ok');
    expect(store.companyId()).toBe(companyY);
    expect(store.currency()).toBe('USD');
    expect(store.timezone()).toBe('Europe/Athens');
    expect(permissions(store.grants())).toEqual(['order.view']);
    http.verify();
  });

  it('drops a reload response that arrives after the target company changes', async () => {
    const { store, http } = setup();
    const loadA = store.load(companyX);
    http
      .expectOne(`/api/c/${companyX}/context`)
      .flush(context(companyX, 'invoice.view', 'EUR', 'Asia/Nicosia'));
    await loadA;

    const reload = store.reload(companyX);
    const reloadRequest = http.expectOne(`/api/c/${companyX}/context`);
    const loadB = store.load(companyY);
    const requestB = http.expectOne(`/api/c/${companyY}/context`);
    reloadRequest.flush(context(companyX, 'invoice.view', 'GBP', 'Europe/London'));
    await expect(reload).resolves.toBe('superseded');
    expect(store.currency()).toBe('EUR');
    expect(permissions(store.grants())).toEqual(['invoice.view']);

    requestB.flush(context(companyY, 'order.view', 'USD', 'Europe/Athens'));
    await expect(loadB).resolves.toBe('ok');
    expect(store.companyId()).toBe(companyY);
    expect(store.currency()).toBe('USD');
    expect(store.timezone()).toBe('Europe/Athens');
    expect(permissions(store.grants())).toEqual(['order.view']);
    http.verify();
  });
});

function setup(): { store: CompanyContextStore; http: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    store: TestBed.inject(CompanyContextStore),
    http: TestBed.inject(HttpTestingController),
  };
}

function context(
  id: string,
  permission: string,
  currency = 'EUR',
  timezone = 'Asia/Nicosia',
): CompanyContext {
  return {
    company: {
      id,
      legalName: 'Legal',
      tradingName: 'Trade',
      status: 'active',
      timezone,
      defaultCurrency: currency,
      countryCode: 'CY',
      documentLanguage: 'en',
    },
    grants: [{ permission, scopeType: 'company', scopeId: null }],
    switches: [],
    mfaStepUpRequired: false,
    withheldPermissions: [],
  };
}

function permissions(grants: readonly Grant[]): string[] {
  return grants.map((grant) => grant.permission);
}
