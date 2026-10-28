import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyContextStore } from '../core/company-context.store';
import type { Grant } from '../core/models';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { InvoiceEditorPage, PREVIEW_DEBOUNCE_MS } from './invoice-editor';

describe('InvoiceEditorPage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('previews only the latest valid lines and shows nothing while the preview is pending or invalid', async () => {
    const { fixture, http } = await setup();
    vi.useFakeTimers();
    const component = fixture.componentInstance;
    component.open('company-1', null);
    flushCatalog(http);
    fillLine(component, 0, {
      description: 'Nuts',
      quantity: '1,5',
      unit: 'kg',
      unitPrice: '10.005',
      discountPercent: '15',
      taxCodeId: 'tax-1',
    });
    expect(component.previewState()).toBe('pending');
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Totals not calculated yet');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(http.match((request) => request.url.includes('preview-totals'))).toHaveLength(0);
    fillLine(component, 0, { quantity: '10.005' });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(http.match((request) => request.url.includes('preview-totals'))).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const preview = http.expectOne('/api/c/company-1/invoices/preview-totals');
    const body: unknown = preview.request.body;
    if (!isRecord(body) || !Array.isArray(body['lines'])) {
      throw new Error('preview body has no lines');
    }
    const line: unknown = body['lines'][0];
    if (!isRecord(line)) {
      throw new Error('preview line is missing');
    }
    expect(line['quantity']).toBe('10.005');
    expect(line['unitPrice']).toBe('10.005');
    expect(line['discountPercent']).toBe('15');
    expect(typeof line['quantity']).toBe('string');
    preview.flush(totals('20.23'));
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('20.23');
    expect(textOf(fixture)).not.toContain('Totals not calculated yet');

    fillLine(component, 0, { description: '' });
    fixture.detectChanges();
    expect(component.previewState()).toBe('invalid');
    expect(component.preview()).toBeNull();
    expect(textOf(fixture)).toContain('Totals not calculated yet');
    expect(textOf(fixture)).not.toContain('20.23');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(http.match((request) => request.url.includes('preview-totals'))).toHaveLength(0);
    http.verify();
  });

  it('sends positions 1..n in screen order after a line moves', async () => {
    const { fixture, http } = await setup();
    vi.useFakeTimers();
    const component = fixture.componentInstance;
    component.open('company-1', null);
    flushCatalog(http);
    fillLine(component, 0, {
      description: 'First',
      quantity: '1',
      unit: 'kg',
      unitPrice: '10.00',
      discountPercent: '',
      taxCodeId: 'tax-1',
    });
    component.addLine();
    fillLine(component, 1, {
      description: 'Second',
      quantity: '2',
      unit: 'kg',
      unitPrice: '10.00',
      discountPercent: '',
      taxCodeId: 'tax-1',
    });
    component.move(1, -1);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const preview = http.expectOne('/api/c/company-1/invoices/preview-totals');
    const body: unknown = preview.request.body;
    if (!isRecord(body) || !Array.isArray(body['lines'])) {
      throw new Error('preview body has no lines');
    }
    const descriptions = body['lines'].map((line: unknown) =>
      isRecord(line) ? line['description'] : '',
    );
    const positions = body['lines'].map((line: unknown) => (isRecord(line) ? line['position'] : 0));
    expect(descriptions).toEqual(['Second', 'First']);
    expect(positions).toEqual([1, 2]);
    preview.flush(totals('20.00'));
    http.verify();
  });

  it('keeps the edited draft when a save conflicts', async () => {
    const { fixture, http } = await setup();
    vi.useFakeTimers();
    const component = fixture.componentInstance;
    component.open('company-1', 'invoice-1');
    const detail = http.expectOne('/api/c/company-1/invoices/invoice-1');
    detail.flush({ invoice: invoice('Original') });
    flushCatalog(http);
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    fillLine(component, 0, { description: 'Edited line' });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Totals not calculated yet');
    component.save();
    const patch = http.expectOne('/api/c/company-1/invoices/invoice-1');
    expect(patch.request.method).toBe('PATCH');
    const sent: unknown = patch.request.body;
    if (!isRecord(sent) || !Array.isArray(sent['lines']) || !isRecord(sent['lines'][0])) {
      throw new Error('patch body has no lines');
    }
    expect(sent['lines'][0]['description']).toBe('Edited line');
    expect(sent['expectedVersion']).toBe(4);
    patch.flush(
      {
        error: { code: 'version_conflict', message: 'version_conflict', correlationId: 'corr-409' },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('This invoice was changed by someone else');
    expect(textOf(fixture)).toContain('corr-409');
    expect(component.lines()[0]?.description).toBe('Edited line');
    expect(component.notes()).toBe('Leave the gift text.');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    http.verify();
  });

  it('shows the stored product and tax code when a draft is reopened', async () => {
    const { fixture, http } = await setup();
    vi.useFakeTimers();
    fixture.componentInstance.open('company-1', 'invoice-1');
    const saved = invoice('Mixed nuts');
    const lines = saved['lines'];
    if (Array.isArray(lines) && isRecord(lines[0])) {
      lines[0]['productId'] = 'product-1';
    }
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: saved });
    fixture.detectChanges();
    http.expectOne('/api/c/company-1/products').flush({
      products: [
        {
          id: 'product-1',
          name: 'Mixed nuts',
          description: null,
          kind: 'goods',
          unit: 'kg',
          unitPrice: '10.00',
          taxCodeId: 'tax-1',
        },
        {
          id: 'product-2',
          name: 'Honey',
          description: null,
          kind: 'goods',
          unit: 'kg',
          unitPrice: '8.00',
          taxCodeId: 'tax-0',
        },
      ],
    });
    http.expectOne('/api/c/company-1/tax-codes').flush({
      taxCodes: [
        { id: 'tax-1', code: 'STD19', name: 'Standard' },
        { id: 'tax-0', code: 'ZERO', name: 'Zero' },
      ],
    });
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
    });
    fixture.detectChanges();
    const root = rootOf(fixture);
    const product = selectContaining(root, 'Mixed nuts');
    const tax = selectContaining(root, 'STD19');
    expect(product.value).toBe('product-1');
    expect(product.selectedOptions[0]?.textContent).toContain('Mixed nuts');
    expect(tax.value).toBe('tax-1');
    expect(tax.selectedOptions[0]?.textContent).toContain('STD19');
    expect(root.querySelector('.client-chip')?.textContent).toContain('Acme Demo');
    expect(root.querySelector('.client-chip')?.textContent).toContain('Change');
    expect(
      [...root.querySelectorAll('label')].some((label) => label.textContent.includes('Client')),
    ).toBe(false);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush({
      totals: {
        subtotal: '20.00',
        discountTotal: '3.00',
        netTotal: '17.00',
        taxTotal: '3.23',
        total: '20.23',
        lines: [
          {
            position: 1,
            taxCode: 'STD19',
            lineSubtotal: '20.00',
            lineDiscount: '3.00',
            lineNet: '17.00',
            lineGross: '20.23',
          },
        ],
        taxSummary: [{ taxCode: 'STD19', net: '17.00', tax: '3.23', gross: '20.23' }],
      },
    });
    fixture.detectChanges();
    const text = textOf(fixture);
    expect(text).toContain('Subtotal 20.00');
    expect(text).toContain('Discount 3.00');
    expect(text).toContain('Net 17.00');
    expect(text).toContain('Net 17.00 (excl. tax)');
    expect(text).toContain('Tax code');
    http.verify();
  });

  it('replaces the selected client from the reloaded invoice and ignores a stale lookup', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'invoice-1');
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: invoice('Original') });
    flushCatalog(http);
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    expect(component.client()?.id).toBe('client-1');

    component.reload();
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({
      invoice: {
        ...invoice('Original'),
        clientId: 'client-2',
        clientDisplayName: 'Cee Demo',
        version: 5,
      },
    });
    const stale = http.match('/api/c/company-1/clients/client-2');
    expect(component.client()?.id).toBe('client-2');
    expect(component.client()?.displayName).toBe('Cee Demo');

    component.reload();
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({
      invoice: {
        ...invoice('Original'),
        clientId: 'client-3',
        clientDisplayName: 'Dee Demo',
        version: 6,
      },
    });
    http.expectOne('/api/c/company-1/clients/client-3').flush({
      client: {
        id: 'client-3',
        displayName: 'Dee Demo',
        defaultLanguage: 'en',
        defaultCurrency: 'USD',
      },
    });
    for (const request of stale) {
      request.flush({
        client: {
          id: 'client-2',
          displayName: 'Cee Demo',
          defaultLanguage: 'en',
          defaultCurrency: 'EUR',
        },
      });
    }
    expect(component.client()?.id).toBe('client-3');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    for (const request of http.match((item) => item.url.includes('preview-totals'))) {
      request.flush(totals('10.00'));
    }
    http.verify();
  });

  it('carries a note typed during create into the detail route', async () => {
    vi.useFakeTimers();
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http } = await setup(['invoice.draft', 'invoice.view'], { navigate });
    const component = fixture.componentInstance;
    component.open('company-1', null);
    flushCatalog(http);
    component.chooseClient({
      id: 'client-1',
      displayName: 'Acme Demo',
      defaultLanguage: 'el',
      defaultCurrency: 'EUR',
    });
    fillLine(component, 0, {
      description: 'Nuts',
      quantity: '1',
      unit: 'kg',
      unitPrice: '10.00',
      discountPercent: '',
      taxCodeId: 'tax-1',
    });
    component.setNotes(inputEvent('typed before save'));
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    component.save();
    const post = http.expectOne('/api/c/company-1/invoices');
    expect(post.request.method).toBe('POST');
    const sent: unknown = post.request.body;
    if (!isRecord(sent)) {
      throw new Error('create body is missing');
    }
    expect(sent['notes']).toBe('typed before save');
    component.setNotes(inputEvent('typed after save'));
    post.flush({
      invoice: { ...invoice('Nuts'), id: 'invoice-9', notes: 'typed before save', version: 1 },
    });
    const [commands, extras] = navigateCall(navigate);
    expect(commands).toEqual(['/c', 'company-1', 'invoices', 'invoice-9']);
    if (
      !isRecord(extras) ||
      !isRecord(extras['state']) ||
      !isRecord(extras['state']['carriedInvoice'])
    ) {
      throw new Error('create did not carry the invoice draft');
    }
    const carried = extras['state']['carriedInvoice'];
    expect(carried['id']).toBe('invoice-9');
    expect(carried['version']).toBe(1);
    expect(carried['notes']).toBe('typed after save');
    http.verify();
  });

  it('keeps a carried create draft instead of the stored invoice', async () => {
    vi.useFakeTimers();
    const carriedInvoice = {
      id: 'invoice-9',
      version: 1,
      status: 'draft',
      currency: 'EUR',
      documentType: 'invoice' as const,
      pricesIncludeTax: false,
      issueDate: '',
      dueDate: '',
      reference: '',
      notes: 'typed after save',
      terms: '',
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
      lines: [
        {
          key: 'line-1',
          productId: '',
          description: 'Nuts',
          quantity: '1',
          unit: 'kg',
          unitPrice: '10.00',
          discountPercent: '',
          taxCodeId: 'tax-1',
          kind: 'item' as const,
        },
      ],
    };
    const { fixture, http } = await setup(['invoice.draft', 'invoice.view'], {
      getCurrentNavigation: () => ({ extras: { state: { carriedInvoice } } }),
    });
    const component = fixture.componentInstance;
    component.open('company-1', 'invoice-9');
    flushCatalog(http);
    const loaded = http.match((request) => request.url === '/api/c/company-1/invoices/invoice-9');
    for (const request of loaded) {
      request.flush({
        invoice: { ...invoice('Nuts'), id: 'invoice-9', notes: 'server copy', version: 7 },
      });
    }
    expect(component.notes()).toBe('typed after save');
    component.save();
    const patch = http.expectOne('/api/c/company-1/invoices/invoice-9');
    expect(patch.request.body).toMatchObject({ expectedVersion: 1, notes: 'typed after save' });
    patch.flush({
      invoice: { ...invoice('Nuts'), id: 'invoice-9', notes: 'typed after save', version: 2 },
    });
    http.verify();
  });

  it('keeps a note typed after save is clicked', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'invoice-1');
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: invoice('Original') });
    flushCatalog(http);
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    fixture.detectChanges();
    const notes = labeledTextarea(rootOf(fixture), 'Notes');
    notes.value = 'typed before save';
    notes.dispatchEvent(new Event('input'));
    expect(component.notes()).toBe('typed before save');
    component.save();
    const patch = http.expectOne('/api/c/company-1/invoices/invoice-1');
    const sent: unknown = patch.request.body;
    if (!isRecord(sent)) {
      throw new Error('patch body is missing');
    }
    expect(sent['notes']).toBe('typed before save');
    notes.value = 'typed after save';
    notes.dispatchEvent(new Event('input'));
    patch.flush({ invoice: { ...invoice('Original'), notes: 'server copy', version: 5 } });
    expect(component.notes()).toBe('typed after save');
    http.verify();
  });

  it('shows stored totals when the viewer cannot draft', async () => {
    const { fixture, http } = await setup(['invoice.view']);
    fixture.componentInstance.open('company-1', 'invoice-1');
    const saved = invoice('Mixed nuts');
    saved['subtotal'] = '20.00';
    saved['discountTotal'] = '3.00';
    saved['netTotal'] = '17.00';
    saved['taxTotal'] = '3.23';
    saved['total'] = '20.23';
    const lines = saved['lines'];
    if (Array.isArray(lines) && isRecord(lines[0])) {
      lines[0]['lineSubtotal'] = '20.00';
      lines[0]['lineDiscount'] = '3.00';
      lines[0]['lineNet'] = '17.00';
      lines[0]['lineGross'] = '20.23';
      lines[0]['taxCode'] = 'STD19';
    }
    saved['taxSummary'] = [{ taxCode: 'STD19', net: '17.00', tax: '3.23', gross: '20.23' }];
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: saved });
    flushCatalog(http);
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
    });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('20.23');
    expect(textOf(fixture)).not.toContain('Totals not calculated yet');
    expect(http.match((request) => request.url.includes('preview-totals'))).toHaveLength(0);
    http.verify();
  });

  it('labels read-only totals with the stored invoice currency', async () => {
    const { fixture, http } = await setup(['invoice.view']);
    const component = fixture.componentInstance;
    component.open('company-1', 'invoice-1');
    const saved = invoice('Mixed nuts');
    saved['currency'] = 'EUR';
    saved['subtotal'] = '20.00';
    saved['discountTotal'] = '3.00';
    saved['netTotal'] = '17.00';
    saved['taxTotal'] = '3.23';
    saved['total'] = '20.23';
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: saved });
    flushCatalog(http);
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'USD',
      },
    });
    fixture.detectChanges();
    expect(component.moneyCurrency()).toBe('EUR');
    expect(textOf(fixture)).toContain('20.23');
    expect(textOf(fixture)).toContain('EUR');
    expect(textOf(fixture)).not.toContain('USD');
    http.verify();
  });

  it('shows the selected client currency rather than the saved invoice currency', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', 'invoice-1');
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: invoice('Original') });
    flushCatalog(http);
    http.expectOne('/api/c/company-1/clients/client-1').flush({
      client: {
        id: 'client-1',
        displayName: 'Acme Demo',
        defaultLanguage: 'el',
        defaultCurrency: 'EUR',
      },
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    fixture.detectChanges();
    component.chooseClient({
      id: 'client-2',
      displayName: 'Dollar Demo',
      defaultLanguage: 'en',
      defaultCurrency: 'USD',
    });
    fixture.detectChanges();
    expect(component.moneyCurrency()).toBe('USD');
    expect(textOf(fixture)).toContain('USD');
    http.verify();
  });

  it('ignores an older preview that arrives after a newer one and another edit', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', null);
    flushCatalog(http);
    fillLine(component, 0, {
      description: 'Nuts',
      quantity: '1',
      unit: 'kg',
      unitPrice: '10.00',
      discountPercent: '',
      taxCodeId: 'tax-1',
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const previewA = http.expectOne('/api/c/company-1/invoices/preview-totals');
    fillLine(component, 0, { quantity: '2' });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const previewB = http.expectOne('/api/c/company-1/invoices/preview-totals');
    previewB.flush(totals('2.00'));
    fixture.detectChanges();
    expect(component.preview()?.total).toBe('2.00');
    fillLine(component, 0, { quantity: '3' });
    expect(component.preview()).toBeNull();
    previewA.flush(totals('1.00'));
    fixture.detectChanges();
    expect(component.preview()).toBeNull();
    expect(component.preview()?.total).not.toBe('1.00');
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    const previewC = http.expectOne('/api/c/company-1/invoices/preview-totals');
    const body: unknown = previewC.request.body;
    if (!isRecord(body) || !Array.isArray(body['lines']) || !isRecord(body['lines'][0])) {
      throw new Error('preview body has no lines');
    }
    expect(body['lines'][0]['quantity']).toBe('3');
    previewC.flush(totals('3.00'));
    expect(component.preview()?.total).toBe('3.00');
    http.verify();
  });

  it('labels an exclusive line as net excluding tax and an inclusive line as the amount including tax', async () => {
    vi.useFakeTimers();
    const { fixture, http } = await setup();
    const component = fixture.componentInstance;
    component.open('company-1', null);
    flushCatalog(http);
    fillLine(component, 0, {
      description: 'Nuts',
      quantity: '2',
      unit: 'kg',
      unitPrice: '10.00',
      discountPercent: '15',
      taxCodeId: 'tax-1',
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(lineTotals(false));
    fixture.detectChanges();
    const exclusive = lineText(fixture);
    expect(exclusive).toContain('Subtotal 20.00');
    expect(exclusive).toContain('Discount 3.00');
    expect(exclusive).toContain('Net 17.00 (excl. tax)');
    expect(exclusive).not.toContain('Gross');

    component.setTaxIncluded(checkEvent(true));
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(lineTotals(true));
    fixture.detectChanges();
    const inclusive = lineText(fixture);
    expect(inclusive).toContain('Subtotal 20.00');
    expect(inclusive).toContain('Discount 3.00');
    expect(inclusive).toContain('Amount incl. tax 20.23');
    expect(inclusive).toContain('Net 17.00');
    expect(inclusive).not.toContain('excl. tax');
    http.verify();
  });

  it('issues the saved draft after confirmation and shows its number and deadline', async () => {
    const { fixture, http, component } = await openSaved(ISSUER);
    expect(component.canIssue()).toBe(true);
    expect(textOf(fixture)).toContain('Issue invoice');
    component.startIssue();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('cannot be edited or deleted');
    component.confirmIssue();
    const issue = http.expectOne('/api/c/company-1/invoices/invoice-1/issue');
    expect(issue.request.method).toBe('POST');
    expect(issue.request.body).toEqual({ expectedVersion: 4 });
    // While the request is in flight the draft cannot be edited.
    expect(component.readOnly()).toBe(true);
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('textarea')?.disabled).toBe(true);
    issue.flush({
      invoice: {
        ...invoice('Nuts'),
        status: 'issued',
        number: 'INV-0001',
        issueDate: '2026-10-28',
        supplyDate: '2026-10-28',
        dueDate: '2026-11-27',
        deliveryDeadline: '2099-11-27',
        lastDeliveredOn: null,
        version: 5,
      },
      warnings: ['delivery_deadline_passed'],
    });
    fixture.detectChanges();
    expect(component.status()).toBe('issued');
    expect(component.readOnly()).toBe(true);
    expect(component.canIssue()).toBe(false);
    const text = textOf(fixture);
    expect(text).toContain('Invoice INV-0001');
    expect(text).toContain('Deliver to the client by 27/11/2099');
    expect(text).toContain('Issued after its delivery deadline');
    expect(text).toContain('Open the issued PDF');
    expect(text).not.toContain('DRAFT — not a tax invoice');
    http.verify();
  });

  it('waits for a save before issuing', async () => {
    const { fixture, http, component } = await openSaved(ISSUER);
    fillLine(component, 0, { description: 'Edited, not saved' });
    fixture.detectChanges();
    expect(component.dirty()).toBe(true);
    expect(textOf(fixture)).toContain('Save the draft first');
    component.startIssue();
    component.confirmIssue();
    expect(component.confirmingIssue()).toBe(false);
    expect(http.match((request) => request.url.endsWith('/issue'))).toHaveLength(0);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
    http.verify();
  });

  it('lists the missing particulars the API names', async () => {
    const { fixture, http, component } = await openSaved(ISSUER);
    component.startIssue();
    component.confirmIssue();
    http.expectOne('/api/c/company-1/invoices/invoice-1/issue').flush(
      {
        error: {
          code: 'invoice_incomplete',
          message: 'The invoice is missing details it must show.',
          correlationId: 'corr-9',
          fields: ['seller.vatNumber', 'lines.2.legalNote', 'something.new'],
        },
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();
    const text = textOf(fixture);
    expect(text).toContain("The company's VAT number is missing");
    expect(text).toContain('Line 2: its tax code needs the legal note');
    expect(text).toContain('Missing: something.new');
    expect(component.status()).toBe('draft');
    expect(component.busy()).toBe(false);
    http.verify();
  });

  it('says when issuing is switched off', async () => {
    const { fixture, http, component } = await openSaved(ISSUER);
    component.startIssue();
    component.confirmIssue();
    http.expectOne('/api/c/company-1/invoices/invoice-1/issue').flush(
      {
        error: {
          code: 'issuance_disabled',
          message: 'Issuing real invoices is switched off.',
          correlationId: 'corr-10',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('Issuing real invoices is switched off for this company');
    expect(textOf(fixture)).toContain('corr-10');
    http.verify();
  });

  it('offers no issue action without invoice.issue', async () => {
    const { fixture, http, component } = await openSaved(['invoice.draft', 'invoice.view']);
    expect(component.canIssue()).toBe(false);
    expect(textOf(fixture)).not.toContain('Issue invoice');
    http.verify();
  });

  it('shows a credit note in its own view instead of the invoice form', async () => {
    const { fixture, http, component } = await openDocument(CREDITOR, {
      ...invoice('Gift box (demo)'),
      id: 'credit-1',
      documentType: 'credit_note',
      creditReason: 'One box damaged',
      creditedInvoice: { id: 'invoice-1', number: 'INV-0007', issueDate: '2026-10-20' },
      netTotal: '10.00',
      taxTotal: '1.90',
      total: '11.90',
    });
    expect(component.creditNote()?.creditReason).toBe('One box damaged');
    expect(component.readOnly()).toBe(true);
    expect(component.canIssue()).toBe(false);
    const root = rootOf(fixture);
    expect(root.querySelector('h1')?.textContent).toContain('Credit note');
    expect(root.querySelector('bp-credit-note')).not.toBeNull();
    expect(root.querySelector('form')).toBeNull();
    expect(textOf(fixture)).toContain('INV-0007');
    expect(textOf(fixture)).not.toContain('Issue invoice');
    http.verify();
  });

  it('lists the credit notes of an issued invoice with what each line has credited', async () => {
    const { fixture, http, component } = await openDocument(CREDITOR, {
      ...invoice('Gift box (demo)'),
      status: 'issued',
      number: 'INV-0007',
      issueDate: '2026-10-20',
      deliveryDeadline: '2099-11-19',
      lines: [
        {
          id: 'line-1',
          position: 1,
          kind: 'item',
          productId: null,
          description: 'Gift box (demo)',
          quantity: '2.0000',
          unit: 'pc',
          unitPrice: '10.0000',
          discountPercent: '0.00',
          taxCodeId: 'tax-1',
          creditedQuantity: '0.5000',
        },
      ],
      creditNotes: [
        { id: 'credit-1', number: 'CN-0001', status: 'issued', total: '5.95', issueDate: null },
      ],
    });
    expect(component.creditableLines()).toEqual([
      {
        id: 'line-1',
        position: 1,
        description: 'Gift box (demo)',
        quantity: '2.0000',
        unit: 'pc',
        creditedQuantity: '0.5000',
      },
    ]);
    expect(rootOf(fixture).querySelector('bp-credit-panel')).not.toBeNull();
    expect(textOf(fixture)).toContain('CN-0001');
    expect(textOf(fixture)).toContain('Create a credit note');
    http.verify();
  });

  it('converts a saved quote once and opens the new invoice', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http, component } = await openDocument(
      ['invoice.draft', 'invoice.view'],
      { ...invoice('Nuts'), documentType: 'quote' },
      navigate,
    );
    expect(textOf(fixture)).toContain('Convert to invoice');
    fillLine(component, 0, { description: 'Edited, not saved' });
    component.convert();
    expect(http.match((request) => request.url.endsWith('/convert'))).toHaveLength(0);
    component.reload();
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({
      invoice: { ...invoice('Nuts'), documentType: 'quote' },
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    for (const preview of http.match('/api/c/company-1/invoices/preview-totals')) {
      preview.flush(totals('10.00'));
    }

    component.convert();
    const refused = http.expectOne('/api/c/company-1/quotes/invoice-1/convert');
    expect(refused.request.body).toEqual({});
    refused.flush(
      { error: { code: 'already_converted', message: 'x', correlationId: 'corr-8' } },
      { status: 409, statusText: 'Conflict' },
    );
    // The quote is loaded again and now names its invoice.
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({
      invoice: { ...invoice('Nuts'), documentType: 'quote', convertedInvoiceId: 'invoice-2' },
    });
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    for (const preview of http.match('/api/c/company-1/invoices/preview-totals')) {
      preview.flush(totals('10.00'));
    }
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('This quote was already converted to an invoice.');
    expect(textOf(fixture)).toContain('Open the invoice');
    expect(navigate).not.toHaveBeenCalled();
    // Each reload also refreshes the client.
    for (const load of http.match('/api/c/company-1/clients/client-1')) {
      load.flush({ client: { id: 'client-1', displayName: 'Acme Demo' } });
    }
    http.verify();
  });

  it('opens the new invoice after a conversion, and keeps the quote frozen meanwhile', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http, component } = await openDocument(
      ['invoice.draft', 'invoice.view'],
      { ...invoice('Nuts'), documentType: 'quote' },
      navigate,
    );
    component.convert();
    const failed = http.expectOne('/api/c/company-1/quotes/invoice-1/convert');
    expect(component.readOnly()).toBe(true);
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('textarea')?.disabled).toBe(true);
    failed.flush(
      { error: { code: 'tax_code_inactive', message: 'x', correlationId: 'corr-11' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();
    expect(component.readOnly()).toBe(false);
    expect(textOf(fixture)).toContain("A line's tax code is no longer active.");

    component.convert();
    http
      .expectOne('/api/c/company-1/quotes/invoice-1/convert')
      .flush({ invoice: { id: 'invoice-2' } });
    expect(navigate).toHaveBeenCalledWith(['/c', 'company-1', 'invoices', 'invoice-2']);
    http.verify();
  });

  it('converts once at a time, also while a refused conversion reloads the quote', async () => {
    const { http, component } = await openDocument(['invoice.draft', 'invoice.view'], {
      ...invoice('Nuts'),
      documentType: 'quote',
    });
    component.convert();
    component.convert();
    http
      .expectOne('/api/c/company-1/quotes/invoice-1/convert')
      .flush(
        { error: { code: 'already_converted', message: 'x', correlationId: 'corr-12' } },
        { status: 409, statusText: 'Conflict' },
      );
    const reload = http.expectOne('/api/c/company-1/invoices/invoice-1');
    // Still frozen until the reload lands, so no second conversion is sent.
    expect(component.readOnly()).toBe(true);
    component.convert();
    expect(http.match((request) => request.url.endsWith('/convert'))).toHaveLength(0);
    reload.flush({
      invoice: { ...invoice('Nuts'), documentType: 'quote', convertedInvoiceId: 'invoice-2' },
    });
    expect(component.readOnly()).toBe(false);
    for (const load of http.match('/api/c/company-1/clients/client-1')) {
      load.flush({ client: { id: 'client-1', displayName: 'Acme Demo' } });
    }
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    for (const preview of http.match('/api/c/company-1/invoices/preview-totals')) {
      preview.flush(totals('10.00'));
    }
    http.verify();
  });

  it('does not navigate over another navigation when the conversion answer arrives', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    let running: unknown = null;
    const { http, component } = await openDocument(
      ['invoice.draft', 'invoice.view'],
      { ...invoice('Nuts'), documentType: 'quote' },
      navigate,
      () => running,
    );
    component.convert();
    // A company switch starts and waits on its guard.
    running = { id: 7 };
    http
      .expectOne('/api/c/company-1/quotes/invoice-1/convert')
      .flush({ invoice: { id: 'invoice-2' } });
    expect(navigate).not.toHaveBeenCalled();
    http.expectOne('/api/c/company-1/invoices/invoice-1').flush({
      invoice: { ...invoice('Nuts'), documentType: 'quote', convertedInvoiceId: 'invoice-2' },
    });
    expect(component.convertedInvoiceId()).toBe('invoice-2');
    for (const load of http.match('/api/c/company-1/clients/client-1')) {
      load.flush({ client: { id: 'client-1', displayName: 'Acme Demo' } });
    }
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    for (const preview of http.match('/api/c/company-1/invoices/preview-totals')) {
      preview.flush(totals('10.00'));
    }
    http.verify();
  });

  it('never navigates on a conversion answer that arrives after the editor closed', async () => {
    const navigate = vi.fn(() => Promise.resolve(true));
    const { fixture, http, component } = await openDocument(
      ['invoice.draft', 'invoice.view'],
      { ...invoice('Nuts'), documentType: 'quote' },
      navigate,
    );
    component.convert();
    const late = http.expectOne('/api/c/company-1/quotes/invoice-1/convert');
    fixture.destroy();
    expect(late.cancelled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    http.verify();
  });

  it('shows the credit note its view saved, without loading it again', async () => {
    const credit = {
      ...invoice('Gift box (demo)'),
      id: 'credit-1',
      documentType: 'credit_note',
      creditReason: 'One box damaged',
      creditedInvoice: { id: 'invoice-1', number: 'INV-0007', issueDate: '2026-10-20' },
    };
    const { http, component } = await openDocument(CREDITOR, credit);
    component.applySaved({ ...credit, creditReason: 'Two boxes damaged', version: 5 } as never);
    expect(component.creditNote()?.creditReason).toBe('Two boxes damaged');
    expect(component.creditNote()?.version).toBe(5);
    // Another document's answer is ignored.
    component.applySaved({ ...credit, id: 'credit-9', creditReason: 'Other' } as never);
    expect(component.creditNote()?.creditReason).toBe('Two boxes damaged');
    http.verify();
  });

  it('links an invoice to the quote it was made from', async () => {
    const { fixture, http } = await openDocument(ISSUER, {
      ...invoice('Nuts'),
      sourceQuoteId: 'quote-1',
    });
    expect(rootOf(fixture).querySelector('[data-testid="source-quote"]')?.textContent).toContain(
      'Made from a quote.',
    );
    http.verify();
  });
});

const ISSUER = ['invoice.draft', 'invoice.view', 'invoice.issue'];
const CREDITOR = ['invoice.draft', 'invoice.view', 'invoice.issue', 'invoice.credit'];

/** Opens one document and settles every load and any preview. */
async function openDocument(
  permissions: string[],
  document: Record<string, unknown>,
  navigate?: ReturnType<typeof vi.fn>,
  getCurrentNavigation?: () => unknown,
): Promise<{
  fixture: ComponentFixture<InvoiceEditorPage>;
  http: HttpTestingController;
  component: InvoiceEditorPage;
}> {
  const { fixture, http } = await setup(permissions, {
    ...(navigate ? { navigate } : {}),
    ...(getCurrentNavigation ? { getCurrentNavigation } : {}),
  });
  vi.useFakeTimers();
  const component = fixture.componentInstance;
  const id = typeof document['id'] === 'string' ? document['id'] : '';
  component.open('company-1', id);
  http.expectOne(`/api/c/company-1/invoices/${id}`).flush({ invoice: document });
  flushCatalog(http);
  http.expectOne('/api/c/company-1/clients/client-1').flush({
    client: {
      id: 'client-1',
      displayName: 'Acme Demo',
      defaultLanguage: 'en',
      defaultCurrency: 'EUR',
    },
  });
  vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
  for (const preview of http.match('/api/c/company-1/invoices/preview-totals')) {
    preview.flush(totals('10.00'));
  }
  fixture.detectChanges();
  return { fixture, http, component };
}

/** Opens the saved draft invoice-1 and settles every load and the first preview. */
async function openSaved(permissions: string[]): Promise<{
  fixture: ComponentFixture<InvoiceEditorPage>;
  http: HttpTestingController;
  component: InvoiceEditorPage;
}> {
  const { fixture, http } = await setup(permissions);
  vi.useFakeTimers();
  const component = fixture.componentInstance;
  component.open('company-1', 'invoice-1');
  http.expectOne('/api/c/company-1/invoices/invoice-1').flush({ invoice: invoice('Nuts') });
  flushCatalog(http);
  http.expectOne('/api/c/company-1/clients/client-1').flush({
    client: {
      id: 'client-1',
      displayName: 'Acme Demo',
      defaultLanguage: 'en',
      defaultCurrency: 'EUR',
    },
  });
  vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
  http.expectOne('/api/c/company-1/invoices/preview-totals').flush(totals('10.00'));
  fixture.detectChanges();
  return { fixture, http, component };
}

async function setup(
  permissions: string[] = ['invoice.draft', 'invoice.view'],
  router: {
    navigate?: ReturnType<typeof vi.fn>;
    getCurrentNavigation?: () => unknown;
  } = {},
): Promise<{ fixture: ComponentFixture<InvoiceEditorPage>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [InvoiceEditorPage],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: {
          availableLangs: ['en', 'el'],
          defaultLang: 'en',
          reRenderOnLangChange: true,
          prodMode: true,
        },
        loader: AppTranslocoLoader,
      }),
      {
        provide: ActivatedRoute,
        useValue: {
          parent: null,
          paramMap: of(convertToParamMap({})),
          queryParamMap: of(convertToParamMap({})),
          snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}) },
        },
      },
      {
        provide: Router,
        useValue: {
          navigate: router.navigate ?? (() => Promise.resolve(true)),
          getCurrentNavigation: router.getCurrentNavigation,
        },
      },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  TestBed.inject(CompanyContextStore).grants.set(permissions.map(grant));
  const fixture = TestBed.createComponent(InvoiceEditorPage);
  fixture.detectChanges();
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

function fillLine(
  component: InvoiceEditorPage,
  index: number,
  values: Partial<
    Record<
      'description' | 'quantity' | 'unit' | 'unitPrice' | 'discountPercent' | 'taxCodeId',
      string
    >
  >,
): void {
  for (const [field, value] of Object.entries(values)) {
    if (
      (field === 'description' ||
        field === 'quantity' ||
        field === 'unit' ||
        field === 'unitPrice' ||
        field === 'discountPercent' ||
        field === 'taxCodeId') &&
      typeof value === 'string'
    ) {
      component.setLineText(index, field, inputEvent(value));
    }
  }
}

function flushCatalog(http: HttpTestingController): void {
  http.expectOne('/api/c/company-1/products').flush({ products: [] });
  http.expectOne('/api/c/company-1/tax-codes').flush({ taxCodes: [] });
}

function invoice(description: string): Record<string, unknown> {
  return {
    id: 'invoice-1',
    documentType: 'invoice',
    status: 'draft',
    clientId: 'client-1',
    clientDisplayName: 'Acme Demo',
    currency: 'EUR',
    language: 'el',
    pricesIncludeTax: false,
    issueDate: null,
    dueDate: null,
    reference: null,
    notes: 'Leave the gift text.',
    terms: null,
    version: 4,
    lines: [
      {
        position: 1,
        kind: 'item',
        productId: null,
        description,
        quantity: '1.00',
        unit: 'kg',
        unitPrice: '10.00',
        discountPercent: '0.00',
        taxCodeId: 'tax-1',
      },
    ],
  };
}

function totals(total: string): { totals: Record<string, unknown> } {
  return {
    totals: {
      subtotal: total,
      discountTotal: '0.00',
      netTotal: total,
      taxTotal: '0.00',
      total,
      lines: [
        {
          position: 1,
          taxCode: 'STD19',
          lineSubtotal: total,
          lineDiscount: '0.00',
          lineNet: total,
          lineGross: total,
        },
      ],
      taxSummary: [{ taxCode: 'STD19', net: total, tax: '0.00', gross: total }],
    },
  };
}

function grant(permission: string): Grant {
  return { permission, scopeType: 'company', scopeId: null };
}

function inputEvent(value: string): Event {
  const input = document.createElement('input');
  input.value = value;
  const event = new Event('input');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

function textOf(fixture: ComponentFixture<unknown>): string {
  return rootOf(fixture).textContent;
}

function rootOf(fixture: ComponentFixture<unknown>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  return root;
}

function lineTotals(inclusive: boolean): { totals: Record<string, unknown> } {
  return {
    totals: {
      subtotal: '20.00',
      discountTotal: '3.00',
      netTotal: '17.00',
      taxTotal: '3.23',
      total: '20.23',
      lines: [
        {
          position: 1,
          taxCode: 'STD19',
          lineSubtotal: '20.00',
          lineDiscount: '3.00',
          lineNet: '17.00',
          lineGross: inclusive ? '20.23' : '17.00',
        },
      ],
      taxSummary: [{ taxCode: 'STD19', net: '17.00', tax: '3.23', gross: '20.23' }],
    },
  };
}

function lineText(fixture: ComponentFixture<unknown>): string {
  const line = rootOf(fixture).querySelector('.line-amounts');
  if (!(line instanceof HTMLElement)) {
    throw new Error('missing line amounts');
  }
  return line.textContent;
}

function labeledTextarea(root: HTMLElement, label: string): HTMLTextAreaElement {
  const found = [...root.querySelectorAll('label')].find((item) =>
    item.textContent.includes(label),
  );
  const field = found?.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error(`missing ${label}`);
  }
  return field;
}

function checkEvent(checked: boolean): Event {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: input });
  return event;
}

function selectContaining(root: HTMLElement, optionText: string): HTMLSelectElement {
  const found = [...root.querySelectorAll('select')].find((item) =>
    item.textContent.includes(optionText),
  );
  if (!(found instanceof HTMLSelectElement)) {
    throw new Error(`missing select ${optionText}`);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function navigateCall(navigate: { mock: { calls: unknown[][] } }): readonly [unknown, unknown] {
  const call = navigate.mock.calls[0];
  if (!call) {
    throw new Error('navigate was not called');
  }
  return [call[0], call[1]];
}
