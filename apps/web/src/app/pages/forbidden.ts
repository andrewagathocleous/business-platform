import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { landingCompanyPath } from '../core/nav';
import { SessionStore } from '../core/session.store';

@Component({
  selector: 'bp-forbidden',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink],
  template: `
    <main class="page" id="main">
      <h1>{{ 'forbidden.title' | transloco }}</h1>
      <p>{{ 'forbidden.body' | transloco }}</p>
      @if (session.user()) {
        <a [routerLink]="home()">{{ 'forbidden.home' | transloco }}</a>
      }
    </main>
  `,
})
export class ForbiddenPage {
  readonly session = inject(SessionStore);

  home(): string {
    return landingCompanyPath(this.session.companies());
  }
}
