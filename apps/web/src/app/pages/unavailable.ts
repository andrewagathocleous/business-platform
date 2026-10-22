import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { landingCompanyPath } from '../core/nav';
import { safeAppPath } from '../core/redirect';
import { SessionStore } from '../core/session.store';

@Component({
  selector: 'bp-unavailable',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <main class="page" id="main">
      <h1>{{ 'unavailable.title' | transloco }}</h1>
      <p role="alert">{{ 'unavailable.body' | transloco }}</p>
      @if (session.bootstrapError()) {
        <p>{{ 'errors.correlation' | transloco }}: {{ session.bootstrapError() }}</p>
      }
      <p-button type="button" [label]="'unavailable.retry' | transloco" [disabled]="trying()" (onClick)="retry()" />
    </main>
  `,
})
export class UnavailablePage {
  readonly session = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly trying = signal(false);

  async retry(): Promise<void> {
    if (this.trying()) {
      return;
    }
    this.trying.set(true);
    try {
      const result = await this.session.load();
      if (result === 'ready') {
        const redirect = safeAppPath(this.route.snapshot.queryParamMap.get('redirect'));
        await this.router.navigateByUrl(redirect ?? landingCompanyPath(this.session.companies()));
        return;
      }
      if (result === 'anonymous') {
        await this.router.navigateByUrl('/login');
      }
    } finally {
      this.trying.set(false);
    }
  }
}
