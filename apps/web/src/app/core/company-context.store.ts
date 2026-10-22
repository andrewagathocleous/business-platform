import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_COMPANY_TIME_ZONE } from '../format/company-date';
import { NAVIGATE_ON_DENIED } from './navigate-on-denied';
import { holdsPermission } from './nav';
import type { CompanyContext, Grant, Locale } from './models';

export type ContextLoad = 'ok' | 'forbidden' | 'not-found';

@Injectable({ providedIn: 'root' })
export class CompanyContextStore {
  private readonly http = inject(HttpClient);

  readonly companyId = signal<string | null>(null);
  readonly timezone = signal(DEFAULT_COMPANY_TIME_ZONE);
  readonly currency = signal('EUR');
  readonly documentLanguage = signal<Locale>('en');
  readonly grants = signal<readonly Grant[]>([]);
  readonly mfaStepUpRequired = signal(false);
  readonly withheldPermissions = signal<readonly string[]>([]);
  private generation = 0;
  private sequence = 0;
  private latestSequence = 0;
  private pendingId: string | null = null;
  private pending: Promise<ContextLoad> | null = null;

  has(permission: string): boolean {
    return holdsPermission(this.grants(), permission);
  }

  /**
   * Drops company grants. An in-flight context response from before this call
   * must not write state afterwards.
   */
  reset(): void {
    this.generation += 1;
    this.sequence += 1;
    this.latestSequence = this.sequence;
    this.pending = null;
    this.pendingId = null;
    this.companyId.set(null);
    this.timezone.set(DEFAULT_COMPANY_TIME_ZONE);
    this.currency.set('EUR');
    this.documentLanguage.set('en');
    this.grants.set([]);
    this.mfaStepUpRequired.set(false);
    this.withheldPermissions.set([]);
  }

  load(companyId: string): Promise<ContextLoad> {
    const id = companyId.toLowerCase();
    if (this.companyId() === id && this.pending === null) {
      return Promise.resolve('ok');
    }
    if (this.pending && this.pendingId === id) {
      return this.pending;
    }
    const generation = this.generation;
    const sequence = ++this.sequence;
    this.latestSequence = sequence;
    const task = this.fetch(id, generation, sequence).finally(() => {
      if (this.pending === task) {
        this.pending = null;
        this.pendingId = null;
      }
    });
    this.pendingId = id;
    this.pending = task;
    return task;
  }

  private applies(generation: number, sequence: number): boolean {
    return generation === this.generation && sequence === this.latestSequence;
  }

  private async fetch(companyId: string, generation: number, sequence: number): Promise<ContextLoad> {
    try {
      const context = await firstValueFrom(
        this.http.get<CompanyContext>(`/api/c/${companyId}/context`, {
          context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
        }),
      );
      if (!this.applies(generation, sequence)) {
        return 'ok';
      }
      this.companyId.set(context.company.id.toLowerCase());
      this.timezone.set(
        context.company.timezone.length > 0 ? context.company.timezone : DEFAULT_COMPANY_TIME_ZONE,
      );
      this.currency.set(context.company.defaultCurrency);
      this.documentLanguage.set(context.company.documentLanguage === 'el' ? 'el' : 'en');
      this.grants.set(context.grants);
      this.mfaStepUpRequired.set(context.mfaStepUpRequired);
      this.withheldPermissions.set(context.withheldPermissions);
      return 'ok';
    } catch (error: unknown) {
      if (!this.applies(generation, sequence)) {
        return 'ok';
      }
      this.companyId.set(null);
      this.grants.set([]);
      this.mfaStepUpRequired.set(false);
      this.withheldPermissions.set([]);
      this.documentLanguage.set('en');
      if (error instanceof HttpErrorResponse && error.status === 403) {
        return 'forbidden';
      }
      if (error instanceof HttpErrorResponse && error.status === 404) {
        return 'not-found';
      }
      throw error;
    }
  }
}
