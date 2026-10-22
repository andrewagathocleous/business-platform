/**
 * CSP and console reports live in Node. A navigation replaces the document,
 * so a page-scoped array would drop violations that arrived after the last read.
 */

export const CSP_BINDING = '__bpCspViolation';
export const API_SETTLE_MS = 300;

export class ReportCollector {
  private readonly items: string[] = [];

  add(kind: 'console' | 'pageerror' | 'csp', text: string): void {
    this.items.push(`${kind}: ${text}`);
  }

  get failures(): readonly string[] {
    return this.items;
  }
}

export function cspInitScript(bindingName: string): string {
  return `addEventListener('securitypolicyviolation', (event) => {
    const report = globalThis[${JSON.stringify(bindingName)}];
    if (typeof report === 'function') {
      void report(String(event.violatedDirective) + ' ' + String(event.blockedURI));
    }
  });`;
}

export function isApiUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === '/api' || path.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Tracks in-flight `/api/` requests. A request that starts during the settle restarts it. */
export class ApiFlight {
  private inflight = 0;
  private generation = 0;
  private readonly waiters: Array<() => void> = [];

  start(url: string): void {
    if (!isApiUrl(url)) {
      return;
    }
    this.inflight += 1;
    this.generation += 1;
  }

  finish(url: string): void {
    if (!isApiUrl(url)) {
      return;
    }
    if (this.inflight > 0) {
      this.inflight -= 1;
    }
    if (this.inflight === 0) {
      const waiters = this.waiters.splice(0);
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  get pending(): number {
    return this.inflight;
  }

  async waitIdle(settleMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    for (;;) {
      while (this.inflight > 0) {
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
        });
      }
      const seen = this.generation;
      await sleep(settleMs);
      if (this.inflight === 0 && this.generation === seen) {
        return;
      }
    }
  }
}

export function ordersLoaded(rowCount: number): boolean {
  return rowCount > 0;
}

export function orderDetailLoaded(input: { giftMessage: boolean; statusBlock: boolean }): boolean {
  return input.giftMessage || input.statusBlock;
}

export function invoicesLoaded(input: { rows: number; empty: boolean }): boolean {
  return input.rows > 0 || input.empty;
}

export function invoiceEditorLoaded(input: {
  totalsText: string;
  catalogOptions: number;
}): boolean {
  return input.totalsText.trim().length > 0 && input.catalogOptions > 0;
}
