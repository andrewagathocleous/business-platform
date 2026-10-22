import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { formatMoney } from './money';
import { MoneyPipe } from './money.pipe';

const wide = '9007199254740993.12345678901234567890';

describe('formatMoney', () => {
  it('groups thousands and keeps every fraction digit', () => {
    expect(formatMoney('1234567.891', 'EUR', 'en')).toBe('1,234,567.891 EUR');
    expect(formatMoney('1234567.891', 'EUR', 'el')).toBe('1.234.567,891 EUR');
  });

  it('keeps a leading minus, many decimals and a zero amount', () => {
    expect(formatMoney('-1234.5', 'EUR', 'en')).toBe('-1,234.5 EUR');
    expect(formatMoney('-0.10', 'USD', 'el')).toBe('-0,10 USD');
    expect(formatMoney('0', 'EUR', 'en')).toBe('0 EUR');
    expect(formatMoney('0.00', 'EUR', 'en')).toBe('0.00 EUR');
    expect(formatMoney('0001234.50', 'EUR', 'en')).toBe('1,234.50 EUR');
  });

  it('shows 0.1 and 0.2 as separate strings and keeps a value Number would corrupt', () => {
    const tenths = [formatMoney('0.1', 'EUR', 'en'), formatMoney('0.2', 'EUR', 'en')];
    expect(tenths).toEqual(['0.1 EUR', '0.2 EUR']);
    expect(tenths.join(' + ')).toBe('0.1 EUR + 0.2 EUR');

    const formatted = formatMoney(wide, 'EUR', 'en');
    expect(formatted).toBe('9,007,199,254,740,993.12345678901234567890 EUR');
    expect(formatted.replaceAll(/[, ]|EUR/g, '')).toBe(wide);
    expect(String(Number(wide))).not.toBe(wide);
  });

  it('rejects a non-decimal amount and a currency that is not a code', () => {
    expect(() => formatMoney('12.3.4', 'EUR', 'en')).toThrow(/decimal string/);
    expect(() => formatMoney('1', 'euro', 'en')).toThrow(/3-letter code/);
  });
});

describe('MoneyPipe', () => {
  it('uses the active language grouping', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        MoneyPipe,
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
    const pipe = TestBed.inject(MoneyPipe);
    expect(pipe.transform(wide, 'EUR')).toBe('9,007,199,254,740,993.12345678901234567890 EUR');
    transloco.setActiveLang('el');
    expect(pipe.transform('1234567.891', 'EUR')).toBe('1.234.567,891 EUR');
    expect(pipe.transform(null, 'EUR')).toBe('');
  });
});
