import { Injectable } from '@angular/core';
import { Translation, TranslocoLoader } from '@jsverse/transloco';
import { Observable, of } from 'rxjs';
import el from './el.json';
import en from './en.json';

@Injectable({ providedIn: 'root' })
export class AppTranslocoLoader implements TranslocoLoader {
  getTranslation(lang: string): Observable<Translation> {
    return of(asTranslation(lang === 'el' ? el : en));
  }
}

function asTranslation(value: object): Translation {
  const translation: Translation = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      translation[key] = entry;
    } else if (isRecord(entry)) {
      translation[key] = asTranslation(entry);
    }
  }
  return translation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
