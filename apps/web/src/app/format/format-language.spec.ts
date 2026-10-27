import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { Component, inject, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { ActiveLang } from './active-lang';
import { CompanyDatePipe } from './company-date.pipe';
import { MoneyPipe } from './money.pipe';

@Component({
  selector: 'bp-format-host',
  imports: [MoneyPipe, CompanyDatePipe],
  template: `{{ amount | money: 'EUR' : lang.code() }} {{ when | companyDate: zone() : lang.code() }}`,
})
class FormatHost {
  readonly lang = inject(ActiveLang);
  readonly zone = signal('Asia/Nicosia');
  readonly amount = '1234.5';
  readonly when = '2026-03-29T00:30:00Z';
}

describe('money and companyDate pipes', () => {
  it('redraws the existing view when the language changes', async () => {
    await TestBed.configureTestingModule({
      imports: [FormatHost],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
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
    const fixture: ComponentFixture<FormatHost> = TestBed.createComponent(FormatHost);
    const host = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    expect(text(fixture)).toContain('1,234.5 EUR');
    expect(text(fixture)).toContain('29/03/2026');

    transloco.setActiveLang('el');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance).toBe(host);
    expect(text(fixture)).toContain('1.234,5 EUR');
    expect(text(fixture)).toContain('29/03/2026');
  });
});

function text(fixture: ComponentFixture<unknown>): string {
  const element: unknown = fixture.nativeElement;
  return element instanceof HTMLElement ? element.textContent : '';
}
