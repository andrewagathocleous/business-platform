import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { MoneyRecordForm } from './record-form';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T21:59:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MoneyRecordForm', () => {
  it('defaults to the current company day and supplied balance and sends decimal strings and text as typed', async () => {
    const { component, fixture, submitted } = await setup();
    expect(component.date()).toBe('2026-10-28');
    expect(component.amount()).toBe('60.00');
    expect(root(fixture).querySelector('input[type=date]')?.getAttribute('max')).toBe('2026-10-28');
    component.amount.set('12,34');
    component.notes.set('Ευχαριστώ\n  exactly typed ');
    component.reference.set(' Demo ');
    component.submit();
    expect(submitted).toHaveBeenCalledWith({
      amount: '12.34',
      date: '2026-10-28',
      method: 'bank_transfer',
      reference: ' Demo ',
      notes: 'Ευχαριστώ\n  exactly typed ',
      apply: true,
    });
  });
  it('validates against the company day at submission across midnight without resetting typed fields', async () => {
    const { component, fixture, submitted } = await setup();
    component.date.set('2026-10-29');
    component.amount.set('12,34');
    component.notes.set('Keep\n  as typed ');
    component.submit();
    expect(submitted).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-28T22:01:00Z'));
    component.submit();
    expect(submitted).toHaveBeenCalledExactlyOnceWith({
      amount: '12.34',
      date: '2026-10-29',
      method: 'bank_transfer',
      reference: '',
      notes: 'Keep\n  as typed ',
      apply: true,
    });
    fixture.detectChanges();
    expect(root(fixture).querySelector('input[type=date]')?.getAttribute('max')).toBe('2026-10-29');
    expect(component.amount()).toBe('12,34');
    component.date.set('2026-10-30');
    component.submit();
    expect(submitted).toHaveBeenCalledOnce();
    expect(component.problem()).toBe(true);
  });
  it('refuses future dates and amounts needing rounding', async () => {
    const { component, submitted } = await setup();
    component.date.set('2026-10-29');
    component.submit();
    expect(submitted).not.toHaveBeenCalled();
    component.date.set('2026-10-28');
    component.amount.set('12.345');
    component.submit();
    expect(submitted).not.toHaveBeenCalled();
    expect(component.problem()).toBe(true);
  });
  it('freezes every field while busy and exposes only retry through the containing panel', async () => {
    const { component, fixture, submitted } = await setup();
    fixture.componentRef.setInput('disabled', true);
    fixture.componentRef.setInput('showSubmit', false);
    fixture.detectChanges();
    const fields = [
      ...root(fixture).querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select',
      ),
    ];
    expect(fields.length).toBe(6);
    expect(fields.every((item) => item.disabled)).toBe(true);
    expect(root(fixture).querySelector('button')).toBeNull();
    component.submit();
    expect(submitted).not.toHaveBeenCalled();
  });
});
async function setup() {
  await TestBed.configureTestingModule({
    imports: [MoneyRecordForm],
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideTransloco({
        config: { availableLangs: ['en', 'el'], defaultLang: 'en', prodMode: true },
        loader: AppTranslocoLoader,
      }),
    ],
  }).compileComponents();
  const transloco = TestBed.inject(TranslocoService);
  await firstValueFrom(transloco.load('en'));
  transloco.setActiveLang('en');
  const fixture = TestBed.createComponent(MoneyRecordForm);
  fixture.componentRef.setInput('initialAmount', '60.00');
  fixture.detectChanges();
  const submitted = vi.fn();
  fixture.componentInstance.submitted.subscribe(submitted);
  return { fixture, component: fixture.componentInstance, submitted };
}
function root(fixture: ComponentFixture<unknown>): HTMLElement {
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('no root');
  return value;
}
