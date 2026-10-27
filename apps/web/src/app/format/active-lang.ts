import { Injectable, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TranslocoService } from '@jsverse/transloco';
import { map } from 'rxjs';

export type FormatLang = 'en' | 'el';

/** The language the money and date pipes read. Templates pass `code()` in so a language change redraws them. */
@Injectable({ providedIn: 'root' })
export class ActiveLang {
  private readonly transloco = inject(TranslocoService);
  readonly code = toSignal(
    this.transloco.langChanges$.pipe(map((lang) => (lang === 'el' ? 'el' : 'en'))),
    { initialValue: this.transloco.getActiveLang() === 'el' ? 'el' : 'en' },
  );
}
