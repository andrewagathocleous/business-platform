import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { firstValueFrom } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { CompanyContextStore } from '../core/company-context.store';
import { landingCompanyPath } from '../core/nav';
import type { AuthProviders, DevUser } from '../core/models';
import { loginRedirect } from '../core/guards';
import { SessionStore } from '../core/session.store';

@Component({
  selector: 'bp-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <main class="login" id="main">
      <h1>{{ 'login.title' | transloco }}</h1>
      @if (providers() === null) {
        <p role="status">{{ 'login.loading' | transloco }}</p>
      } @else {
        @if (providers()?.oidc) {
          <p-button type="button" [label]="'login.microsoft' | transloco" (onClick)="microsoft()" />
        }
        @if (providers()?.devLogin) {
          <p class="dev-banner" role="status">{{ 'login.devBanner' | transloco }}</p>
          <h2>{{ 'login.devPick' | transloco }}</h2>
          <div class="dev-users">
            @for (user of users(); track user.email) {
              <button type="button" class="dev-user" (click)="signIn(user.email)">
                <span>{{ user.displayName }}</span>
                <span>{{ user.email }}</span>
              </button>
            }
          </div>
        }
        @if (failed()) {
          <p role="alert">{{ 'login.failed' | transloco }}</p>
        }
      }
    </main>
  `,
})
export class LoginPage {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionStore);
  private readonly context = inject(CompanyContextStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly providers = signal<AuthProviders | null>(null);
  readonly users = signal<DevUser[]>([]);
  readonly failed = signal(false);

  constructor() {
    if (this.session.user()) {
      void this.router.navigateByUrl(landingCompanyPath(this.session.companies()));
      return;
    }
    void this.load().catch(() => {
      this.failed.set(true);
    });
  }

  microsoft(): void {
    const redirect = loginRedirect(this.route.snapshot.queryParamMap.get('redirect')) ?? '/';
    window.location.assign(`/api/auth/oidc/start?redirect=${encodeURIComponent(redirect)}`);
  }

  async signIn(email: string): Promise<void> {
    this.failed.set(false);
    try {
      await firstValueFrom(this.http.post('/api/auth/dev/login', { email }));
      this.context.reset();
      this.session.invalidate();
      const loaded = await this.session.load();
      if (loaded !== 'ready' || !this.session.user()) {
        this.failed.set(true);
        return;
      }
      const redirect = loginRedirect(this.route.snapshot.queryParamMap.get('redirect'));
      await this.router.navigateByUrl(redirect ?? landingCompanyPath(this.session.companies()));
    } catch {
      this.failed.set(true);
    }
  }

  private async load(): Promise<void> {
    const providers = await firstValueFrom(this.http.get<AuthProviders>('/api/auth/providers'));
    this.providers.set(providers);
    if (!providers.devLogin) {
      return;
    }
    const listed = await firstValueFrom(this.http.get<{ users: DevUser[] }>('/api/auth/dev/users'));
    this.users.set(listed.users);
  }
}
