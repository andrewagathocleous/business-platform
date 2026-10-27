import { Pipe, inject } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { CompanyContextStore } from '../core/company-context.store';
import { resolveLang } from './money.pipe';
import { DEFAULT_COMPANY_TIME_ZONE, formatCompanyDate } from './company-date';

@Pipe({ name: 'companyDate' })
export class CompanyDatePipe {
  private readonly context = inject(CompanyContextStore);
  private readonly transloco = inject(TranslocoService);

  transform(
    value: string | Date | null | undefined,
    timeZone?: string | null,
    locale?: string | null,
  ): string {
    if (value == null || value === '') {
      return '';
    }
    const zone = timeZone && timeZone.length > 0 ? timeZone : this.zone();
    const lang = resolveLang(locale, this.transloco.getActiveLang());
    try {
      return formatCompanyDate(value, zone, lang);
    } catch {
      return '';
    }
  }

  private zone(): string {
    const fromCompany = this.context.timezone();
    return fromCompany.length > 0 ? fromCompany : DEFAULT_COMPANY_TIME_ZONE;
  }
}
