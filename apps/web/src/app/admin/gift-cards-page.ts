import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Button } from 'primeng/button';
import { of } from 'rxjs';
import { readApiError } from '../core/api-error';
import { CompanyContextStore } from '../core/company-context.store';
import { fieldValue } from '../orders/field-value';

type Align = 'left' | 'center';
type VerticalAlign = 'top' | 'middle';

type TemplateView = {
  id: string;
  name: string;
  pageWidthMm: string;
  pageHeightMm: string;
  marginTopMm: string;
  marginRightMm: string;
  marginBottomMm: string;
  marginLeftMm: string;
  fontSizePt: string;
  minFontSizePt: string;
  lineHeight: string;
  align: Align;
  verticalAlign: VerticalAlign;
  isDefault: boolean;
};

const MEASURES = [
  'pageWidthMm',
  'pageHeightMm',
  'marginTopMm',
  'marginRightMm',
  'marginBottomMm',
  'marginLeftMm',
  'fontSizePt',
  'minFontSizePt',
  'lineHeight',
] as const;

type Measure = (typeof MEASURES)[number];

/** The shop's Zebra ZD230: a 100 × 150 mm portrait label, 203 dpi, 104 mm print width. */
export const ZEBRA_PRESET: Record<Measure, string> & { align: Align; verticalAlign: VerticalAlign } = {
  pageWidthMm: '100.00',
  pageHeightMm: '150.00',
  marginTopMm: '5.00',
  marginRightMm: '5.00',
  marginBottomMm: '5.00',
  marginLeftMm: '5.00',
  fontSizePt: '16.00',
  minFontSizePt: '9.00',
  lineHeight: '1.250',
  align: 'center',
  verticalAlign: 'middle',
};

const MIN_MARGIN_MM = 3;
const MIN_LEGIBLE_PT = 8;
const ZEBRA_PRINT_WIDTH_MM = 104;
const SAMPLE = 'Χρόνια πολλά, Μαρία!\n\nΜε αγάπη,\nΓιώργος & Ελένη';

/**
 * The gift-card layout: page size, margins, font sizes and alignment of the company's templates.
 * Text is always black. A preview renders sample text with the saved template.
 * The form is bound to the company it loaded for, and is disabled while a request runs.
 */
@Component({
  selector: 'bp-gift-cards-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, Button],
  template: `
    <section class="screen">
      <h1>{{ 'giftCards.title' | transloco }}</h1>
      <p>{{ 'giftCards.intro' | transloco }}</p>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p role="status">{{ notice() }}</p>
      }
      @if (loaded() && templates().length === 0 && !error()) {
        <p role="status" data-testid="no-template">{{ 'giftCards.empty' | transloco }}</p>
      }
      @if (templates().length > 1) {
        <label>
          {{ 'giftCards.template' | transloco }}
          <select [disabled]="busy()" (change)="choose(field($event))">
            @for (item of templates(); track item.id) {
              <option [value]="item.id" [selected]="item.id === selectedId()">
                {{ item.name }}
                @if (item.isDefault) {
                  ({{ 'giftCards.default' | transloco }})
                }
              </option>
            }
          </select>
        </label>
      }
      @if (selectedId()) {
        <p-button
          type="button"
          data-testid="zebra-preset"
          [label]="'giftCards.zebraPreset' | transloco"
          [disabled]="busy()"
          (onClick)="applyZebra()"
        />
        <form class="form-grid" (submit)="$event.preventDefault()">
          @for (measure of measures; track measure) {
            <label>
              {{ 'giftCards.fields.' + measure | transloco }}
              <input
                inputmode="decimal"
                [attr.data-testid]="measure"
                [value]="values()[measure]"
                [disabled]="busy()"
                (input)="set(measure, field($event))"
              />
            </label>
          }
          <label>
            {{ 'giftCards.fields.align' | transloco }}
            <select [disabled]="busy()" (change)="align.set(alignOf(field($event)))">
              <option value="center" [selected]="align() === 'center'">{{ 'giftCards.center' | transloco }}</option>
              <option value="left" [selected]="align() === 'left'">{{ 'giftCards.left' | transloco }}</option>
            </select>
          </label>
          <label>
            {{ 'giftCards.fields.verticalAlign' | transloco }}
            <select [disabled]="busy()" (change)="verticalAlign.set(verticalOf(field($event)))">
              <option value="middle" [selected]="verticalAlign() === 'middle'">{{ 'giftCards.middle' | transloco }}</option>
              <option value="top" [selected]="verticalAlign() === 'top'">{{ 'giftCards.top' | transloco }}</option>
            </select>
          </label>
        </form>
        <ul data-testid="warnings">
          @for (warning of warnings(); track warning) {
            <li>{{ 'giftCards.warnings.' + warning | transloco }}</li>
          }
        </ul>
        <p-button
          type="button"
          [label]="'giftCards.save' | transloco"
          [disabled]="busy() || !dirty()"
          (onClick)="save()"
        />
        <label>
          {{ 'giftCards.sample' | transloco }}
          <textarea rows="5" data-testid="sample" [value]="sample()" [disabled]="busy()" (input)="sample.set(field($event))"></textarea>
        </label>
        <p-button
          type="button"
          data-testid="preview"
          [label]="'giftCards.preview' | transloco"
          [disabled]="busy() || dirty() || sample().length === 0"
          (onClick)="preview()"
        />
        @if (dirty()) {
          <p>{{ 'giftCards.saveFirst' | transloco }}</p>
        }
        @if (unsupported() > 0) {
          <p role="alert" data-testid="unsupported">
            {{ 'giftCards.unsupported' | transloco: { count: unsupported() } }}
          </p>
        }
        @if (previewUrl(); as url) {
          <a data-testid="preview-link" [href]="url" target="_blank" rel="noopener">{{
            'giftCards.openPreview' | transloco
          }}</a>
        }
      }
    </section>
  `,
})
export class GiftCardsPage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly transloco = inject(TranslocoService);
  private readonly destroyRef = inject(DestroyRef);
  readonly context = inject(CompanyContextStore);

  readonly measures = MEASURES;
  readonly companyId = signal('');
  readonly templates = signal<readonly TemplateView[]>([]);
  readonly selectedId = signal('');
  readonly values = signal<Record<Measure, string>>(blankValues());
  readonly align = signal<Align>('center');
  readonly verticalAlign = signal<VerticalAlign>('middle');
  readonly sample = signal(SAMPLE);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  /** True once the template list for this company has come back. */
  readonly loaded = signal(false);
  /** Characters in the last preview that the card font cannot draw. */
  readonly unsupported = signal(0);
  /** A blob URL for the last preview PDF, opened by the user from a link. */
  readonly previewUrl = signal<string | null>(null);

  /** Changes with the company. An answer for an earlier company is dropped. */
  private generation = 0;
  private boundCompanyId: string | null = null;

  readonly selected = computed(() => this.templates().find((item) => item.id === this.selectedId()) ?? null);

  readonly dirty = computed(() => {
    const saved = this.selected();
    if (!saved) {
      return false;
    }
    const values = this.values();
    return (
      MEASURES.some((measure) => values[measure] !== saved[measure]) ||
      this.align() !== saved.align ||
      this.verticalAlign() !== saved.verticalAlign
    );
  });

  readonly warnings = computed(() => {
    const values = this.values();
    const found: string[] = [];
    const margins = [values.marginTopMm, values.marginRightMm, values.marginBottomMm, values.marginLeftMm];
    if (margins.some((margin) => Number(margin) < MIN_MARGIN_MM)) {
      found.push('margin');
    }
    if (Number(values.minFontSizePt) < MIN_LEGIBLE_PT) {
      found.push('font');
    }
    if (Number(values.pageWidthMm) > ZEBRA_PRINT_WIDTH_MM) {
      found.push('width');
    }
    return found;
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.clearPreview();
    });
    const companyId$ = this.route.parent?.paramMap ?? of(convertToParamMap({}));
    companyId$.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.open(params.get('companyId') ?? '');
    });
  }

  field(event: Event): string {
    return fieldValue(event);
  }

  alignOf(value: string): Align {
    return value === 'left' ? 'left' : 'center';
  }

  verticalOf(value: string): VerticalAlign {
    return value === 'top' ? 'top' : 'middle';
  }

  set(measure: Measure, value: string): void {
    this.values.update((current) => ({ ...current, [measure]: value }));
  }

  choose(id: string): void {
    const template = this.templates().find((item) => item.id === id);
    if (template) {
      this.show(template);
    }
  }

  applyZebra(): void {
    const { align, verticalAlign, ...measures } = ZEBRA_PRESET;
    this.values.set({ ...measures });
    this.align.set(align);
    this.verticalAlign.set(verticalAlign);
  }

  save(): void {
    const companyId = this.boundCompanyId;
    const saved = this.selected();
    if (!companyId || companyId !== this.companyId() || !saved || this.busy() || !this.dirty()) {
      return;
    }
    const generation = this.generation;
    const body = { ...this.values(), align: this.align(), verticalAlign: this.verticalAlign() };
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    this.http
      .patch<{ template: TemplateView }>(`/api/c/${companyId}/gift-message-templates/${saved.id}`, body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.templates.update((list) => list.map((item) => (item.id === response.template.id ? response.template : item)));
          this.show(response.template);
          this.notice.set(this.transloco.translate('giftCards.saved'));
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          this.error.set(this.explain(error));
        },
      });
  }

  /**
   * Renders the sample with the saved template and offers the PDF as a link. A link, not
   * window.open: a slow render would outlast the click and the browser would block the tab.
   */
  preview(): void {
    const companyId = this.boundCompanyId;
    const saved = this.selected();
    const text = this.sample();
    if (!companyId || companyId !== this.companyId() || !saved || this.busy() || this.dirty() || text.length === 0) {
      return;
    }
    const generation = this.generation;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    this.clearPreview();
    this.http
      .post(`/api/c/${companyId}/gift-message-templates/${saved.id}/preview`, { text }, {
        observe: 'response',
        responseType: 'blob',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.busy.set(false);
          const fits = response.headers.get('X-Gift-Fits') === 'true';
          this.notice.set(this.transloco.translate(fits ? 'giftCards.fits' : 'giftCards.overflows'));
          this.unsupported.set(Number(response.headers.get('X-Gift-Unsupported') ?? '0') || 0);
          if (response.body) {
            this.previewUrl.set(URL.createObjectURL(response.body));
          }
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          void this.explainBlobError(error).then((message) => {
            if (generation !== this.generation) {
              return;
            }
            this.busy.set(false);
            this.error.set(message);
          });
        },
      });
  }

  private clearPreview(): void {
    const url = this.previewUrl();
    if (url) {
      URL.revokeObjectURL(url);
    }
    this.previewUrl.set(null);
    this.unsupported.set(0);
  }

  /** A blob request delivers its JSON error envelope as a Blob; read it before explaining. */
  private async explainBlobError(error: unknown): Promise<string> {
    if (error instanceof HttpErrorResponse && error.error instanceof Blob) {
      try {
        const body: unknown = JSON.parse(await readBlobText(error.error));
        return this.explain(new HttpErrorResponse({ error: body, status: error.status }));
      } catch {
        return this.explain(error);
      }
    }
    return this.explain(error);
  }

  private open(companyId: string): void {
    this.generation += 1;
    this.companyId.set(companyId);
    this.boundCompanyId = null;
    this.templates.set([]);
    this.selectedId.set('');
    this.values.set(blankValues());
    this.clearPreview();
    this.busy.set(false);
    this.error.set('');
    this.notice.set('');
    this.loaded.set(false);
    if (!companyId) {
      return;
    }
    const generation = this.generation;
    this.http
      .get<{ templates: TemplateView[] }>(`/api/c/${companyId}/gift-message-templates`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          if (generation !== this.generation) {
            return;
          }
          this.boundCompanyId = companyId;
          this.loaded.set(true);
          this.templates.set(response.templates);
          const first = response.templates.find((item) => item.isDefault) ?? response.templates[0];
          if (first) {
            this.show(first);
          }
        },
        error: (error: unknown) => {
          if (generation !== this.generation) {
            return;
          }
          this.error.set(this.explain(error));
        },
      });
  }

  private show(template: TemplateView): void {
    this.selectedId.set(template.id);
    const values = blankValues();
    for (const measure of MEASURES) {
      values[measure] = template[measure];
    }
    this.values.set(values);
    this.align.set(template.align);
    this.verticalAlign.set(template.verticalAlign);
  }

  private explain(error: unknown): string {
    const api = error instanceof HttpErrorResponse ? readApiError(error) : null;
    const base =
      error instanceof HttpErrorResponse && error.status === 403
        ? this.transloco.translate('giftCards.forbidden')
        : error instanceof HttpErrorResponse && error.status === 400 && api?.message
        ? `${this.transloco.translate('giftCards.invalid')} ${api.message}`
        : error instanceof HttpErrorResponse && error.status === 400
          ? this.transloco.translate('giftCards.invalid')
          : this.transloco.translate('giftCards.error');
    return api?.correlationId
      ? `${base} (${this.transloco.translate('errors.correlation')}: ${api.correlationId})`
      : base;
  }
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('blob read failed'));
    };
    reader.readAsText(blob);
  });
}

function blankValues(): Record<Measure, string> {
  return {
    pageWidthMm: '',
    pageHeightMm: '',
    marginTopMm: '',
    marginRightMm: '',
    marginBottomMm: '',
    marginLeftMm: '',
    fontSizePt: '',
    minFontSizePt: '',
    lineHeight: '',
  };
}
