import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import type { PrintSlot } from './models';
import { PRINT_POLL_LIMIT_MS, PRINT_POLL_MS, PrintPanelComponent } from './print-panel';

const labels: [string, string][] = [
  ['queued', 'Queued'],
  ['held', 'Held — printing is switched off'],
  ['submitting', 'Submitting'],
  ['submitted', 'Sent to printer'],
  ['delivered_to_printer', 'Delivered to printer (not confirmed)'],
  ['done_reported', 'Sent to printer (provider reported done — not confirmed)'],
  ['confirmed_printed', 'Confirmed printed'],
  ['not_printed', 'Confirmed not printed'],
  ['failed', 'Failed'],
  ['uncertain', 'Uncertain — check the printer before reprinting'],
  ['cancelled', 'Cancelled'],
];

const PACKING_KEY = 'bp.orderPrint.company-1.order-1.packing_slip';

describe('PrintPanelComponent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('maps every status, marks a mock printer, and offers confirmation for reported and uncertain jobs', async () => {
    const { fixture } = await setup(60_000);
    for (const [status, label] of labels) {
      fixture.componentRef.setInput('job', slot(status));
      fixture.detectChanges();
      await fixture.whenStable();
      const text = textOf(fixture);
      expect(text).toContain(label);
      expect(text).toContain('Simulated printer');
      if (status !== 'confirmed_printed') {
        expect(text).not.toContain('Confirmed printed');
      }
    }
    for (const status of ['submitted', 'delivered_to_printer', 'done_reported', 'uncertain']) {
      fixture.componentRef.setInput('job', slot(status));
      fixture.detectChanges();
      await fixture.whenStable();
      const text = textOf(fixture);
      expect(text).toContain('Confirm printed');
      expect(text).toContain('Not printed');
    }
    button(fixture, 'Reprint').click();
    fixture.detectChanges();
    expect(textOf(fixture)).toContain(
      'The previous job may still print — check the printer before reprinting',
    );
  });

  it('offers reprint without confirm while a job may still be at the printer', async () => {
    const { fixture } = await setup(60_000);
    fixture.componentRef.setInput('canConfirm', false);
    fixture.componentRef.setInput('canReprint', true);
    fixture.componentRef.setInput('canSubmit', false);
    for (const status of ['submitted', 'delivered_to_printer', 'done_reported']) {
      fixture.componentRef.setInput('job', slot(status));
      fixture.detectChanges();
      await fixture.whenStable();
      expect(exactButton(fixture, 'Reprint')).toBeInstanceOf(HTMLButtonElement);
      expect(exactButton(fixture, 'Confirm printed')).toBeUndefined();
      expect(exactButton(fixture, 'Not printed')).toBeUndefined();
    }
    fixture.componentRef.setInput('job', slot('done_reported'));
    fixture.detectChanges();
    button(fixture, 'Reprint').click();
    fixture.detectChanges();
    expect(textOf(fixture)).not.toContain(
      'The previous job may still print — check the printer before reprinting',
    );
  });

  it('shows Print after a failed reprint when a new first print is available', async () => {
    const { fixture } = await setup(60_000);
    fixture.componentRef.setInput('canReprint', true);
    fixture.componentRef.setInput('firstPrintAvailable', true);
    fixture.componentRef.setInput('job', { ...slot('failed'), isReprint: true });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(exactButton(fixture, 'Print')).toBeInstanceOf(HTMLButtonElement);
    expect(exactButton(fixture, 'Reprint')).toBeInstanceOf(HTMLButtonElement);
    fixture.componentRef.setInput('firstPrintAvailable', false);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(exactButton(fixture, 'Print')).toBeUndefined();
    expect(exactButton(fixture, 'Reprint')).toBeInstanceOf(HTMLButtonElement);
  });

  it('requires a reprint reason of at least 5 characters', async () => {
    const { fixture } = await setup(60_000);
    fixture.componentRef.setInput('job', slot('confirmed_printed'));
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Reprint').click();
    fixture.detectChanges();
    const area = textarea(fixture);
    area.value = 'abcd';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(dialogButton(fixture).disabled).toBe(true);
    area.value = 'abcde';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(dialogButton(fixture).disabled).toBe(false);
  });

  it('stops polling on a terminal status and when the panel is destroyed', async () => {
    const { fixture, http } = await setup();
    fixture.componentRef.setInput('job', slot('queued'));
    fixture.detectChanges();
    await wait(40);
    const first = http.expectOne('/api/c/company-1/print-jobs/job-1');
    first.flush({ printJob: slot('confirmed_printed') });
    fixture.detectChanges();
    await wait(80);
    http.expectNone('/api/c/company-1/print-jobs/job-1');

    fixture.componentRef.setInput('job', slot('submitting'));
    fixture.detectChanges();
    await wait(40);
    http.expectOne('/api/c/company-1/print-jobs/job-1').flush({ printJob: slot('submitting') });
    fixture.destroy();
    await wait(80);
    http.expectNone('/api/c/company-1/print-jobs/job-1');
  });

  it('does not let a slower poll overwrite a newer status', async () => {
    const { fixture, http } = await setup(25);
    fixture.componentRef.setInput('job', slot('queued'));
    fixture.detectChanges();
    await wait(40);
    const first = http.expectOne('/api/c/company-1/print-jobs/job-1');
    await wait(40);
    http.expectNone('/api/c/company-1/print-jobs/job-1');

    fixture.componentRef.setInput('job', slot('submitting'));
    fixture.detectChanges();
    await wait(40);
    const second = http.expectOne('/api/c/company-1/print-jobs/job-1');
    second.flush({ printJob: slot('done_reported') });
    fixture.detectChanges();
    first.flush({ printJob: slot('queued') });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(statusText(fixture)).toBe('Sent to printer (provider reported done — not confirmed)');
  });

  it('keeps polling after an error until the limit, then says to refresh', async () => {
    const { fixture, http } = await setup(30, 120);
    fixture.componentRef.setInput('job', slot('queued'));
    fixture.detectChanges();
    let polls = 0;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !textOf(fixture).includes('Still waiting — refresh to check')) {
      await wait(15);
      const pending = http.match('/api/c/company-1/print-jobs/job-1');
      polls += pending.length;
      for (const request of pending) {
        request.flush('nope', { status: 500, statusText: 'Server error' });
      }
      fixture.detectChanges();
    }
    expect(polls).toBeGreaterThan(1);
    expect(textOf(fixture)).toContain('Still waiting — refresh to check');
    await wait(50);
    http.expectNone('/api/c/company-1/print-jobs/job-1');
  });

  it('stops polling when a status read is denied', async () => {
    const { fixture, http } = await setup();
    fixture.componentRef.setInput('job', slot('queued'));
    fixture.detectChanges();
    await wait(40);
    http
      .expectOne('/api/c/company-1/print-jobs/job-1')
      .flush(
        { error: { message: 'Forbidden', correlationId: 'corr-403' } },
        { status: 403, statusText: 'Forbidden' },
      );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(textOf(fixture)).toContain('Status updates stopped — this print job cannot be read');
    await wait(80);
    http.expectNone('/api/c/company-1/print-jobs/job-1');
  });

  it('does not send another print while the first request has no answer', async () => {
    const { fixture, http, component } = await setup(60_000);
    fixture.componentRef.setInput('job', null);
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    fixture.componentRef.setInput('job', slot('failed'));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(buttonLabels(fixture)).toEqual(['Send the same request again']);
    const retry = exactButton(fixture, 'Send the same request again');
    expect(retry?.disabled).toBe(true);
    retry?.click();
    component.print(false);
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
    first.flush({ printJob: slot('queued') });
    expect(component.pending()).toBeNull();
    http.verify();
  });

  it('sends a new request key and clears the reprint once the printer accepts it', async () => {
    const { fixture, http, component } = await setup(60_000);
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    const sent = record(first.request.body);
    expect(sent).toMatchObject({
      documentType: 'packing_slip',
      sourceType: 'order',
      sourceId: 'order-1',
    });
    expect(sent['requestKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent['reprint']).toBeUndefined();
    expect(stored(PACKING_KEY)).toEqual({ body: sent, lost: false });
    expect(sessionStorage.getItem('bp.orderPrint.company-1.order-1.gift_message')).toBeNull();
    expect(sessionStorage.getItem('bp.orderPrint.company-2.order-1.packing_slip')).toBeNull();
    first.flush({ printJob: slot('queued') });
    fixture.detectChanges();
    expect(component.pending()).toBeNull();
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();

    submitReprint(fixture, 'Client lost it');
    const reprint = http.expectOne('/api/c/company-1/print-requests');
    const again = record(reprint.request.body);
    expect(again).toMatchObject({
      reprint: { ofPrintJobId: 'job-1', reason: 'Client lost it' },
    });
    expect(again['requestKey']).toMatch(/^[0-9a-f-]{36}$/);
    expect(again['requestKey']).not.toBe(sent['requestKey']);
    expect(stored(PACKING_KEY)).toEqual({ body: again, lost: false });
    reprint.flush({ printJob: slot('queued') });
    fixture.detectChanges();
    expect(component.pending()).toBeNull();
    expect(component.reprintReason()).toBe('');
    expect(component.reprintOpen()).toBe(false);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]')).toBeNull();
    http.verify();
  });

  it('keeps a lost answer and sends the same request again', async () => {
    const { fixture, http, component } = await setup(60_000);
    fixture.componentRef.setInput('firstPrintAvailable', false);
    fixture.componentRef.setInput('job', slot('confirmed_printed'));
    fixture.detectChanges();
    await fixture.whenStable();
    submitReprint(fixture, 'Client lost it');
    const lost = http.expectOne('/api/c/company-1/print-requests');
    const body = record(lost.request.body);
    lost.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    fixture.detectChanges();
    expect(component.pending()?.body).toEqual(body);
    expect(component.pending()?.lost).toBe(true);
    expect(buttonLabels(fixture)).toEqual(['Send the same request again']);
    component.reprintReason.set('A different reason entirely');
    component.print(true);
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);

    component.retry();
    const unavailable = http.expectOne('/api/c/company-1/print-requests');
    expect(unavailable.request.body).toEqual(body);
    unavailable.flush(null, { status: 503, statusText: 'Service Unavailable' });
    expect(component.pending()?.body).toEqual(body);

    component.retry();
    const unread = http.expectOne('/api/c/company-1/print-requests');
    expect(unread.request.body).toEqual(body);
    unread.error(new ProgressEvent('error'), { status: 200, statusText: 'OK' });
    expect(component.pending()?.body).toEqual(body);

    component.retry();
    const empty = http.expectOne('/api/c/company-1/print-requests');
    expect(empty.request.body).toEqual(body);
    empty.flush({});
    expect(component.pending()?.body).toEqual(body);
    expect(stored(PACKING_KEY).body).toEqual(body);

    component.retry();
    const resent = http.expectOne('/api/c/company-1/print-requests');
    expect(resent.request.body).toEqual(body);
    resent.flush({ printJob: slot('queued') });
    fixture.detectChanges();
    expect(component.pending()).toBeNull();
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();
    expect(component.reprintReason()).toBe('');
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]')).toBeNull();
    expect(exactButton(fixture, 'Reprint')).toBeInstanceOf(HTMLButtonElement);
    expect(textOf(fixture)).not.toContain('Send the same request again');
    http.verify();
  });

  it('keeps a lost request when a retry is refused, and discards it only by choice', async () => {
    const { fixture, http, component } = await setup(60_000);
    fixture.componentRef.setInput('firstPrintAvailable', false);
    fixture.componentRef.setInput('job', slot('confirmed_printed'));
    fixture.detectChanges();
    await fixture.whenStable();
    submitReprint(fixture, 'Client lost it');
    http
      .expectOne('/api/c/company-1/print-requests')
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    fixture.detectChanges();
    expect(component.pending()?.lost).toBe(true);
    component.discard();
    expect(component.pending()).not.toBeNull();
    expect(exactButton(fixture, 'Discard this request')).toBeUndefined();

    component.retry();
    http
      .expectOne('/api/c/company-1/print-requests')
      .flush(
        { error: { code: 'too_many_requests', message: 'slow down', correlationId: 'corr-4' } },
        { status: 429, statusText: 'Too Many Requests' },
      );
    fixture.detectChanges();
    expect(component.pending()?.lost).toBe(true);
    expect(component.retryRefused()).toBe(true);
    expect(buttonLabels(fixture)).toEqual(['Send the same request again', 'Discard this request']);
    expect(textOf(fixture)).toContain('Check the print history first');
    exactButton(fixture, 'Discard this request')?.click();
    fixture.detectChanges();
    expect(component.pending()).toBeNull();
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();
    expect(textOf(fixture)).not.toContain('Send the same request again');
    expect(exactButton(fixture, 'Reprint')).toBeInstanceOf(HTMLButtonElement);
    http.verify();
  });

  it('settles a first attempt answered with a definite refusal', async () => {
    const { fixture, http, component } = await setup(60_000);
    let changed = 0;
    component.changed.subscribe(() => {
      changed += 1;
    });
    button(fixture, 'Print').click();
    const refused = http.expectOne('/api/c/company-1/print-requests');
    const firstKey = record(refused.request.body)['requestKey'];
    refused.flush(
      { error: { code: 'printer_not_mapped', message: 'x', correlationId: 'corr-422' } },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    fixture.detectChanges();
    expect(changed).toBe(0);
    expect(component.pending()).toBeNull();
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();
    expect(textOf(fixture)).not.toContain('Send the same request again');
    expect(exactButton(fixture, 'Print')).toBeInstanceOf(HTMLButtonElement);

    button(fixture, 'Print').click();
    const conflict = http.expectOne('/api/c/company-1/print-requests');
    expect(record(conflict.request.body)['requestKey']).not.toBe(firstKey);
    conflict.flush(
      {
        error: {
          code: 'already_printed',
          message: 'already_printed',
          correlationId: 'corr-409',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();
    expect(changed).toBe(1);
    expect(component.pending()).toBeNull();
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();
    expect(exactButton(fixture, 'Print')).toBeInstanceOf(HTMLButtonElement);
    http.verify();
  });

  it('sends nothing when storage throws or silently refuses', async () => {
    const { fixture, http, component } = await setup(60_000);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    setItem.mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      button(fixture, 'Print').click();
      fixture.detectChanges();
      expect(http.match(() => true)).toHaveLength(0);
      expect(component.pending()).toBeNull();
      expect(textOf(fixture)).toContain('Nothing was sent');
    } finally {
      setItem.mockRestore();
    }

    button(fixture, 'Print').click();
    http.expectOne('/api/c/company-1/print-requests').flush({ printJob: slot('queued') });
    expect(component.pending()).toBeNull();

    const silent = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    try {
      button(fixture, 'Print').click();
      fixture.detectChanges();
      expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
      expect(component.pending()).toBeNull();
      expect(textOf(fixture)).toContain('Nothing was sent');
    } finally {
      silent.mockRestore();
    }
    http.verify();
  });

  it('ignores a late answer after switching orders', async () => {
    const { fixture, http, component } = await setup(60_000);
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    const firstBody = record(first.request.body);
    fixture.componentRef.setInput('orderId', 'order-2');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.pending()).toBeNull();
    expect(stored('bp.orderPrint.company-1.order-1.packing_slip')).toEqual({
      body: firstBody,
      lost: false,
    });
    component.reprintReason.set('Keep this');
    button(fixture, 'Print').click();
    const second = http.expectOne('/api/c/company-1/print-requests');
    const secondBody = record(second.request.body);
    expect(secondBody['sourceId']).toBe('order-2');
    expect(secondBody['requestKey']).not.toBe(firstBody['requestKey']);
    first.flush({ printJob: { ...slot('queued'), id: 'job-old' } });
    fixture.detectChanges();
    expect(component.pending()?.body).toEqual(secondBody);
    expect(component.reprintReason()).toBe('Keep this');
    expect(component.live()?.id).not.toBe('job-old');
    expect(stored('bp.orderPrint.company-1.order-2.packing_slip').body).toEqual(secondBody);
    expect(stored('bp.orderPrint.company-1.order-1.packing_slip').body).toEqual(firstBody);
    second.flush({ printJob: { ...slot('queued'), id: 'job-new' } });
    expect(component.pending()).toBeNull();
    expect(component.live()?.id).toBe('job-new');
    expect(component.reprintReason()).toBe('');
    http.verify();
  });

  it('ignores a late answer after switching companies', async () => {
    const { fixture, http, component } = await setup(60_000);
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    const firstBody = record(first.request.body);
    fixture.componentRef.setInput('companyId', 'company-2');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.pending()).toBeNull();
    component.reprintReason.set('Keep this');
    button(fixture, 'Print').click();
    const second = http.expectOne('/api/c/company-2/print-requests');
    const secondBody = record(second.request.body);
    expect(secondBody['requestKey']).not.toBe(firstBody['requestKey']);
    first.flush({ printJob: { ...slot('queued'), id: 'job-old' } });
    fixture.detectChanges();
    expect(component.pending()?.body).toEqual(secondBody);
    expect(component.reprintReason()).toBe('Keep this');
    expect(component.live()?.id).not.toBe('job-old');
    expect(stored('bp.orderPrint.company-2.order-1.packing_slip').body).toEqual(secondBody);
    expect(stored(PACKING_KEY).body).toEqual(firstBody);
    second.flush({ printJob: { ...slot('queued'), id: 'job-new' } });
    expect(component.live()?.id).toBe('job-new');
    expect(component.pending()).toBeNull();
    http.verify();
  });

  it('ignores a late answer after switching document types', async () => {
    const { fixture, http, component } = await setup(60_000);
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    const firstBody = record(first.request.body);
    fixture.componentRef.setInput('documentType', 'gift_message');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.pending()).toBeNull();
    button(fixture, 'Print').click();
    const second = http.expectOne('/api/c/company-1/print-requests');
    const secondBody = record(second.request.body);
    expect(secondBody['documentType']).toBe('gift_message');
    expect(secondBody['requestKey']).not.toBe(firstBody['requestKey']);
    first.flush({ printJob: { ...slot('queued'), id: 'job-old' } });
    fixture.detectChanges();
    expect(component.pending()?.body).toEqual(secondBody);
    expect(component.live()?.id).not.toBe('job-old');
    expect(stored('bp.orderPrint.company-1.order-1.gift_message').body).toEqual(secondBody);
    expect(stored(PACKING_KEY).body).toEqual(firstBody);
    second.flush({ printJob: slot('queued') });
    expect(component.pending()).toBeNull();
    http.verify();
  });

  it('does not let a destroyed panel clear a newer attempt', async () => {
    const { fixture, http } = await setup(60_000);
    button(fixture, 'Print').click();
    const left = http.expectOne('/api/c/company-1/print-requests');
    const firstKey = record(left.request.body)['requestKey'];
    fixture.destroy();
    expect(left.cancelled).toBe(true);

    const back = TestBed.createComponent(PrintPanelComponent);
    back.componentRef.setInput('companyId', 'company-1');
    back.componentRef.setInput('orderId', 'order-1');
    back.componentRef.setInput('documentType', 'packing_slip');
    back.componentRef.setInput('canSubmit', true);
    back.componentRef.setInput('canReprint', true);
    back.componentRef.setInput('canConfirm', true);
    back.componentRef.setInput('job', null);
    back.detectChanges();
    await back.whenStable();
    const panel = back.componentInstance;
    expect(panel.pending()?.lost).toBe(true);
    expect(panel.pending()?.body['requestKey']).toBe(firstKey);
    exactButton(back, 'Send the same request again')?.click();
    http.expectOne('/api/c/company-1/print-requests').flush({ printJob: slot('queued') });
    back.detectChanges();
    expect(panel.pending()).toBeNull();
    button(back, 'Print').click();
    const newer = http.expectOne('/api/c/company-1/print-requests');
    const newerKey = record(newer.request.body)['requestKey'];
    expect(newerKey).not.toBe(firstKey);
    const saved = sessionStorage.getItem(PACKING_KEY) ?? '';
    expect(saved).toContain(String(newerKey));
    newer.flush({ printJob: slot('queued') });
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();
    http.verify();
  });

  it('does not replace a saved reprint when a reload cannot read it', async () => {
    const { fixture, http } = await setup(60_000);
    fixture.componentRef.setInput('job', slot('confirmed_printed'));
    fixture.detectChanges();
    await fixture.whenStable();
    submitReprint(fixture, 'Client lost it');
    const lost = http.expectOne('/api/c/company-1/print-requests');
    const body = record(lost.request.body);
    lost.flush(null, { status: 503, statusText: 'Service Unavailable' });
    fixture.detectChanges();
    const saved = sessionStorage.getItem(PACKING_KEY);
    expect(saved).toContain(String(body['requestKey']));
    fixture.destroy();

    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const back = TestBed.createComponent(PrintPanelComponent);
    try {
      mountOrder(back, slot('confirmed_printed'));
      await back.whenStable();
      const panel = back.componentInstance;
      expect(panel.cannotCheck()).toBe(true);
      expect(panel.pending()).toBeNull();
      expect(textOf(back)).toContain('Look at the print history');
      expect(exactButton(back, 'Check again')).toBeInstanceOf(HTMLButtonElement);
      expect(exactButton(back, 'Print')).toBeUndefined();
      expect(exactButton(back, 'Reprint')).toBeUndefined();
    } finally {
      getItem.mockRestore();
    }

    const panel = back.componentInstance;
    panel.reprintReason.set('Client lost it');
    panel.print(true);
    panel.print(false);
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
    expect(sessionStorage.getItem(PACKING_KEY)).toBe(saved);
    const check = exactButton(back, 'Check again');
    expect(check).toBeInstanceOf(HTMLButtonElement);
    check?.click();
    back.detectChanges();
    expect(panel.cannotCheck()).toBe(false);
    expect(panel.pending()?.lost).toBe(true);
    expect(panel.pending()?.body).toEqual(body);
    expect(sessionStorage.getItem(PACKING_KEY)).toBe(saved);
    const retry = exactButton(back, 'Send the same request again');
    expect(retry).toBeInstanceOf(HTMLButtonElement);
    retry?.click();
    const again = http.expectOne('/api/c/company-1/print-requests');
    expect(record(again.request.body)).toEqual(body);
    again.flush({ printJob: slot('confirmed_printed') });
    expect(sessionStorage.getItem(PACKING_KEY)).toBeNull();
    http.verify();
  });

  it('does not replace a saved request that cannot be parsed', async () => {
    const { fixture, http } = await setup(60_000);
    fixture.destroy();
    sessionStorage.setItem(PACKING_KEY, '{');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const back = TestBed.createComponent(PrintPanelComponent);
    mountOrder(back, slot('confirmed_printed'));
    await back.whenStable();
    const panel = back.componentInstance;
    expect(panel.cannotCheck()).toBe(true);
    expect(textOf(back)).toContain('Look at the print history');
    expect(exactButton(back, 'Print')).toBeUndefined();
    expect(exactButton(back, 'Reprint')).toBeUndefined();
    panel.reprintReason.set('Client lost it');
    panel.print(false);
    panel.print(true);
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PACKING_KEY)).toBe('{');
    const body = {
      documentType: 'packing_slip',
      sourceType: 'order',
      sourceId: 'order-1',
      requestKey: '11111111-1111-4111-8111-111111111111',
    };
    const repaired = JSON.stringify({ body, lost: true });
    sessionStorage.setItem(PACKING_KEY, repaired);
    exactButton(back, 'Check again')?.click();
    back.detectChanges();
    expect(panel.cannotCheck()).toBe(false);
    expect(panel.pending()?.body).toEqual(body);
    expect(panel.pending()?.lost).toBe(true);
    expect(sessionStorage.getItem(PACKING_KEY)).toBe(repaired);
    http.verify();
  });

  it('shows the storage error and sends nothing when site storage is blocked', async () => {
    const { fixture, http, component } = await setup(60_000);
    const restore = blockSiteStorage();
    try {
      button(fixture, 'Print').click();
      fixture.detectChanges();
      expect(http.match(() => true)).toHaveLength(0);
      expect(component.pending()).toBeNull();
      expect(component.cannotCheck()).toBe(false);
      expect(textOf(fixture)).toContain('Nothing was sent');
      expect(textOf(fixture)).not.toContain('Cannot check an earlier print request');
    } finally {
      restore();
    }
    http.verify();
  });

  it('asks how many characters will be left out and sends the acknowledgement with a new key', async () => {
    const { fixture, http } = await setup(60_000);
    fixture.componentRef.setInput('documentType', 'gift_message');
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    const firstKey = record(first.request.body)['requestKey'];
    first.flush(giftReviewBody({ fits: true, omittedCount: 2 }), {
      status: 422,
      statusText: 'Unprocessable Entity',
    });
    fixture.detectChanges();
    const dialog = omitDialog(fixture);
    expect(dialog.textContent).toContain('2 character');
    expect(dialog.textContent).not.toContain('U+0378');
    expect(dialog.textContent).not.toContain('SENTINEL-GIFT');
    const area = omitReason(dialog);
    area.value = 'nope';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(dialogButton(fixture).disabled).toBe(true);
    area.value = 'leave them out';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(dialogButton(fixture).disabled).toBe(false);
    dialogButton(fixture).click();
    const second = http.expectOne('/api/c/company-1/print-requests');
    const body = record(second.request.body);
    expect(body['unprintableAcknowledged']).toBe(true);
    expect(body['unprintableReason']).toBe('leave them out');
    expect(body['requestKey']).not.toBe(firstKey);
    expect(JSON.stringify(body)).not.toContain('SENTINEL-GIFT');
    second.flush({ printJob: { ...slot('queued'), documentType: 'gift_message' } });
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="omit-dialog"]'),
    ).toBeNull();
    http.verify();
  });

  it('keeps a reprint when the confirmation leaves characters out', async () => {
    const { fixture, http } = await setup(60_000);
    fixture.componentRef.setInput('documentType', 'gift_message');
    fixture.componentRef.setInput('canSubmit', false);
    fixture.componentRef.setInput('canReprint', true);
    fixture.componentRef.setInput('firstPrintAvailable', false);
    fixture.componentRef.setInput('job', {
      ...slot('confirmed_printed'),
      documentType: 'gift_message',
    });
    fixture.detectChanges();
    await fixture.whenStable();
    submitReprint(fixture, 'Client lost it');
    const first = http.expectOne('/api/c/company-1/print-requests');
    first.flush(giftReviewBody({ fits: true, omittedCount: 1 }), {
      status: 422,
      statusText: 'Unprocessable Entity',
    });
    fixture.detectChanges();
    const area = omitReason(omitDialog(fixture));
    area.value = 'leave them out';
    area.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    dialogButton(fixture).click();
    const second = http.expectOne('/api/c/company-1/print-requests');
    expect(record(second.request.body)).toMatchObject({
      unprintableAcknowledged: true,
      unprintableReason: 'leave them out',
      reprint: { ofPrintJobId: 'job-1', reason: 'Client lost it' },
    });
    second.flush({ printJob: { ...slot('queued'), documentType: 'gift_message' } });
    http.verify();
  });

  it('does not offer the confirmation when the message does not fit', async () => {
    const { fixture, http } = await setup(60_000);
    fixture.componentRef.setInput('documentType', 'gift_message');
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Print').click();
    http
      .expectOne('/api/c/company-1/print-requests')
      .flush(giftReviewBody({ fits: false, omittedCount: 0 }), {
        status: 422,
        statusText: 'Unprocessable Entity',
      });
    fixture.detectChanges();
    expect(textOf(fixture)).toContain('does not fit');
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="omit-dialog"]'),
    ).toBeNull();
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
    http.verify();
  });

  it('shows the exact omitted count when more than 10000 characters are left out', async () => {
    const { fixture, http, component } = await setup(60_000);
    fixture.componentRef.setInput('documentType', 'gift_message');
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Print').click();
    http
      .expectOne('/api/c/company-1/print-requests')
      .flush(giftReviewBody({ fits: true, omittedCount: 10_001 }), {
        status: 422,
        statusText: 'Unprocessable Entity',
      });
    fixture.detectChanges();
    expect(component.omittedCount()).toBe(10_001);
    const dialog = omitDialog(fixture);
    expect(dialog.textContent).toContain('10001 character');
    expect(dialog.textContent).not.toContain('SENTINEL-GIFT');
    http.verify();
  });
});

function giftReviewBody(review: { fits: boolean; omittedCount: number }): {
  error: Record<string, unknown>;
} {
  return {
    error: {
      code: 'gift_message_needs_review',
      message: 'gift_message_needs_review',
      correlationId: 'corr-gift',
      fits: review.fits,
      unsupportedChars: review.omittedCount > 0 ? ['U+0378'] : [],
      omittedCount: review.omittedCount,
      giftMessage: 'SENTINEL-GIFT',
    },
  };
}

function omitDialog(fixture: ComponentFixture<PrintPanelComponent>): HTMLElement {
  const dialog: unknown = (fixture.nativeElement as HTMLElement).querySelector(
    '[data-testid="omit-dialog"]',
  );
  if (!(dialog instanceof HTMLElement)) {
    throw new Error('missing omit dialog');
  }
  return dialog;
}

function omitReason(dialog: HTMLElement): HTMLTextAreaElement {
  const area: unknown = dialog.querySelector('[data-testid="omit-reason"]');
  if (!(area instanceof HTMLTextAreaElement)) {
    throw new Error('missing omit reason');
  }
  return area;
}

async function setup(
  pollMs = 30,
  pollLimitMs = 10_000,
): Promise<{
  fixture: ComponentFixture<PrintPanelComponent>;
  http: HttpTestingController;
  component: PrintPanelComponent;
}> {
  sessionStorage.clear();
  await TestBed.configureTestingModule({
    imports: [PrintPanelComponent],
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
      { provide: PRINT_POLL_MS, useValue: pollMs },
      { provide: PRINT_POLL_LIMIT_MS, useValue: pollLimitMs },
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  const fixture = TestBed.createComponent(PrintPanelComponent);
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('orderId', 'order-1');
  fixture.componentRef.setInput('documentType', 'packing_slip');
  fixture.componentRef.setInput('canSubmit', true);
  fixture.componentRef.setInput('canReprint', true);
  fixture.componentRef.setInput('canConfirm', true);
  fixture.componentRef.setInput('job', null);
  fixture.detectChanges();
  return {
    fixture,
    http: TestBed.inject(HttpTestingController),
    component: fixture.componentInstance,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected an object');
  }
  return value as Record<string, unknown>;
}

function stored(key: string): { body: unknown; lost: boolean } {
  const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
  if (typeof parsed !== 'object' || parsed === null || !('body' in parsed) || !('lost' in parsed)) {
    throw new Error(`missing pending print ${key}`);
  }
  return parsed as { body: unknown; lost: boolean };
}

function buttonLabels(fixture: ComponentFixture<PrintPanelComponent>): string[] {
  const element = fixture.nativeElement as HTMLElement;
  return [...element.querySelectorAll('button')].map((item) => item.textContent.trim());
}

function mountOrder(fixture: ComponentFixture<PrintPanelComponent>, job: PrintSlot | null): void {
  fixture.componentRef.setInput('companyId', 'company-1');
  fixture.componentRef.setInput('orderId', 'order-1');
  fixture.componentRef.setInput('documentType', 'packing_slip');
  fixture.componentRef.setInput('canSubmit', true);
  fixture.componentRef.setInput('canReprint', true);
  fixture.componentRef.setInput('canConfirm', true);
  fixture.componentRef.setInput('job', job);
  fixture.detectChanges();
}

/** Site storage blocked: reading the storage object itself throws. */
function blockSiteStorage(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  if (!descriptor) {
    throw new Error('sessionStorage cannot be blocked in this environment');
  }
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
  return () => {
    Object.defineProperty(globalThis, 'sessionStorage', descriptor);
  };
}

function submitReprint(fixture: ComponentFixture<PrintPanelComponent>, reason: string): void {
  button(fixture, 'Reprint').click();
  fixture.detectChanges();
  const area = textarea(fixture);
  area.value = reason;
  area.dispatchEvent(new Event('input'));
  fixture.detectChanges();
  dialogButton(fixture).click();
}

function slot(status: string): PrintSlot {
  return {
    id: 'job-1',
    documentType: 'packing_slip',
    status,
    isReprint: false,
    createdAt: '2026-03-29T00:30:00Z',
    provider: 'mock',
    label: status,
  };
}

function exactButton(
  fixture: ComponentFixture<PrintPanelComponent>,
  name: string,
): HTMLButtonElement | undefined {
  const element = fixture.nativeElement as HTMLElement;
  return [...element.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
}

function button(fixture: ComponentFixture<PrintPanelComponent>, name: string): HTMLButtonElement {
  const element = fixture.nativeElement as HTMLElement;
  const found = [...element.querySelectorAll('button')].find((item) =>
    item.textContent.includes(name),
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing button ${name}`);
  }
  return found;
}

function dialogButton(fixture: ComponentFixture<PrintPanelComponent>): HTMLButtonElement {
  const dialog: unknown = (fixture.nativeElement as HTMLElement).querySelector('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error('missing reprint dialog');
  }
  const found = dialog.querySelector('button');
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error('missing reprint submit');
  }
  return found;
}

function textarea(fixture: ComponentFixture<PrintPanelComponent>): HTMLTextAreaElement {
  const area: unknown = (fixture.nativeElement as HTMLElement).querySelector('textarea');
  if (!(area instanceof HTMLTextAreaElement)) {
    throw new Error('missing reason');
  }
  return area;
}

function textOf(fixture: ComponentFixture<PrintPanelComponent>): string {
  return (fixture.nativeElement as HTMLElement).textContent;
}

function statusText(fixture: ComponentFixture<PrintPanelComponent>): string {
  const status: unknown = (fixture.nativeElement as HTMLElement).querySelector(
    '[data-testid="print-status"]',
  );
  return status instanceof HTMLElement ? status.textContent.trim() : '';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
