import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { landingCompanyPath } from '../core/nav';
import { SessionStore } from '../core/session.store';

@Component({
  selector: 'bp-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink],
  template: `
    <main class="page" id="main">
      <h1>{{ 'notFound.title' | transloco }}</h1>
      <p>{{ 'notFound.body' | transloco }}</p>
      @if (session.user()) {
        <a [routerLink]="home()">{{ 'notFound.home' | transloco }}</a>
      }
    </main>
  `,
})
export class NotFoundPage {
  readonly session = inject(SessionStore);

  home(): string {
    return landingCompanyPath(this.session.companies());
  }
}
