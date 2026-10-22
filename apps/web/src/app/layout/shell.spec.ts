import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { providePrimeNG } from 'primeng/config';
import Aura from '@primeuix/themes/aura';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../core/session.store';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { ShellComponent } from './shell';

describe('ShellComponent', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('closes the user menu on Escape and returns focus to the user button', async () => {
    const { fixture } = await setup();
    document.body.appendChild(fixture.nativeElement);
    userButton(fixture).click();
    fixture.detectChanges();
    expect(panel(fixture)).toBeInstanceOf(HTMLElement);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(panel(fixture)).toBeNull();
    expect(document.activeElement).toBe(userButton(fixture));
  });

  it('closes the user menu on an outside click', async () => {
    const { fixture } = await setup();
    document.body.appendChild(fixture.nativeElement);
    userButton(fixture).click();
    fixture.detectChanges();
    expect(panel(fixture)).toBeInstanceOf(HTMLElement);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(panel(fixture)).toBeNull();
  });

  it('binds the lowercase company id', async () => {
    const { fixture } = await setup();
    expect(fixture.componentInstance.currentId()).toBe('company-1');
  });

  it('disables the language buttons while a change is saving', async () => {
    const { fixture, http } = await setup();
    document.body.appendChild(fixture.nativeElement);
    userButton(fixture).click();
    fixture.detectChanges();
    languageButton(fixture, 'Ελληνικά').click();
    fixture.detectChanges();
    const patch = await localePatch(http);
    expect(languageButton(fixture, 'English').disabled).toBe(true);
    expect(languageButton(fixture, 'Ελληνικά').disabled).toBe(true);
    patch.flush({
      user: {
        id: 'user-1',
        email: 'admin.a@example.test',
        displayName: 'Admin A',
        locale: 'el',
        isPlatformOwner: false,
      },
      companies: [],
      session: {
        idleExpiresAt: '2026-10-22T00:00:00.000Z',
        absoluteExpiresAt: '2026-10-29T00:00:00.000Z',
      },
    });
    await fixture.whenStable();
    http.verify();
  });
});

async function setup(): Promise<{ fixture: ComponentFixture<ShellComponent>; http: HttpTestingController }> {
  const params = new BehaviorSubject(convertToParamMap({ companyId: 'COMPANY-1' }));
  await TestBed.configureTestingModule({
    imports: [ShellComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      providePrimeNG({ theme: { preset: Aura, options: { darkModeSelector: 'none' } } }),
      {
        provide: ActivatedRoute,
        useValue: {
          paramMap: params.asObservable(),
          snapshot: { paramMap: convertToParamMap({ companyId: 'COMPANY-1' }) },
        },
      },
      provideTransloco({
        config: {
          availableLangs: ['en', 'el'],
          defaultLang: 'en',
          reRenderOnLangChange: true,
          prodMode: true,
        },
        loader: AppTranslocoLoader,
      }),
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  const session = TestBed.inject(SessionStore);
  session.user.set({
    id: 'user-1',
    email: 'admin.a@example.test',
    displayName: 'Admin A',
    locale: 'en',
    isPlatformOwner: false,
  });
  session.companies.set([
    { id: 'company-1', legalName: 'Demo', tradingName: 'Nutbox (demo data)', status: 'active' },
  ]);
  const fixture = TestBed.createComponent(ShellComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function host(fixture: ComponentFixture<ShellComponent>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) {
    throw new Error('missing shell');
  }
  return element;
}

function userButton(fixture: ComponentFixture<ShellComponent>): HTMLButtonElement {
  const button: unknown = host(fixture).querySelector('.user-button');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('missing user button');
  }
  return button;
}

function panel(fixture: ComponentFixture<ShellComponent>): HTMLElement | null {
  const element: unknown = host(fixture).querySelector('#user-panel');
  return element instanceof HTMLElement ? element : null;
}

async function localePatch(http: HttpTestingController): Promise<TestRequest> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = http.match((request) => request.method === 'PATCH' && request.url === '/api/me');
    const request = found[0];
    if (request) {
      return request;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('missing locale update');
}

function languageButton(fixture: ComponentFixture<ShellComponent>, name: string): HTMLButtonElement {
  const root = panel(fixture);
  if (!root) {
    throw new Error('missing user menu');
  }
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent.includes(name));
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing ${name}`);
  }
  return found;
}
