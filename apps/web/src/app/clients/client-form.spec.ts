import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { emptyClientDraft } from './client-draft';
import { ClientFormPage } from './client-form';

describe('ClientFormPage', () => {
  it('keeps one primary contact and one default address per kind', async () => {
    const { fixture } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.addContact();
    component.addContact();
    component.setContact(0, 'name', inputEvent('Ada'));
    component.setContact(1, 'name', inputEvent('Nia'));
    component.onPrimary(0, checkEvent(true));
    component.onPrimary(1, checkEvent(true));
    component.addAddress();
    component.addAddress();
    component.setAddress(0, 'line1', inputEvent('1 Demo Street'));
    component.setAddress(0, 'city', inputEvent('Nicosia'));
    component.setAddress(0, 'countryCode', inputEvent('CY'));
    component.setAddress(1, 'line1', inputEvent('2 Demo Street'));
    component.setAddress(1, 'city', inputEvent('Nicosia'));
    component.setAddress(1, 'countryCode', inputEvent('CY'));
    component.onDefault(0, checkEvent(true));
    component.onDefault(1, checkEvent(true));
    fixture.detectChanges();

    const draft = component.draft();
    expect(draft.contacts.map((contact) => contact.isPrimary)).toEqual([false, true]);
    expect(draft.addresses.map((address) => address.isDefault)).toEqual([false, true]);
    expect(textOf(fixture)).toContain('Contacts');
    expect(textOf(fixture)).toContain('Addresses');

    component.setAddressKind(0, inputEvent('shipping'));
    component.onDefault(0, checkEvent(true));
    expect(component.draft().addresses.map((address) => [address.kind, address.isDefault])).toEqual(
      [
        ['shipping', true],
        ['billing', true],
      ],
    );
  });

  it('shows the duplicate dialog and keeps the form when the user goes back', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.setText('displayName', inputEvent('Acme Demo'));
    component.setText('email', inputEvent('acme@example.test'));
    fixture.detectChanges();
    component.save();
    const check = http.expectOne('/api/c/company-1/clients/duplicate-check');
    expect(check.request.body).toEqual({ displayName: 'Acme Demo', email: 'acme@example.test' });
    check.flush({
      matches: [{ id: 'client-2', displayName: 'Acme Older', archivedAt: null }],
    });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Possible duplicate — save anyway?');
    expect(textOf(fixture)).toContain('Acme Older');
    button(fixture, 'Back').click();
    fixture.detectChanges();
    expect(textOf(fixture)).not.toContain('Possible duplicate — save anyway?');
    expect(component.draft().displayName).toBe('Acme Demo');
    expect(component.draft().email).toBe('acme@example.test');
    http.verify();
  });

  it('keeps a note typed while save is in flight', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', 'client-1');
    http.expectOne('/api/c/company-1/clients/client-1').flush({ client: clientView() });
    component.setText('notes', inputEvent('before save'));
    component.save();
    const patch = http.expectOne('/api/c/company-1/clients/client-1');
    expect(patch.request.method).toBe('PATCH');
    const sent: unknown = patch.request.body;
    if (!isRecord(sent)) {
      throw new Error('patch body is missing');
    }
    expect(sent['notes']).toBe('before save');
    component.setText('notes', inputEvent('during save'));
    patch.flush({ client: clientView({ notes: 'before save', version: 4 }) });
    expect(component.draft().notes).toBe('during save');
    http.verify();
  });

  it('sends whether the client accepts electronic invoices', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', 'client-1');
    http.expectOne('/api/c/company-1/clients/client-1').flush({ client: clientView() });
    expect(component.draft().acceptsEInvoices).toBe(false);
    component.onAcceptsEInvoices(checkEvent(true));
    component.save();
    const patch = http.expectOne('/api/c/company-1/clients/client-1');
    const sent: unknown = patch.request.body;
    if (!isRecord(sent)) {
      throw new Error('patch body is missing');
    }
    expect(sent['acceptsEInvoices']).toBe(true);
    patch.flush({ client: clientView({ acceptsEInvoices: true, version: 4 }) });
    expect(component.draft().acceptsEInvoices).toBe(true);
    http.verify();
  });

  it('keeps unsaved notes when archive completes', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', 'client-1');
    http.expectOne('/api/c/company-1/clients/client-1').flush({ client: clientView() });
    component.setText('notes', inputEvent('keep this note'));
    component.archive(true);
    const patch = http.expectOne('/api/c/company-1/clients/client-1');
    expect(patch.request.body).toEqual({ expectedVersion: 3, archived: true });
    patch.flush({
      client: clientView({
        notes: 'server note',
        archivedAt: '2026-10-22T00:00:00.000Z',
        version: 4,
      }),
    });
    expect(component.draft().notes).toBe('keep this note');
    expect(component.archivedAt()).toBe('2026-10-22T00:00:00.000Z');
    http.verify();
  });

  it('carries a note typed during create into the detail route', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http } = await setup(['client.manage'], { navigate });
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.setText('displayName', inputEvent('Acme Demo'));
    component.setText('notes', inputEvent('typed before save'));
    component.save();
    const check = http.expectOne('/api/c/company-1/clients/duplicate-check');
    check.flush({ matches: [] });
    const post = http.expectOne('/api/c/company-1/clients');
    expect(post.request.method).toBe('POST');
    const sent: unknown = post.request.body;
    if (!isRecord(sent)) {
      throw new Error('create body is missing');
    }
    expect(sent['notes']).toBe('typed before save');
    component.setText('notes', inputEvent('typed after save'));
    post.flush({ client: clientView({ id: 'client-9', notes: 'typed before save', version: 1 }) });
    const [commands, extras] = navigateCall(navigate);
    expect(commands).toEqual(['/c', 'company-1', 'clients', 'client-9']);
    if (
      !isRecord(extras) ||
      !isRecord(extras['state']) ||
      !isRecord(extras['state']['carriedClient'])
    ) {
      throw new Error('create did not carry the client draft');
    }
    const carried = extras['state']['carriedClient'];
    expect(carried['id']).toBe('client-9');
    expect(carried['version']).toBe(1);
    if (!isRecord(carried['draft'])) {
      throw new Error('carried draft is missing');
    }
    expect(carried['draft']['notes']).toBe('typed after save');
    http.verify();
  });

  it.each(['client-9', 'CLIENT-9'])(
    'keeps a carried create draft instead of the stored client at route %s',
    async (routeId) => {
      const draft = { ...emptyClientDraft(), displayName: 'Acme Demo', notes: 'typed after save' };
      const baseline = {
        ...emptyClientDraft(),
        displayName: 'Acme Demo',
        notes: 'typed before save',
      };
      const carriedClient = { id: 'client-9', version: 1, archivedAt: null, draft, baseline };
      const { fixture, http } = await setup(['client.manage'], {
        getCurrentNavigation: () => ({ extras: { state: { carriedClient } } }),
      });
      const component = fixture.componentInstance;
      component.open('company-1', routeId);
      const loaded = http.match((request) => request.url === `/api/c/company-1/clients/${routeId}`);
      for (const request of loaded) {
        request.flush({ client: clientView({ id: 'client-9', notes: 'server copy', version: 7 }) });
      }
      expect(component.draft().notes).toBe('typed after save');
      component.save();
      const checks = http.match((request) => request.url.includes('duplicate-check'));
      for (const request of checks) {
        request.flush({ matches: [] });
      }
      const patch = http.expectOne(`/api/c/company-1/clients/${routeId}`);
      expect(patch.request.method).toBe('PATCH');
      expect(patch.request.body).toMatchObject({ expectedVersion: 1, notes: 'typed after save' });
      patch.flush({
        client: clientView({ id: 'client-9', notes: 'typed after save', version: 2 }),
      });
      http.verify();
    },
  );

  it('does not save a duplicate VAT when the kind changes back to organisation during the check', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.setText('displayName', inputEvent('Acme Demo'));
    component.setText('vatNumber', inputEvent('CY99999999X'));
    component.setKind(inputEvent('individual'));
    component.save();
    const check = http.expectOne('/api/c/company-1/clients/duplicate-check');
    expect(check.request.body).toEqual({ displayName: 'Acme Demo' });
    component.setKind(inputEvent('organisation'));
    check.flush({ matches: [] });
    const created = http.match(
      (request) => request.method === 'POST' && request.url === '/api/c/company-1/clients',
    );
    expect(created).toHaveLength(0);
    const again = http.expectOne('/api/c/company-1/clients/duplicate-check');
    expect(again.request.body).toEqual({ displayName: 'Acme Demo', vatNumber: 'CY99999999X' });
    again.flush({ matches: [{ id: 'client-9', displayName: 'Acme Older', archivedAt: null }] });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Possible duplicate — save anyway?');
    http.verify();
  });

  it('does not save a changed email on a stale duplicate check', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.setText('displayName', inputEvent('Unique Demo'));
    component.setText('email', inputEvent('unique@example.test'));
    component.save();
    const check = http.expectOne('/api/c/company-1/clients/duplicate-check');
    expect(check.request.body).toEqual({
      displayName: 'Unique Demo',
      email: 'unique@example.test',
    });
    component.setText('email', inputEvent('taken@example.test'));
    check.flush({ matches: [] });
    const created = http.match(
      (request) => request.method === 'POST' && request.url === '/api/c/company-1/clients',
    );
    expect(created).toHaveLength(0);
    const again = http.expectOne('/api/c/company-1/clients/duplicate-check');
    expect(again.request.body).toEqual({ displayName: 'Unique Demo', email: 'taken@example.test' });
    again.flush({ matches: [{ id: 'client-9', displayName: 'Taken', archivedAt: null }] });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Possible duplicate — save anyway?');
    http.verify();
  });

  it('drops the extra default when an address changes to a kind that already has one', async () => {
    const { fixture } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.addAddress();
    component.addAddress();
    component.setAddressKind(1, inputEvent('shipping'));
    component.onDefault(0, checkEvent(true));
    component.onDefault(1, checkEvent(true));
    expect(component.draft().addresses.map((address) => [address.kind, address.isDefault])).toEqual(
      [
        ['billing', true],
        ['shipping', true],
      ],
    );
    component.setAddressKind(1, inputEvent('billing'));
    expect(component.draft().addresses.map((address) => [address.kind, address.isDefault])).toEqual(
      [
        ['billing', true],
        ['billing', false],
      ],
    );
  });

  it('rejects two default addresses of the same kind before save', async () => {
    const { fixture, http } = await setup(['client.manage']);
    const component = fixture.componentInstance;
    component.open('company-1', null);
    component.draft.set({
      ...component.draft(),
      displayName: 'Acme Demo',
      addresses: [address('billing', true), address('billing', true)],
    });
    component.save();
    expect(component.errorFor('addresses')).toBe('clients.rules.multipleDefaults');
    expect(http.match((request) => request.method === 'POST')).toHaveLength(0);
    http.verify();
  });
});

async function setup(
  permissions: string[],
  router: {
    navigate?: ReturnType<typeof vi.fn>;
    getCurrentNavigation?: () => unknown;
  } = {},
): Promise<{ fixture: ComponentFixture<ClientFormPage>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [ClientFormPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: {
          availableLangs: ['en', 'el'],
          defaultLang: 'en',
          reRenderOnLangChange: true,
          prodMode: true,
        },
        loader: AppTranslocoLoader,
      }),
      {
        provide: ActivatedRoute,
        useValue: {
          parent: null,
          paramMap: of(convertToParamMap({})),
          queryParamMap: of(convertToParamMap({})),
          snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}) },
        },
      },
      {
        provide: Router,
        useValue: {
          navigate: router.navigate ?? (() => Promise.resolve(true)),
          getCurrentNavigation: router.getCurrentNavigation,
        },
      },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(grant));
  const fixture = TestBed.createComponent(ClientFormPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function clientView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'client-1',
    kind: 'organisation',
    displayName: 'Acme Demo',
    legalName: 'Acme Demo Ltd',
    vatNumber: null,
    taxId: null,
    email: 'acme@example.test',
    phone: null,
    website: null,
    notes: 'server note',
    defaultCurrency: 'EUR',
    defaultLanguage: 'en',
    paymentTermsDays: null,
    acceptsEInvoices: false,
    archivedAt: null,
    version: 3,
    contacts: [],
    addresses: [],
    ...overrides,
  };
}

function address(kind: 'billing' | 'shipping', isDefault: boolean) {
  return {
    key: kind + (isDefault ? '-default' : ''),
    id: '',
    kind,
    label: '',
    line1: '1 Demo Street',
    line2: '',
    city: 'Nicosia',
    region: '',
    postalCode: '',
    countryCode: 'CY',
    isDefault,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function navigateCall(navigate: { mock: { calls: unknown[][] } }): readonly [unknown, unknown] {
  const call = navigate.mock.calls[0];
  if (!call) {
    throw new Error('navigate was not called');
  }
  return [call[0], call[1]];
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function inputEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  const event = new Event('input');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

function checkEvent(checked: boolean): Event {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

function textOf(fixture: ComponentFixture<unknown>): string {
  const root: unknown = fixture.nativeElement;
  return root instanceof HTMLElement ? root.textContent : '';
}

function button(fixture: ComponentFixture<unknown>, name: string): HTMLButtonElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  const found = [...root.querySelectorAll('button')].find((item) =>
    item.textContent.includes(name),
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}
