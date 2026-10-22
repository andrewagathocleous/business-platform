import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
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

describe('PrintPanelComponent', () => {
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
    expect(textOf(fixture)).toContain('The previous job may still print — check the printer before reprinting');
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
    expect(textOf(fixture)).not.toContain('The previous job may still print — check the printer before reprinting');
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
    http.expectOne('/api/c/company-1/print-jobs/job-1').flush(
      { error: { message: 'Forbidden', correlationId: 'corr-403' } },
      { status: 403, statusText: 'Forbidden' },
    );
    fixture.detectChanges();
    await fixture.whenStable();
    expect(textOf(fixture)).toContain('Status updates stopped — this print job cannot be read');
    await wait(80);
    http.expectNone('/api/c/company-1/print-jobs/job-1');
  });

  it('sends one print request when Print is clicked again during a parent refresh', async () => {
    const { fixture, http } = await setup(60_000);
    fixture.componentRef.setInput('job', null);
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Print').click();
    const first = http.expectOne('/api/c/company-1/print-requests');
    fixture.componentRef.setInput('job', slot('failed'));
    fixture.detectChanges();
    await fixture.whenStable();
    button(fixture, 'Print').click();
    expect(http.match('/api/c/company-1/print-requests')).toHaveLength(0);
    first.flush({ printJob: slot('queued') });
    http.verify();
  });
});

async function setup(
  pollMs = 30,
  pollLimitMs = 10_000,
): Promise<{ fixture: ComponentFixture<PrintPanelComponent>; http: HttpTestingController }> {
  await TestBed.configureTestingModule({
    imports: [PrintPanelComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', reRenderOnLangChange: true, prodMode: true },
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
  return { fixture, http: TestBed.inject(HttpTestingController) };
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

function exactButton(fixture: ComponentFixture<PrintPanelComponent>, name: string): HTMLButtonElement | undefined {
  const element = fixture.nativeElement as HTMLElement;
  return [...element.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
}

function button(fixture: ComponentFixture<PrintPanelComponent>, name: string): HTMLButtonElement {
  const element = fixture.nativeElement as HTMLElement;
  const found = [...element.querySelectorAll('button')].find((item) => item.textContent.includes(name));
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
  const status: unknown = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="print-status"]');
  return status instanceof HTMLElement ? status.textContent.trim() : '';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
