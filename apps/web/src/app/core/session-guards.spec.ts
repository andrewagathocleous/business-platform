import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { describe, expect, it } from 'vitest';
import { authGuard, canonicalCompanyUrl, companyGuard } from './guards';
import type { CompanySummary, MeUser } from './models';
import type { SessionLoad } from './session.store';
import { SessionStore } from './session.store';

@Component({ selector: 'bp-guard-stub', template: 'Stub' })
class GuardStub {}

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('canonicalCompanyUrl', () => {
  it('lowercases only the company segment', () => {
    expect(canonicalCompanyUrl(`/c/${companyId.toUpperCase()}/orders?page=2#top`, companyId.toUpperCase())).toBe(
      `/c/${companyId}/orders?page=2#top`,
    );
  });
});

describe('auth and company guards', () => {
  it('sends a transient session failure to the unavailable page', async () => {
    configure(session({ load: () => Promise.resolve('error') }));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');
    expect(TestBed.inject(Router).url.startsWith('/unavailable')).toBe(true);
    expect(TestBed.inject(Router).url.includes('/login')).toBe(false);
  });

  it('redirects an uppercase company id to its lowercase form', async () => {
    configure(
      session({
        load: () => Promise.resolve('ready'),
        user: () => user(),
        companies: () => [company()],
      }),
    );
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/c/${companyId.toUpperCase()}/orders?page=2`);
    expect(TestBed.inject(Router).url).toBe(`/c/${companyId}/orders?page=2`);
  });
});

function configure(fake: SessionStore): void {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: SessionStore, useValue: fake },
      provideRouter([
        { path: 'unavailable', component: GuardStub },
        { path: 'login', component: GuardStub },
        { path: 'not-found', component: GuardStub },
        { path: '', component: GuardStub, canActivate: [authGuard] },
        { path: 'c/:companyId/orders', component: GuardStub, canActivate: [companyGuard] },
      ]),
    ],
  });
}

function session(overrides: {
  load?: () => Promise<SessionLoad>;
  user?: () => MeUser | null;
  companies?: () => CompanySummary[];
}): SessionStore {
  const fake = {
    load: () => Promise.resolve('anonymous' as SessionLoad),
    user: () => null as MeUser | null,
    companies: () => [] as CompanySummary[],
    ...overrides,
  };
  return fake as unknown as SessionStore;
}

function user(): MeUser {
  return {
    id: 'user-1',
    email: 'admin.a@example.test',
    displayName: 'Admin A',
    locale: 'en',
    isPlatformOwner: false,
  };
}

function company(): CompanySummary {
  return { id: companyId, legalName: 'Demo', tradingName: 'Nutbox (demo data)', status: 'active' };
}
