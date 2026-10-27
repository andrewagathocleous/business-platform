import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { DEFAULT_COMPANY_TIME_ZONE, formatCompanyDate } from './company-date';
import { CompanyDatePipe } from './company-date.pipe';

const springBefore = '2026-03-29T00:30:00Z';
const springAfter = '2026-03-29T01:30:00Z';
const fallBefore = '2026-10-25T00:30:00Z';
const fallAfter = '2026-10-25T01:30:00Z';

describe('formatCompanyDate', () => {
  it('shows the hours on either side of the Nicosia spring-forward', () => {
    const before = formatCompanyDate(springBefore);
    const after = formatCompanyDate(springAfter);
    expect(before).toContain('29/03/2026');
    expect(before).toContain('02:30');
    expect(offsetHours(before)).toBe(2);
    expect(after).toContain('04:30');
    expect(offsetHours(after)).toBe(3);
  });

  it('shows the repeated hour on the Nicosia fall-back', () => {
    const before = formatCompanyDate(fallBefore);
    const after = formatCompanyDate(fallAfter);
    expect(before).toContain('25/10/2026');
    expect(before).toContain('03:30');
    expect(offsetHours(before)).toBe(3);
    expect(after).toContain('03:30');
    expect(offsetHours(after)).toBe(2);
  });

  it('defaults to Asia/Nicosia and uses day/month/year in both languages', () => {
    expect(DEFAULT_COMPANY_TIME_ZONE).toBe('Asia/Nicosia');
    const english = formatCompanyDate(springBefore);
    expect(english).toBe(formatCompanyDate(springBefore, 'Asia/Nicosia', 'en'));
    expect(english.startsWith('29/03/2026')).toBe(true);
    const greek = formatCompanyDate(springBefore, 'Asia/Nicosia', 'el');
    expect(greek.startsWith('29/03/2026')).toBe(true);
    expect(greek).toContain('02:30');
    expect(offsetHours(greek)).toBe(2);
    expect(formatCompanyDate('not-a-date')).toBe('');
  });
});

describe('CompanyDatePipe', () => {
  it('formats with the company zone and the active language', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        CompanyDatePipe,
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
    });
    const transloco = TestBed.inject(TranslocoService);
    await firstValueFrom(transloco.load('en'));
    const pipe = TestBed.inject(CompanyDatePipe);
    const formatted = pipe.transform(springBefore);
    expect(formatted).toContain('02:30');
    expect(offsetHours(formatted)).toBe(2);
    transloco.setActiveLang('el');
    expect(pipe.transform(springBefore).startsWith('29/03/2026')).toBe(true);
    expect(pipe.transform(null)).toBe('');
  });
});

function offsetHours(formatted: string): number {
  const match = /GMT\+(\d{1,2})/.exec(formatted);
  if (!match?.[1]) {
    throw new Error(`missing offset in ${formatted}`);
  }
  return Number(match[1]);
}
