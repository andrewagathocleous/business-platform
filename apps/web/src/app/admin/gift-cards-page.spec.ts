import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { BehaviorSubject, firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { GiftCardsPage, ZEBRA_PRESET } from './gift-cards-page';

const TEMPLATES_URL = '/api/c/company-1/gift-message-templates';
const A6 = {
  id: 'template-1',
  name: 'A6 card',
  pageWidthMm: '148.00',
  pageHeightMm: '105.00',
  marginTopMm: '12.00',
  marginRightMm: '12.00',
  marginBottomMm: '12.00',
  marginLeftMm: '12.00',
  fontSizePt: '16.00',
  minFontSizePt: '10.00',
  lineHeight: '1.200',
  align: 'center',
  verticalAlign: 'middle',
  isDefault: true,
};

describe('GiftCardsPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('fills the Zebra preset and saves it as one patch', async () => {
    const { fixture, http } = await setup();
    http.expectOne(TEMPLATES_URL).flush({ templates: [A6] });
    fixture.detectChanges();
    expect(input(fixture, 'pageWidthMm').value).toBe('148.00');
    expect(fixture.componentInstance.dirty()).toBe(false);
    button(fixture, 'zebra-preset').click();
    fixture.detectChanges();
    expect(input(fixture, 'pageWidthMm').value).toBe('100.00');
    expect(input(fixture, 'pageHeightMm').value).toBe('150.00');
    expect(fixture.componentInstance.dirty()).toBe(true);
    expect(fixture.componentInstance.warnings()).toEqual([]);
    fixture.componentInstance.save();
    const patch = http.expectOne(`${TEMPLATES_URL}/template-1`);
    expect(patch.request.method).toBe('PATCH');
    const { align, verticalAlign, ...measures } = ZEBRA_PRESET;
    expect(patch.request.body).toEqual({ ...measures, align, verticalAlign });
    expect(fixture.componentInstance.busy()).toBe(true);
    patch.flush({ template: { ...A6, ...ZEBRA_PRESET } });
    fixture.detectChanges();
    expect(fixture.componentInstance.busy()).toBe(false);
    expect(fixture.componentInstance.dirty()).toBe(false);
    http.verify();
  });

  it('warns about thin margins, tiny text and a page wider than the Zebra prints', async () => {
    const { fixture, http } = await setup();
    http.expectOne(TEMPLATES_URL).flush({ templates: [A6] });
    fixture.detectChanges();
    expect(fixture.componentInstance.warnings()).toEqual(['width']);
    fixture.componentInstance.set('marginLeftMm', '2.00');
    fixture.componentInstance.set('minFontSizePt', '6.00');
    fixture.detectChanges();
    expect(fixture.componentInstance.warnings()).toEqual(['margin', 'font', 'width']);
    expect(element(fixture).querySelector('[data-testid="warnings"]')?.textContent).toContain('at least 3 mm');
  });

  it('previews the saved template as a link, but not while changes are unsaved', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const { fixture, http } = await setup();
    http.expectOne(TEMPLATES_URL).flush({ templates: [A6] });
    fixture.detectChanges();
    fixture.componentInstance.set('fontSizePt', '18.00');
    fixture.componentInstance.preview();
    expect(http.match(`${TEMPLATES_URL}/template-1/preview`)).toEqual([]);
    fixture.componentInstance.set('fontSizePt', '16.00');
    fixture.componentInstance.sample.set('Hello\nthere');
    fixture.componentInstance.preview();
    const request = http.expectOne(`${TEMPLATES_URL}/template-1/preview`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ text: 'Hello\nthere' });
    request.flush(new Blob(['%PDF-'], { type: 'application/pdf' }), {
      headers: { 'X-Gift-Fits': 'false', 'X-Gift-Unsupported': '1' },
    });
    fixture.detectChanges();
    const link = element(fixture).querySelector('[data-testid="preview-link"]');
    expect(link?.getAttribute('href')).toBe('blob:preview');
    expect(link?.getAttribute('rel')).toBe('noopener');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(fixture.componentInstance.notice()).toContain('does not fit');
    expect(element(fixture).querySelector('[data-testid="unsupported"]')?.textContent).toContain('1 character');
    http.verify();
  });

  it('shows the reason from a JSON error that arrived as a blob', async () => {
    const { fixture, http } = await setup();
    http.expectOne(TEMPLATES_URL).flush({ templates: [A6] });
    fixture.detectChanges();
    fixture.componentInstance.sample.set('x'.repeat(2001));
    fixture.componentInstance.preview();
    const body = JSON.stringify({ error: { code: 'bad_request', message: 'text is too long', correlationId: 'corr-1' } });
    http
      .expectOne(`${TEMPLATES_URL}/template-1/preview`)
      .flush(new Blob([body], { type: 'application/json' }), { status: 400, statusText: 'Bad Request' });
    await vi.waitFor(() => {
      expect(fixture.componentInstance.error()).toContain('text is too long');
    });
    expect(fixture.componentInstance.error()).toContain('corr-1');
    expect(fixture.componentInstance.busy()).toBe(false);
    http.verify();
  });

  it('says when the company has no gift-card template', async () => {
    const { fixture, http } = await setup();
    expect(element(fixture).querySelector('[data-testid="no-template"]')).toBeNull();
    http.expectOne(TEMPLATES_URL).flush({ templates: [] });
    fixture.detectChanges();
    expect(element(fixture).querySelector('[data-testid="no-template"]')?.textContent).toContain(
      'no gift-card template',
    );
    http.verify();
  });

  it('drops a template list that arrives after the company changed', async () => {
    const companies = new BehaviorSubject(convertToParamMap({ companyId: 'company-1' }));
    const { fixture, http } = await setup(companies);
    const first = http.expectOne(TEMPLATES_URL);
    companies.next(convertToParamMap({ companyId: 'company-2' }));
    const second = http.expectOne('/api/c/company-2/gift-message-templates');
    first.flush({ templates: [A6] });
    expect(fixture.componentInstance.templates()).toEqual([]);
    second.flush({ templates: [{ ...A6, id: 'template-2', name: 'Other' }] });
    expect(fixture.componentInstance.selectedId()).toBe('template-2');
    http.verify();
  });
});

async function setup(
  companies = new BehaviorSubject(convertToParamMap({ companyId: 'company-1' })),
): Promise<{ fixture: ComponentFixture<GiftCardsPage>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [GiftCardsPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', reRenderOnLangChange: true, prodMode: true },
        loader: AppTranslocoLoader,
      }),
      {
        provide: ActivatedRoute,
        useValue: {
          parent: { paramMap: companies.asObservable() },
          paramMap: of(convertToParamMap({})),
          snapshot: { paramMap: convertToParamMap({}) },
        },
      },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(['company.manage'].map(grant));
  const fixture = TestBed.createComponent(GiftCardsPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function element(fixture: ComponentFixture<unknown>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  return root;
}

function input(fixture: ComponentFixture<unknown>, id: string): HTMLInputElement {
  const found = element(fixture).querySelector(`[data-testid="${id}"]`);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`missing input ${id}`);
  }
  return found;
}

function button(fixture: ComponentFixture<unknown>, id: string): HTMLButtonElement {
  const found = element(fixture).querySelector(`[data-testid="${id}"] button, button[data-testid="${id}"]`);
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${id}`);
  }
  return found;
}
