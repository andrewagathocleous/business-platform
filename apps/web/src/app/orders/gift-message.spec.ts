import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTransloco, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppTranslocoLoader } from '../i18n/transloco-loader';
import { GiftMessageComponent } from './gift-message';

const gift = '  Χρόνια πολλά!\n\n<b>Love</b> & 😊  ';

describe('GiftMessageComponent', () => {
  it('shows the API string exactly, as text, with pre-wrap', async () => {
    await TestBed.configureTestingModule({
      imports: [GiftMessageComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideTransloco({
          config: { availableLangs: ['en', 'el'], defaultLang: 'en', reRenderOnLangChange: true, prodMode: true },
          loader: AppTranslocoLoader,
        }),
      ],
    }).compileComponents();
    await firstValueFrom(TestBed.inject(TranslocoService).load('en'));
    const fixture: ComponentFixture<GiftMessageComponent> = TestBed.createComponent(GiftMessageComponent);
    fixture.componentRef.setInput('message', gift);
    fixture.detectChanges();
    const box = boxOf(fixture);
    expect(box.textContent).toBe(gift);
    expect(box.querySelector('b')).toBeNull();
    expect(getComputedStyle(box).whiteSpace).toBe('pre-wrap');
  });
});

function boxOf(fixture: ComponentFixture<GiftMessageComponent>): HTMLElement {
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) {
    throw new Error('missing root');
  }
  const box: unknown = root.querySelector('[data-testid="gift-message"]');
  if (!(box instanceof HTMLElement)) {
    throw new Error('gift message box is missing');
  }
  return box;
}
