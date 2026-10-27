import { Pipe, inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { formatMoney } from './money';

@Pipe({ name: 'money' })
export class MoneyPipe {
  private readonly transloco = inject(TranslocoService);

  transform(
    amount: string | null | undefined,
    currency: string | null | undefined,
    locale?: string | null,
  ): string {
    if (typeof amount !== 'string' || typeof currency !== 'string') {
      return '';
    }
    const lang = resolveLang(locale, this.transloco.getActiveLang());
    try {
      return formatMoney(amount, currency, lang);
    } catch {
      return amount;
    }
  }
}

export function resolveLang(locale: string | null | undefined, active: string): 'en' | 'el' {
  if (locale === 'el' || locale === 'en') {
    return locale;
  }
  return active === 'el' ? 'el' : 'en';
}
