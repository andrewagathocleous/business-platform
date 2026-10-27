import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { combineLatest, of } from 'rxjs';
import { isVersionConflict, readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { canAttempt } from '../core/nav';
import { NAVIGATE_ON_DENIED } from '../core/navigate-on-denied';
import { dropNavigationKey, navigationState } from '../core/navigation-state';
import { fieldValue } from '../orders/field-value';
import {
  type AddressDraft,
  type AddressKind,
  type ClientDraft,
  type ClientKind,
  type ContactDraft,
  changeAddressKind,
  clientErrors,
  clientWrite,
  duplicateCheckPayload,
  duplicateFieldsChanged,
  emptyClientDraft,
  setDefaultAddress,
  setPrimary,
} from './client-draft';

type ClientView = {
  id: string;
  kind: ClientKind;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  defaultCurrency: string | null;
  defaultLanguage: string | null;
  paymentTermsDays: number | null;
  archivedAt: string | null;
  version: number;
  contacts: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    position: string | null;
    isPrimary: boolean;
  }[];
  addresses: {
    id: string;
    kind: AddressKind;
    label: string | null;
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string | null;
    countryCode: string;
    isDefault: boolean;
  }[];
};

type DuplicateMatch = {
  id: string;
  displayName: string;
  archivedAt: string | null;
};

@Component({
  selector: 'bp-client-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RouterLink, Button],
  template: `
    <section class="screen">
      @if (conflict(); as item) {
        <div class="app-toast" role="alert">
          <p>{{ 'clients.conflict' | transloco }}</p>
          @if (item.correlationId) {
            <p>{{ 'errors.correlation' | transloco }}: {{ item.correlationId }}</p>
          }
          <p-button type="button" [label]="'common.reload' | transloco" (onClick)="reload()" />
        </div>
      }
      <p>
        <a [routerLink]="['/c', companyId(), 'clients']">{{ 'clients.title' | transloco }}</a>
      </p>
      <h1>{{ (clientId() ? 'clients.editTitle' : 'clients.newTitle') | transloco }}</h1>
      @if (loading()) {
        <p role="status">{{ 'clients.loading' | transloco }}</p>
      }
      @if (error()) {
        <p role="alert">{{ 'clients.error' | transloco }}</p>
      }
      @if (!loading() && !error()) {
        <form class="form-grid" (submit)="$event.preventDefault(); save()">
          <label>
            {{ 'clients.fields.kind' | transloco }}
            <select [disabled]="!canManage()" (change)="setKind($event)">
              <option value="organisation" [selected]="draft().kind === 'organisation'">
                {{ 'clients.kind.organisation' | transloco }}
              </option>
              <option value="individual" [selected]="draft().kind === 'individual'">
                {{ 'clients.kind.individual' | transloco }}
              </option>
            </select>
          </label>
          <label>
            {{ 'clients.fields.displayName' | transloco }}
            <input
              [disabled]="!canManage()"
              [value]="draft().displayName"
              (input)="setText('displayName', $event)"
            />
          </label>
          @if (errorFor('displayName'); as key) {
            <p class="field-error" role="alert">{{ key | transloco }}</p>
          }
          @if (draft().kind === 'organisation') {
            <label>
              {{ 'clients.fields.legalName' | transloco }}
              <input
                [disabled]="!canManage()"
                [value]="draft().legalName"
                (input)="setText('legalName', $event)"
              />
            </label>
            @if (errorFor('legalName'); as key) {
              <p class="field-error" role="alert">{{ key | transloco }}</p>
            }
            <label>
              {{ 'clients.fields.vatNumber' | transloco }}
              <input
                [disabled]="!canManage()"
                [value]="draft().vatNumber"
                (input)="setText('vatNumber', $event)"
              />
            </label>
            @if (errorFor('vatNumber'); as key) {
              <p class="field-error" role="alert">{{ key | transloco }}</p>
            }
          }
          <label>
            {{ 'clients.fields.taxId' | transloco }}
            <input
              [disabled]="!canManage()"
              [value]="draft().taxId"
              (input)="setText('taxId', $event)"
            />
          </label>
          <label>
            {{ 'clients.fields.email' | transloco }}
            <input
              [disabled]="!canManage()"
              [value]="draft().email"
              (input)="setText('email', $event)"
            />
          </label>
          @if (errorFor('email'); as key) {
            <p class="field-error" role="alert">{{ key | transloco }}</p>
          }
          <label>
            {{ 'clients.fields.phone' | transloco }}
            <input
              [disabled]="!canManage()"
              [value]="draft().phone"
              (input)="setText('phone', $event)"
            />
          </label>
          <label>
            {{ 'clients.fields.website' | transloco }}
            <input
              [disabled]="!canManage()"
              [value]="draft().website"
              (input)="setText('website', $event)"
            />
          </label>
          <label class="span-all">
            {{ 'clients.fields.notes' | transloco }}
            <textarea
              [disabled]="!canManage()"
              [value]="draft().notes"
              (input)="setText('notes', $event)"
            ></textarea>
          </label>
          <label>
            {{ 'clients.fields.currency' | transloco }}
            <input
              [disabled]="!canManage()"
              [value]="draft().defaultCurrency"
              (input)="setText('defaultCurrency', $event)"
            />
          </label>
          @if (errorFor('defaultCurrency'); as key) {
            <p class="field-error" role="alert">{{ key | transloco }}</p>
          }
          <label>
            {{ 'clients.fields.language' | transloco }}
            <select [disabled]="!canManage()" (change)="setLanguage($event)">
              <option value="en" [selected]="draft().defaultLanguage === 'en'">
                {{ 'clients.language.en' | transloco }}
              </option>
              <option value="el" [selected]="draft().defaultLanguage === 'el'">
                {{ 'clients.language.el' | transloco }}
              </option>
            </select>
          </label>
          <label>
            {{ 'clients.fields.terms' | transloco }}
            <input
              inputmode="numeric"
              [disabled]="!canManage()"
              [value]="draft().paymentTermsDays"
              (input)="setText('paymentTermsDays', $event)"
            />
          </label>
          @if (errorFor('paymentTermsDays'); as key) {
            <p class="field-error" role="alert">{{ key | transloco }}</p>
          }

          <fieldset class="repeat span-all">
            <legend>{{ 'clients.contacts' | transloco }}</legend>
            @for (contact of draft().contacts; track contact.key; let index = $index) {
              <article class="repeat-item">
                <header class="repeat-head">
                  <h3>
                    {{ 'clients.contactHeading' | transloco: { position: index + 1 } }}
                    @if (contact.isPrimary) {
                      · {{ 'clients.primaryMark' | transloco }}
                    }
                  </h3>
                  @if (canManage()) {
                    <p-button
                      type="button"
                      size="small"
                      severity="danger"
                      [label]="'clients.removeContact' | transloco"
                      (onClick)="removeContact(index)"
                    />
                  }
                </header>
                <div class="form-grid">
                  <label>
                    {{ 'clients.fields.contactName' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="contact.name"
                      (input)="setContact(index, 'name', $event)"
                    />
                  </label>
                  @if (errorFor('contacts.' + index + '.name'); as key) {
                    <p class="field-error span-all" role="alert">{{ key | transloco }}</p>
                  }
                  <label>
                    {{ 'clients.fields.email' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="contact.email"
                      (input)="setContact(index, 'email', $event)"
                    />
                  </label>
                  <label>
                    {{ 'clients.fields.phone' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="contact.phone"
                      (input)="setContact(index, 'phone', $event)"
                    />
                  </label>
                  <label>
                    {{ 'clients.fields.position' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="contact.position"
                      (input)="setContact(index, 'position', $event)"
                    />
                  </label>
                  <label class="check span-all">
                    <input
                      type="checkbox"
                      name="primary-contact"
                      [disabled]="!canManage()"
                      [checked]="contact.isPrimary"
                      (change)="onPrimary(index, $event)"
                    />
                    {{ 'clients.fields.primary' | transloco }}
                  </label>
                </div>
              </article>
            }
            @if (canManage()) {
              <div class="form-actions">
                <p-button
                  type="button"
                  severity="secondary"
                  icon="pi pi-plus"
                  [label]="'clients.addContact' | transloco"
                  [ariaLabel]="'clients.addContact' | transloco"
                  (onClick)="addContact()"
                />
              </div>
            }
          </fieldset>

          <fieldset class="repeat span-all">
            <legend>{{ 'clients.addresses' | transloco }}</legend>
            @if (errorFor('addresses'); as key) {
              <p class="field-error" role="alert">{{ key | transloco }}</p>
            }
            @for (address of draft().addresses; track address.key; let index = $index) {
              <article class="repeat-item">
                <header class="repeat-head">
                  <h3>{{ 'clients.addressHeading' | transloco: { position: index + 1 } }}</h3>
                  @if (canManage()) {
                    <p-button
                      type="button"
                      size="small"
                      severity="danger"
                      [label]="'clients.removeAddress' | transloco"
                      (onClick)="removeAddress(index)"
                    />
                  }
                </header>
                <div class="form-grid">
                  <label>
                    {{ 'clients.fields.addressKind' | transloco }}
                    <select [disabled]="!canManage()" (change)="setAddressKind(index, $event)">
                      <option value="billing" [selected]="address.kind === 'billing'">
                        {{ 'clients.addressKind.billing' | transloco }}
                      </option>
                      <option value="shipping" [selected]="address.kind === 'shipping'">
                        {{ 'clients.addressKind.shipping' | transloco }}
                      </option>
                    </select>
                  </label>
                  <label>
                    {{ 'clients.fields.label' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.label"
                      (input)="setAddress(index, 'label', $event)"
                    />
                  </label>
                  <label>
                    {{ 'clients.fields.line1' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.line1"
                      (input)="setAddress(index, 'line1', $event)"
                    />
                  </label>
                  @if (errorFor('addresses.' + index + '.line1'); as key) {
                    <p class="field-error" role="alert">{{ key | transloco }}</p>
                  }
                  <label>
                    {{ 'clients.fields.line2' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.line2"
                      (input)="setAddress(index, 'line2', $event)"
                    />
                  </label>
                  <label>
                    {{ 'clients.fields.city' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.city"
                      (input)="setAddress(index, 'city', $event)"
                    />
                  </label>
                  @if (errorFor('addresses.' + index + '.city'); as key) {
                    <p class="field-error" role="alert">{{ key | transloco }}</p>
                  }
                  <label>
                    {{ 'clients.fields.region' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.region"
                      (input)="setAddress(index, 'region', $event)"
                    />
                  </label>
                  <label>
                    {{ 'clients.fields.postalCode' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.postalCode"
                      (input)="setAddress(index, 'postalCode', $event)"
                    />
                  </label>
                  <label>
                    {{ 'clients.fields.country' | transloco }}
                    <input
                      [disabled]="!canManage()"
                      [value]="address.countryCode"
                      (input)="setAddress(index, 'countryCode', $event)"
                    />
                  </label>
                  @if (errorFor('addresses.' + index + '.countryCode'); as key) {
                    <p class="field-error" role="alert">{{ key | transloco }}</p>
                  }
                  <label class="check">
                    <input
                      type="checkbox"
                      [attr.name]="'default-' + address.kind"
                      [disabled]="!canManage()"
                      [checked]="address.isDefault"
                      (change)="onDefault(index, $event)"
                    />
                    {{ 'clients.fields.defaultAddress' | transloco }}
                  </label>
                </div>
              </article>
            }
            @if (canManage()) {
              <div class="form-actions">
                <p-button
                  type="button"
                  severity="secondary"
                  icon="pi pi-plus"
                  [label]="'clients.addAddress' | transloco"
                  [ariaLabel]="'clients.addAddress' | transloco"
                  (onClick)="addAddress()"
                />
              </div>
            }
          </fieldset>

          @if (canManage()) {
            <div class="actions span-all">
              <p-button
                type="submit"
                [label]="'clients.save' | transloco"
                [disabled]="busy()"
                (onClick)="save()"
              />
              @if (clientId() && archivedAt() === null) {
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'clients.archive' | transloco"
                  [disabled]="busy()"
                  (onClick)="archive(true)"
                />
              }
              @if (clientId() && archivedAt() !== null) {
                <p-button
                  type="button"
                  severity="secondary"
                  [label]="'clients.unarchive' | transloco"
                  [disabled]="busy()"
                  (onClick)="archive(false)"
                />
              }
            </div>
          }
        </form>
      }
      @if (duplicates(); as matches) {
        <div class="modal" role="presentation">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="duplicate-title"
            data-testid="duplicate-dialog"
          >
            <h2 id="duplicate-title">{{ 'clients.duplicateTitle' | transloco }}</h2>
            <ul>
              @for (match of matches; track match.id) {
                <li>
                  <a [routerLink]="['/c', companyId(), 'clients', match.id]">{{
                    match.displayName
                  }}</a>
                </li>
              }
            </ul>
            <div class="actions">
              <p-button
                type="button"
                [label]="'clients.saveAnyway' | transloco"
                [disabled]="busy()"
                (onClick)="saveAnyway()"
              />
              <p-button
                type="button"
                severity="secondary"
                [label]="'clients.back' | transloco"
                (onClick)="dismissDuplicates()"
              />
            </div>
          </div>
        </div>
      }
    </section>
  `,
})
export class ClientFormPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly context = inject(CompanyContextStore);
  private keySeq = 0;
  private generation = 0;
  private draftRevision = 0;

  readonly companyId = signal('');
  readonly clientId = signal<string | null>(null);
  readonly draft = signal<ClientDraft>(emptyClientDraft());
  readonly errors = signal<Record<string, string>>({});
  readonly conflict = signal<{ correlationId: string | null } | null>(null);
  readonly duplicates = signal<DuplicateMatch[] | null>(null);
  readonly archivedAt = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal(false);
  readonly busy = signal(false);
  private baseline: ClientDraft | null = null;
  private version: number | null = null;

  constructor() {
    const companyId$ = this.route.parent?.paramMap ?? of(emptyParams());
    combineLatest([companyId$, this.route.paramMap])
      .pipe(takeUntilDestroyed())
      .subscribe(([company, params]) => {
        this.open(company.get('companyId') ?? '', params.get('clientId'));
      });
  }

  open(companyId: string, clientId: string | null): void {
    const changed = companyId !== this.companyId() || clientId !== this.clientId();
    this.companyId.set(companyId);
    this.clientId.set(clientId);
    if (companyId.length === 0) {
      this.loading.set(false);
      return;
    }
    if (changed) {
      this.generation += 1;
      this.conflict.set(null);
      this.duplicates.set(null);
      this.errors.set({});
      this.error.set(false);
      this.busy.set(false);
      this.baseline = null;
      this.version = null;
      this.archivedAt.set(null);
      this.draft.set(emptyClientDraft());
    }
    if (!clientId) {
      this.loading.set(false);
      return;
    }
    const carried = this.consumeCarriedClient(clientId);
    if (carried) {
      this.draft.set(cloneDraft(carried.draft));
      this.baseline = carried.baseline ? cloneDraft(carried.baseline) : null;
      this.version = carried.version;
      this.archivedAt.set(carried.archivedAt);
      this.loading.set(false);
      this.error.set(false);
      return;
    }
    this.fetch();
  }

  canManage(): boolean {
    return canAttempt(
      this.context.grants(),
      this.context.withheldPermissions(),
      this.context.mfaStepUpRequired(),
      'client.manage',
    );
  }

  errorFor(field: string): string | null {
    return this.errors()[field] ?? null;
  }

  setKind(event: Event): void {
    this.touch();
    const value = fieldValue(event);
    const kind: ClientKind = value === 'individual' ? 'individual' : 'organisation';
    this.draft.update((current) => ({ ...current, kind }));
  }

  setLanguage(event: Event): void {
    this.touch();
    const value = fieldValue(event);
    const defaultLanguage = value === 'el' ? 'el' : 'en';
    this.draft.update((current) => ({ ...current, defaultLanguage }));
  }

  setText(
    field:
      | 'displayName'
      | 'legalName'
      | 'vatNumber'
      | 'taxId'
      | 'email'
      | 'phone'
      | 'website'
      | 'notes'
      | 'defaultCurrency'
      | 'paymentTermsDays',
    event: Event,
  ): void {
    this.touch();
    const value = fieldValue(event);
    this.draft.update((current) => ({ ...current, [field]: value }));
  }

  addContact(): void {
    this.touch();
    const contact: ContactDraft = {
      key: this.nextKey(),
      id: '',
      name: '',
      email: '',
      phone: '',
      position: '',
      isPrimary: false,
    };
    this.draft.update((current) => ({ ...current, contacts: [...current.contacts, contact] }));
  }

  removeContact(index: number): void {
    this.touch();
    this.draft.update((current) => ({
      ...current,
      contacts: current.contacts.filter((_, item) => item !== index),
    }));
  }

  setContact(index: number, field: 'name' | 'email' | 'phone' | 'position', event: Event): void {
    this.touch();
    const value = fieldValue(event);
    this.draft.update((current) => ({
      ...current,
      contacts: current.contacts.map((contact, item) =>
        item === index ? { ...contact, [field]: value } : contact,
      ),
    }));
  }

  onPrimary(index: number, event: Event): void {
    this.touch();
    const target = event.target;
    const checked = target instanceof HTMLInputElement && target.checked;
    this.draft.update((current) => ({
      ...current,
      contacts: setPrimary(current.contacts, index, checked),
    }));
  }

  addAddress(): void {
    this.touch();
    const address: AddressDraft = {
      key: this.nextKey(),
      id: '',
      kind: 'billing',
      label: '',
      line1: '',
      line2: '',
      city: '',
      region: '',
      postalCode: '',
      countryCode: '',
      isDefault: false,
    };
    this.draft.update((current) => ({ ...current, addresses: [...current.addresses, address] }));
  }

  removeAddress(index: number): void {
    this.touch();
    this.draft.update((current) => ({
      ...current,
      addresses: current.addresses.filter((_, item) => item !== index),
    }));
  }

  setAddressKind(index: number, event: Event): void {
    this.touch();
    const kind: AddressKind = fieldValue(event) === 'shipping' ? 'shipping' : 'billing';
    this.draft.update((current) => ({
      ...current,
      addresses: changeAddressKind(current.addresses, index, kind),
    }));
  }

  setAddress(
    index: number,
    field: 'label' | 'line1' | 'line2' | 'city' | 'region' | 'postalCode' | 'countryCode',
    event: Event,
  ): void {
    this.touch();
    const value = fieldValue(event);
    this.draft.update((current) => ({
      ...current,
      addresses: current.addresses.map((address, item) =>
        item === index ? { ...address, [field]: value } : address,
      ),
    }));
  }

  onDefault(index: number, event: Event): void {
    this.touch();
    const target = event.target;
    const checked = target instanceof HTMLInputElement && target.checked;
    this.draft.update((current) => ({
      ...current,
      addresses: setDefaultAddress(current.addresses, index, checked),
    }));
  }

  save(): void {
    if (!this.canManage() || !this.begin()) {
      return;
    }
    const errors = clientErrors(this.draft());
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) {
      this.busy.set(false);
      return;
    }
    if (this.needsDuplicateCheck()) {
      this.checkDuplicates();
      return;
    }
    this.persist();
  }

  saveAnyway(): void {
    this.duplicates.set(null);
    if (!this.begin()) {
      return;
    }
    this.persist();
  }

  dismissDuplicates(): void {
    this.duplicates.set(null);
  }

  archive(archived: boolean): void {
    const clientId = this.clientId();
    if (!clientId || this.version === null || !this.begin()) {
      return;
    }
    const generation = this.generation;
    this.http
      .patch<{ client: ClientView }>(`/api/c/${this.companyId()}/clients/${clientId}`, {
        expectedVersion: this.version,
        archived,
      })
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.version = body.client.version;
          this.archivedAt.set(body.client.archivedAt);
          this.conflict.set(null);
          this.busy.set(false);
        },
        error: (error: unknown) => {
          this.fail(generation, error);
        },
      });
  }

  reload(): void {
    this.conflict.set(null);
    if (this.clientId()) {
      this.fetch();
      return;
    }
    this.draft.set(emptyClientDraft());
  }

  private needsDuplicateCheck(): boolean {
    const current = this.draft();
    if (!this.clientId() || !this.baseline) {
      return true;
    }
    return duplicateFieldsChanged(this.baseline, current);
  }

  private checkDuplicates(): void {
    const snapshot = cloneDraft(this.draft());
    const clientId = this.clientId();
    const body = clientId
      ? { ...duplicateCheckPayload(snapshot), excludeClientId: clientId }
      : duplicateCheckPayload(snapshot);
    const generation = this.generation;
    this.http
      .post<{ matches: DuplicateMatch[] }>(
        `/api/c/${this.companyId()}/clients/duplicate-check`,
        body,
      )
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          if (duplicateFieldsChanged(snapshot, this.draft())) {
            this.checkDuplicates();
            return;
          }
          if (response.matches.length > 0) {
            this.duplicates.set(response.matches);
            this.busy.set(false);
            return;
          }
          this.persist();
        },
        error: (error: unknown) => {
          this.fail(generation, error);
        },
      });
  }

  private persist(): void {
    const write = clientWrite(this.draft());
    if (!write) {
      this.busy.set(false);
      return;
    }
    const submitted = cloneDraft(this.draft());
    const generation = this.generation;
    const revision = this.draftRevision;
    const clientId = this.clientId();
    const request = clientId
      ? this.http.patch<{ client: ClientView }>(`/api/c/${this.companyId()}/clients/${clientId}`, {
          expectedVersion: this.version ?? 0,
          ...write,
        })
      : this.http.post<{ client: ClientView }>(`/api/c/${this.companyId()}/clients`, write);
    request.subscribe({
      next: (body) => {
        if (generation !== this.generation) {
          return;
        }
        this.busy.set(false);
        if (!clientId) {
          this.openCreated(body.client, revision, submitted);
          return;
        }
        if (revision === this.draftRevision) {
          this.apply(body.client);
          return;
        }
        this.version = body.client.version;
        this.archivedAt.set(body.client.archivedAt);
      },
      error: (error: unknown) => {
        this.fail(generation, error);
      },
    });
  }

  private openCreated(client: ClientView, revision: number, submitted: ClientDraft): void {
    const commands = ['/c', this.companyId(), 'clients', client.id];
    if (revision === this.draftRevision) {
      void this.router.navigate(commands);
      return;
    }
    void this.router.navigate(commands, {
      state: {
        carriedClient: {
          id: client.id,
          version: client.version,
          archivedAt: client.archivedAt,
          draft: cloneDraft(this.draft()),
          baseline: submitted,
        },
      },
    });
  }

  private consumeCarriedClient(clientId: string): CarriedClient | null {
    const state = navigationState(this.router);
    const carried = carriedClientFrom(state?.['carriedClient']);
    if (!carried || carried.id !== clientId) {
      return null;
    }
    dropNavigationKey(state, 'carriedClient');
    return carried;
  }

  private fetch(): void {
    const clientId = this.clientId();
    if (!clientId) {
      return;
    }
    const generation = ++this.generation;
    this.loading.set(this.version === null);
    this.http
      .get<{ client: ClientView }>(`/api/c/${this.companyId()}/clients/${clientId}`, {
        context: new HttpContext().set(NAVIGATE_ON_DENIED, true),
      })
      .subscribe({
        next: (body) => {
          if (generation !== this.generation) {
            return;
          }
          this.apply(body.client);
          this.loading.set(false);
        },
        error: () => {
          if (generation !== this.generation) {
            return;
          }
          this.loading.set(false);
          if (this.version === null) {
            this.error.set(true);
          }
        },
      });
  }

  private apply(view: ClientView): void {
    const draft = this.toDraft(view);
    this.draft.set(draft);
    this.baseline = cloneDraft(draft);
    this.version = view.version;
    this.archivedAt.set(view.archivedAt);
    this.conflict.set(null);
    this.duplicates.set(null);
    this.errors.set({});
    this.error.set(false);
  }

  private fail(generation: number, error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    this.busy.set(false);
    if (isVersionConflict(error)) {
      const body = error instanceof HttpErrorResponse ? readApiError(error) : null;
      this.conflict.set({ correlationId: body?.correlationId ?? null });
    }
  }

  private touch(): void {
    this.draftRevision += 1;
  }

  private begin(): boolean {
    if (this.busy()) {
      return false;
    }
    this.busy.set(true);
    return true;
  }

  private toDraft(view: ClientView): ClientDraft {
    const language = view.defaultLanguage === 'el' ? 'el' : 'en';
    return {
      kind: view.kind,
      displayName: view.displayName,
      legalName: view.legalName ?? '',
      vatNumber: view.vatNumber ?? '',
      taxId: view.taxId ?? '',
      email: view.email ?? '',
      phone: view.phone ?? '',
      website: view.website ?? '',
      notes: view.notes ?? '',
      defaultCurrency: view.defaultCurrency ?? '',
      defaultLanguage: language,
      paymentTermsDays: view.paymentTermsDays === null ? '' : String(view.paymentTermsDays),
      contacts: view.contacts.map((contact) => ({
        key: this.nextKey(),
        id: contact.id,
        name: contact.name,
        email: contact.email ?? '',
        phone: contact.phone ?? '',
        position: contact.position ?? '',
        isPrimary: contact.isPrimary,
      })),
      addresses: view.addresses.map((address) => ({
        key: this.nextKey(),
        id: address.id,
        kind: address.kind,
        label: address.label ?? '',
        line1: address.line1,
        line2: address.line2 ?? '',
        city: address.city,
        region: address.region ?? '',
        postalCode: address.postalCode ?? '',
        countryCode: address.countryCode,
        isDefault: address.isDefault,
      })),
    };
  }

  private nextKey(): string {
    this.keySeq += 1;
    return `row-${String(this.keySeq)}`;
  }
}

type CarriedClient = {
  id: string;
  version: number;
  archivedAt: string | null;
  draft: ClientDraft;
  baseline: ClientDraft | null;
};

function carriedClientFrom(value: unknown): CarriedClient | null {
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['version'] !== 'number') {
    return null;
  }
  const archivedAt = value['archivedAt'];
  if (archivedAt !== null && typeof archivedAt !== 'string') {
    return null;
  }
  const draft = value['draft'];
  if (!isClientDraft(draft)) {
    return null;
  }
  const baseline = value['baseline'];
  if (baseline !== null && baseline !== undefined && !isClientDraft(baseline)) {
    return null;
  }
  return {
    id: value['id'],
    version: value['version'],
    archivedAt,
    draft,
    baseline: isClientDraft(baseline) ? baseline : null,
  };
}

function isClientDraft(value: unknown): value is ClientDraft {
  if (!isRecord(value)) {
    return false;
  }
  if (value['kind'] !== 'organisation' && value['kind'] !== 'individual') {
    return false;
  }
  if (value['defaultLanguage'] !== 'en' && value['defaultLanguage'] !== 'el') {
    return false;
  }
  const strings = [
    'displayName',
    'legalName',
    'vatNumber',
    'taxId',
    'email',
    'phone',
    'website',
    'notes',
    'defaultCurrency',
    'paymentTermsDays',
  ];
  if (strings.some((field) => typeof value[field] !== 'string')) {
    return false;
  }
  return Array.isArray(value['contacts']) && Array.isArray(value['addresses']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cloneDraft(draft: ClientDraft): ClientDraft {
  return {
    ...draft,
    contacts: draft.contacts.map((contact) => ({ ...contact })),
    addresses: draft.addresses.map((address) => ({ ...address })),
  };
}

function emptyParams(): { get: (name: string) => string | null } {
  return { get: () => null };
}
