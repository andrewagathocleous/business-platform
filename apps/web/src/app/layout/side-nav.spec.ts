import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type { Grant } from '../core/models';
import { firstAllowedPath, visibleNav } from '../core/nav';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { SideNavComponent } from './side-nav';

const fulfilGrants: Grant[] = [
  { permission: 'company.view', scopeType: 'company', scopeId: null },
  { permission: 'catalog.view', scopeType: 'company', scopeId: null },
  { permission: 'order.view', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'order.edit', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'order.claim', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'order.transition', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'document.download', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'print.submit', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'print.reprint', scopeType: 'store', scopeId: 'store-1' },
  { permission: 'print.confirm', scopeType: 'store', scopeId: 'store-1' },
];

describe('visibleNav', () => {
  it('shows orders and company for a fulfilment grant set', () => {
    const labels = visibleNav(fulfilGrants).map((item) => item.labelKey);
    expect(labels).toEqual(['nav.orders', 'nav.company']);
    expect(firstAllowedPath('company-a', fulfilGrants)).toBe('/c/company-a/orders');
  });
});

describe('SideNavComponent', () => {
  it('shows Orders and Company, and hides Invoices, for fulfilment grants', async () => {
    await TestBed.configureTestingModule({
      imports: [SideNavComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
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

    const fixture: ComponentFixture<SideNavComponent> = TestBed.createComponent(SideNavComponent);
    fixture.componentRef.setInput('companyId', 'company-a');
    fixture.componentRef.setInput('grants', fulfilGrants);
    fixture.detectChanges();
    await fixture.whenStable();

    const text = textOf(fixture.nativeElement);
    expect(text).toContain('Orders');
    expect(text).toContain('Admin');
    expect(text).toContain('Company');
    expect(text).not.toContain('Invoices');
    expect(text).not.toContain('Clients');
    expect(text).not.toContain('Members');
    expect(text).not.toContain('Stores');
  });
});

function textOf(element: unknown): string {
  if (!(element instanceof HTMLElement)) {
    return '';
  }
  return element.textContent;
}
