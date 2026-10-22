import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_SETTLE_MS,
  ApiFlight,
  CSP_BINDING,
  ReportCollector,
  cspInitScript,
  invoiceEditorLoaded,
  invoicesLoaded,
  orderDetailLoaded,
  ordersLoaded,
} from './csp-watch';
import { repositoryRoot } from './root';

describe('csp reports', () => {
  it('delivers a violation to Node and keeps it when the document is replaced', () => {
    const collector = new ReportCollector();
    const script = cspInitScript(CSP_BINDING);
    expect(script).not.toContain('__csp');
    const binding = (text: string): void => {
      collector.add('csp', text);
    };
    const first = documentContext(binding);
    runInNewContext(script, first);
    first.dispatch({ violatedDirective: 'script-src', blockedURI: 'inline' });
    const second = documentContext(binding);
    runInNewContext(script, second);
    expect(collector.failures).toEqual(['csp: script-src inline']);
    expect(second.events).toEqual([]);
  });

  it('collects console and page errors outside the document', () => {
    const collector = new ReportCollector();
    collector.add('console', 'late error');
    collector.add('pageerror', 'render failed');
    expect(collector.failures).toEqual(['console: late error', 'pageerror: render failed']);
  });
});

describe('api flight', () => {
  it('ignores static files and waits again when an api request starts during the settle', async () => {
    const flight = new ApiFlight();
    flight.start('https://localhost:8443/main.js');
    expect(flight.pending).toBe(0);
    const releases: Array<() => void> = [];
    const done = flight.waitIdle(API_SETTLE_MS, () => {
      return new Promise((resolve) => {
        releases.push(resolve);
      });
    });
    await Promise.resolve();
    expect(releases).toHaveLength(1);
    flight.start('https://localhost:8443/api/c/company/orders');
    releases[0]?.();
    await Promise.resolve();
    expect(flight.pending).toBe(1);
    flight.finish('https://localhost:8443/api/c/company/orders');
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await done;
    expect(flight.pending).toBe(0);
  });
});

describe('loaded screens', () => {
  it('rejects a heading with no loaded content', () => {
    expect(ordersLoaded(0)).toBe(false);
    expect(ordersLoaded(1)).toBe(true);
    expect(orderDetailLoaded({ giftMessage: false, statusBlock: false })).toBe(false);
    expect(orderDetailLoaded({ giftMessage: true, statusBlock: false })).toBe(true);
    expect(orderDetailLoaded({ giftMessage: false, statusBlock: true })).toBe(true);
    expect(invoicesLoaded({ rows: 0, empty: false })).toBe(false);
    expect(invoicesLoaded({ rows: 0, empty: true })).toBe(true);
    expect(invoicesLoaded({ rows: 2, empty: false })).toBe(true);
    expect(invoiceEditorLoaded({ totalsText: '', catalogOptions: 3 })).toBe(false);
    expect(
      invoiceEditorLoaded({ totalsText: 'Totals not calculated yet', catalogOptions: 0 }),
    ).toBe(false);
    expect(invoiceEditorLoaded({ totalsText: '17.00', catalogOptions: 1 })).toBe(true);
  });
});

describe('csp check wiring', () => {
  it('installs the binding before page scripts and does not read a document array', () => {
    const source = readFileSync(resolve(repositoryRoot(), 'tools/milestone/csp-check.ts'), 'utf8');
    expect(source).not.toContain('__csp');
    expect(source).toContain('exposeBinding');
    expect(source).toContain('addInitScript');
    expect(source).toContain('order-card');
    expect(source).toContain('gift-message');
    expect(source).toContain('No invoices');
    expect(source).toContain('invoice-totals');
    expect(source).not.toContain("getByRole('heading', { name: 'Orders' })");
  });
});

function documentContext(binding: (text: string) => void) {
  const events: { violatedDirective: string; blockedURI: string }[] = [];
  const listeners: Array<(event: { violatedDirective: string; blockedURI: string }) => void> = [];
  return {
    events,
    dispatch(event: { violatedDirective: string; blockedURI: string }) {
      events.push(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
    addEventListener: (
      _type: string,
      listener: (event: { violatedDirective: string; blockedURI: string }) => void,
    ) => {
      listeners.push(listener);
    },
    [CSP_BINDING]: binding,
  };
}
