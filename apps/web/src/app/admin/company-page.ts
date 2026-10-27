import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { of } from 'rxjs';
import { isVersionConflict, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { fieldValue } from '../orders/field-value';

type LocaleCode = 'en' | 'el';

type AddressFields = {
  line1: string;
  line2: string;
  city: string;
  postcode: string;
  countryCode: string;
};

type CompanyDetails = {
  version: number;
  legalName: string;
  tradingName: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  taxOffice: string | null;
  address: unknown;
  timezone: string;
  defaultCurrency: string;
  defaultLocale: LocaleCode;
  documentLanguage: LocaleCode;
  paymentTermsDays: number;
};

type Snapshot = AddressFields & {
  version: number;
  legalName: string;
  tradingName: string;
  registrationNumber: string;
  vatNumber: string;
  taxOffice: string;
  timezone: string;
  defaultCurrency: string;
  defaultLocale: LocaleCode;
  documentLanguage: LocaleCode;
  paymentTermsDays: string;
};

@Component({
  selector: 'bp-company-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <section class="screen">
      <h1>{{ 'companySetup.title' | transloco }}</h1>
      @if (conflict(); as item) {
        <div class="app-toast" role="alert">
          <p>{{ 'companySetup.conflict' | transloco }}</p>
          @if (item.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
          }
          <p-button
            type="button"
            [label]="'companySetup.reload' | transloco"
            (onClick)="reload()"
          />
        </div>
      }
      @if (actionError()) {
        <p role="alert">{{ actionError() }}</p>
      }
      @if (loading()) {
        <p role="status">{{ 'companySetup.loading' | transloco }}</p>
      }
      @if (loadError()) {
        <p role="alert">{{ 'companySetup.error' | transloco }}</p>
      }
      @if (loaded()) {
        <form class="form-grid" (submit)="$event.preventDefault()">
          <label>
            {{ 'companySetup.fields.legalName' | transloco }}
            <input
              [value]="legalName()"
              [disabled]="!canEdit()"
              (input)="legalName.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.tradingName' | transloco }}
            ({{ 'companySetup.required' | transloco }})
            <input
              required
              [value]="tradingName()"
              [disabled]="!canEdit()"
              (input)="tradingName.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.registrationNumber' | transloco }}
            <input
              [value]="registrationNumber()"
              [disabled]="!canEdit()"
              (input)="registrationNumber.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.vatNumber' | transloco }}
            <input
              [value]="vatNumber()"
              [disabled]="!canEdit()"
              (input)="vatNumber.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.taxOffice' | transloco }}
            <input
              [value]="taxOffice()"
              [disabled]="!canEdit()"
              (input)="taxOffice.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.line1' | transloco }}
            <input [value]="line1()" [disabled]="!canEdit()" (input)="line1.set(field($event))" />
          </label>
          <label>
            {{ 'companySetup.fields.line2' | transloco }}
            <input [value]="line2()" [disabled]="!canEdit()" (input)="line2.set(field($event))" />
          </label>
          <label>
            {{ 'companySetup.fields.city' | transloco }}
            <input [value]="city()" [disabled]="!canEdit()" (input)="city.set(field($event))" />
          </label>
          <label>
            {{ 'companySetup.fields.postcode' | transloco }}
            <input
              [value]="postcode()"
              [disabled]="!canEdit()"
              (input)="postcode.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.countryCode' | transloco }}
            <input
              [value]="countryCode()"
              [disabled]="!canEdit()"
              (input)="countryCode.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.timezone' | transloco }}
            <input
              [value]="timezone()"
              [disabled]="!canEdit()"
              (input)="timezone.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.currency' | transloco }}
            <input
              [value]="currency()"
              [disabled]="!canEdit()"
              (input)="currency.set(field($event))"
            />
          </label>
          <label>
            {{ 'companySetup.fields.defaultLocale' | transloco }}
            <select [disabled]="!canEdit()" (change)="defaultLocale.set(locale(field($event)))">
              <option value="en" [selected]="defaultLocale() === 'en'">English</option>
              <option value="el" [selected]="defaultLocale() === 'el'">Ελληνικά</option>
            </select>
          </label>
          <label>
            {{ 'companySetup.fields.documentLanguage' | transloco }}
            <select [disabled]="!canEdit()" (change)="documentLanguage.set(locale(field($event)))">
              <option value="en" [selected]="documentLanguage() === 'en'">English</option>
              <option value="el" [selected]="documentLanguage() === 'el'">Ελληνικά</option>
            </select>
          </label>
          <label>
            {{ 'companySetup.fields.paymentTermsDays' | transloco }}
            <input
              [value]="paymentTermsDays()"
              [disabled]="!canEdit()"
              (input)="paymentTermsDays.set(field($event))"
            />
          </label>
          @if (canManage()) {
            <div class="form-actions">
              <p-button
                type="button"
                [label]="'companySetup.save' | transloco"
                [disabled]="busy() || !canSave()"
                (onClick)="save()"
              />
            </div>
          }
        </form>
      }
    </section>
  `,
})
export class CompanyPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly context = inject(CompanyContextStore);
  private readonly transloco = inject(TranslocoService);

  readonly canManage = computed(() => this.context.has('company.manage'));
  readonly canEdit = computed(() => this.canManage() && !this.busy());
  readonly field = fieldValue;
  readonly companyId = signal('');
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly loadError = signal(false);
  readonly busy = signal(false);
  readonly actionError = signal('');
  readonly conflict = signal<{ correlationId: string | null } | null>(null);
  readonly legalName = signal('');
  readonly tradingName = signal('');
  readonly registrationNumber = signal('');
  readonly vatNumber = signal('');
  readonly taxOffice = signal('');
  readonly line1 = signal('');
  readonly line2 = signal('');
  readonly city = signal('');
  readonly postcode = signal('');
  readonly countryCode = signal('');
  readonly timezone = signal('');
  readonly currency = signal('');
  readonly defaultLocale = signal<LocaleCode>('en');
  readonly documentLanguage = signal<LocaleCode>('en');
  readonly paymentTermsDays = signal('');
  private version = 0;
  private snapshot: Snapshot | null = null;
  private generation = 0;
  /** Company the current form values were loaded for. Save writes only here. */
  private readonly boundCompanyId = signal<string | null>(null);
  /** Last shared company id this effect handled. A stale id must not clear a new route. */
  private contextSeen: string | null = null;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
    effect(() => {
      const contextId = this.context.companyId();
      const routeId = this.companyId();
      if (!contextId) {
        return;
      }
      // Only a change of the shared company acts here. The route load is separate,
      // so a store that still names the previous company does not wipe it.
      if (this.contextSeen?.toLowerCase() === contextId.toLowerCase()) {
        return;
      }
      this.contextSeen = contextId;
      const bound = this.boundCompanyId();
      if (bound && bound.toLowerCase() !== contextId.toLowerCase()) {
        this.dropLoadedForm();
      }
      if (
        !this.boundCompanyId() &&
        routeId.length > 0 &&
        routeId.toLowerCase() === contextId.toLowerCase() &&
        !this.loading() &&
        !this.loaded() &&
        !this.loadError()
      ) {
        this.load(this.generation);
      }
    });
  }

  open(companyId: string): void {
    const changed = companyId !== this.companyId();
    this.companyId.set(companyId);
    if (changed) {
      this.dropLoadedForm();
    } else {
      this.generation += 1;
      this.conflict.set(null);
      this.actionError.set('');
    }
    this.load(this.generation);
  }

  reload(): void {
    this.conflict.set(null);
    this.actionError.set('');
    this.generation += 1;
    this.load(this.generation);
  }

  save(): void {
    const target = this.boundCompanyId();
    if (!this.loaded() || !target) {
      return;
    }
    if (target.toLowerCase() !== this.companyId().toLowerCase()) {
      this.dropLoadedForm();
      this.load(this.generation);
      return;
    }
    if (!this.canManage() || this.busy() || !this.canSave()) {
      return;
    }
    const body = this.patchBody();
    if (!body) {
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.actionError.set('');
    this.http
      .patch<{ company: CompanyDetails }>(`/api/c/${target}/company`, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.apply(response.company);
          void this.context.reload(target).catch(() => undefined);
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          if (isVersionConflict(error)) {
            const api = error instanceof HttpErrorResponse ? readApiError(error) : null;
            this.conflict.set({ correlationId: api?.correlationId ?? null });
            return;
          }
          this.actionError.set(
            error instanceof HttpErrorResponse ? readApiError(error).message : '',
          );
        },
      });
  }

  locale(value: string): LocaleCode {
    return value === 'el' ? 'el' : 'en';
  }

  dirty(): boolean {
    const current = this.snapshot;
    if (!current) {
      return false;
    }
    return JSON.stringify(current) !== JSON.stringify(this.currentSnapshot());
  }

  canSave(): boolean {
    return this.dirty() && this.tradingName().trim().length > 0;
  }

  private load(generation: number): void {
    const companyId = this.companyId();
    if (!companyId) {
      return;
    }
    this.loading.set(true);
    this.loadError.set(false);
    this.http
      .get<{ company: CompanyDetails }>(`/api/c/${companyId}/context`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.apply(response.company);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          this.loadError.set(true);
        },
      });
  }

  private apply(company: CompanyDetails): void {
    const address = readAddress(company.address);
    this.version = company.version;
    this.legalName.set(company.legalName);
    this.tradingName.set(company.tradingName);
    this.registrationNumber.set(company.registrationNumber ?? '');
    this.vatNumber.set(company.vatNumber ?? '');
    this.taxOffice.set(company.taxOffice ?? '');
    this.line1.set(address.line1);
    this.line2.set(address.line2);
    this.city.set(address.city);
    this.postcode.set(address.postcode);
    this.countryCode.set(address.countryCode);
    this.timezone.set(company.timezone);
    this.currency.set(company.defaultCurrency);
    this.defaultLocale.set(company.defaultLocale === 'el' ? 'el' : 'en');
    this.documentLanguage.set(company.documentLanguage === 'el' ? 'el' : 'en');
    this.paymentTermsDays.set(String(company.paymentTermsDays));
    this.snapshot = this.currentSnapshot();
    this.boundCompanyId.set(this.companyId());
    this.loaded.set(true);
    this.conflict.set(null);
  }

  private patchBody(): Record<string, unknown> | null {
    const current = this.snapshot;
    if (!current) {
      return null;
    }
    const next = this.currentSnapshot();
    const body: Record<string, unknown> = { expectedVersion: this.version };
    if (!this.putText(body, 'legalName', next.legalName, current.legalName)) {
      return null;
    }
    if (!this.putText(body, 'tradingName', next.tradingName, current.tradingName)) {
      return null;
    }
    this.putClearable(
      body,
      'registrationNumber',
      next.registrationNumber,
      current.registrationNumber,
    );
    this.putClearable(body, 'vatNumber', next.vatNumber, current.vatNumber);
    this.putClearable(body, 'taxOffice', next.taxOffice, current.taxOffice);
    if (
      next.line1 !== current.line1 ||
      next.line2 !== current.line2 ||
      next.city !== current.city ||
      next.postcode !== current.postcode ||
      next.countryCode !== current.countryCode
    ) {
      if (
        next.line1.trim().length === 0 ||
        next.city.trim().length === 0 ||
        next.countryCode.trim().length === 0
      ) {
        this.actionError.set(this.transloco.translate('companySetup.addressRequired'));
        return null;
      }
      body['address'] = addressBody(next);
    }
    if (!this.putText(body, 'timezone', next.timezone, current.timezone)) {
      return null;
    }
    if (!this.putText(body, 'defaultCurrency', next.defaultCurrency, current.defaultCurrency)) {
      return null;
    }
    if (next.defaultLocale !== current.defaultLocale) {
      body['defaultLocale'] = next.defaultLocale;
    }
    if (next.documentLanguage !== current.documentLanguage) {
      body['documentLanguage'] = next.documentLanguage;
    }
    if (next.paymentTermsDays !== current.paymentTermsDays) {
      if (!/^\d+$/.test(next.paymentTermsDays.trim())) {
        this.actionError.set(this.transloco.translate('companySetup.paymentTermsInvalid'));
        return null;
      }
      body['paymentTermsDays'] = Number(next.paymentTermsDays.trim());
    }
    return body;
  }

  private putText(
    body: Record<string, unknown>,
    key: string,
    next: string,
    current: string,
  ): boolean {
    if (next === current) {
      return true;
    }
    const trimmed = next.trim();
    if (trimmed.length === 0) {
      this.actionError.set(this.transloco.translate('companySetup.cannotClear'));
      return false;
    }
    body[key] = trimmed;
    return true;
  }

  private putClearable(
    body: Record<string, unknown>,
    key: string,
    next: string,
    current: string,
  ): void {
    if (next === current) {
      return;
    }
    const trimmed = next.trim();
    body[key] = trimmed.length === 0 ? null : trimmed;
  }

  private dropLoadedForm(): void {
    this.generation += 1;
    this.busy.set(false);
    this.boundCompanyId.set(null);
    this.snapshot = null;
    this.loaded.set(false);
    this.loadError.set(false);
    this.conflict.set(null);
    this.actionError.set('');
    this.resetFields();
  }

  private resetFields(): void {
    this.version = 0;
    this.legalName.set('');
    this.tradingName.set('');
    this.registrationNumber.set('');
    this.vatNumber.set('');
    this.taxOffice.set('');
    this.line1.set('');
    this.line2.set('');
    this.city.set('');
    this.postcode.set('');
    this.countryCode.set('');
    this.timezone.set('');
    this.currency.set('');
    this.defaultLocale.set('en');
    this.documentLanguage.set('en');
    this.paymentTermsDays.set('');
  }

  private currentSnapshot(): Snapshot {
    return {
      version: this.version,
      legalName: this.legalName(),
      tradingName: this.tradingName(),
      registrationNumber: this.registrationNumber(),
      vatNumber: this.vatNumber(),
      taxOffice: this.taxOffice(),
      line1: this.line1(),
      line2: this.line2(),
      city: this.city(),
      postcode: this.postcode(),
      countryCode: this.countryCode(),
      timezone: this.timezone(),
      defaultCurrency: this.currency(),
      defaultLocale: this.defaultLocale(),
      documentLanguage: this.documentLanguage(),
      paymentTermsDays: this.paymentTermsDays(),
    };
  }
}

function addressBody(fields: AddressFields): Record<string, string> {
  // The address is replaced as a whole, so an omitted line2 or postcode is cleared.
  const address: Record<string, string> = {
    line1: fields.line1.trim(),
    city: fields.city.trim(),
    countryCode: fields.countryCode.trim().toUpperCase(),
  };
  const line2 = fields.line2.trim();
  const postcode = fields.postcode.trim();
  if (line2.length > 0) {
    address['line2'] = line2;
  }
  if (postcode.length > 0) {
    address['postcode'] = postcode;
  }
  return address;
}

function readAddress(value: unknown): AddressFields {
  if (typeof value !== 'object' || value === null) {
    return { line1: '', line2: '', city: '', postcode: '', countryCode: '' };
  }
  const record = value as Record<string, unknown>;
  return {
    line1: text(record['line1']),
    line2: text(record['line2']),
    city: text(record['city']),
    postcode: text(record['postcode']),
    countryCode: text(record['countryCode']),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
