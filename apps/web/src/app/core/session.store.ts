import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { readApiError } from './api-error';
import { isLocale, type Locale, type MeResponse, type MeUser, type CompanySummary } from './models';
import { clearPendingPaymentAttempts } from './pending-payment-attempts';

export type SessionLoad = 'ready' | 'anonymous' | 'error';

@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);

  readonly user = signal<MeUser | null>(null);
  readonly companies = signal<CompanySummary[]>([]);
  /** True while a locale PATCH is the latest one still in flight. */
  readonly localeSaving = signal(false);
  /** Correlation id from a startup /api/me failure, or '' when the failure had none. */
  readonly bootstrapError = signal<string | null>(null);
  private loaded = false;
  private pending: Promise<SessionLoad> | null = null;
  /** Bumped by logout, a 401, and a new login so late responses cannot restore an old user. */
  private generation = 0;

  /** Generation at the moment a request is sent. Older 401s must not abandon a newer session. */
  currentGeneration(): number {
    return this.generation;
  }
  private localeRequest = 0;

  load(): Promise<SessionLoad> {
    if (this.loaded) {
      return Promise.resolve(this.user() ? 'ready' : 'anonymous');
    }
    this.pending ??= this.fetch();
    return this.pending;
  }

  /** Drops the cached probe so the next load reads /api/me again. Used after login. */
  invalidate(): void {
    this.generation += 1;
    this.loaded = false;
    this.pending = null;
    this.localeSaving.set(false);
    this.bootstrapError.set(null);
  }

  /** Drops the in-memory session after a 401. Does not call the API. */
  abandon(): void {
    this.generation += 1;
    this.clear();
    this.loaded = true;
    this.pending = null;
    this.localeSaving.set(false);
    this.bootstrapError.set(null);
  }

  async setLocale(locale: Locale): Promise<void> {
    const generation = this.generation;
    const request = ++this.localeRequest;
    this.localeSaving.set(true);
    const previous = this.user()?.locale ?? 'en';
    await this.applyLocale(locale, generation);
    try {
      const me = await firstValueFrom(this.http.patch<MeResponse>('/api/me', { locale }));
      if (!this.sameLocaleRequest(generation, request)) {
        return;
      }
      await this.apply(me, generation);
    } catch (error: unknown) {
      if (this.sameLocaleRequest(generation, request)) {
        await this.applyLocale(previous, generation);
      }
      throw error;
    } finally {
      if (request === this.localeRequest) {
        this.localeSaving.set(false);
      }
    }
  }

  async logout(): Promise<void> {
    clearPendingPaymentAttempts();
    const generation = ++this.generation;
    this.localeSaving.set(false);
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      if (generation === this.generation) {
        this.clear();
        this.loaded = true;
        this.pending = null;
        this.bootstrapError.set(null);
      }
    }
  }

  private sameLocaleRequest(generation: number, request: number): boolean {
    return generation === this.generation && request === this.localeRequest;
  }

  private async fetch(): Promise<SessionLoad> {
    const generation = this.generation;
    try {
      const me = await firstValueFrom(
        this.http.get<MeResponse>('/api/me', { headers: { 'X-Session-Probe': '1' } }),
      );
      if (generation !== this.generation) {
        return this.user() ? 'ready' : 'anonymous';
      }
      await this.apply(me, generation);
      this.loaded = true;
      this.bootstrapError.set(null);
      return 'ready';
    } catch (error: unknown) {
      if (generation !== this.generation) {
        return this.user() ? 'ready' : 'anonymous';
      }
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.clear();
        this.loaded = true;
        this.bootstrapError.set(null);
        return 'anonymous';
      }
      this.loaded = false;
      const correlation =
        error instanceof HttpErrorResponse ? readApiError(error).correlationId : null;
      this.bootstrapError.set(correlation ?? '');
      return 'error';
    } finally {
      this.pending = null;
    }
  }

  private async apply(me: MeResponse, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    clearPendingPaymentAttempts(me.user.id);
    this.user.set(me.user);
    this.companies.set(me.companies);
    await this.applyLocale(isLocale(me.user.locale) ? me.user.locale : 'en', generation);
  }

  private async applyLocale(locale: Locale, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return;
    }
    this.user.update((user) => (user ? { ...user, locale } : user));
    await firstValueFrom(this.transloco.load(locale));
    if (generation !== this.generation) {
      return;
    }
    this.transloco.setActiveLang(locale);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }

  private clear(): void {
    this.user.set(null);
    this.companies.set([]);
  }
}
