import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Locator, type Response } from '@playwright/test';
import {
  API_SETTLE_MS,
  ApiFlight,
  CSP_BINDING,
  ReportCollector,
  cspInitScript,
  expectedConsoleError,
  invoiceEditorLoaded,
  invoicesLoaded,
  orderDetailLoaded,
  ordersLoaded,
} from './csp-watch';
import { repositoryRoot } from './root';
import { readState, type InvoiceTotals } from './state';

/**
 * Proves the local stack's SPA has no CSP violations.
 * Playwright 1.64 has no per-context or per-launch CA option. clientCertificates
 * is client authentication, not a trust store for the server certificate.
 * Scoped trust, and nothing is added to the system trust store:
 * - OpenSSL verifies the leaf against only the exported Caddy root, with
 *   -verify_return_error and -verify_hostname localhost, and fails closed.
 * - Chromium is launched with --ignore-certificate-errors-spki-list for that leaf.
 * - The context aborts every request whose origin is not https://localhost:8443.
 * ignoreHTTPSErrors stays false.
 */
const ORIGIN = 'https://localhost:8443';
const CA_PATH = 'var/local-stack/caddy-root.crt';

const entry = process.argv[1] ?? '';
if (entry.endsWith('csp-check.ts') || entry.endsWith('csp-check.js')) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'csp check failed');
      process.exitCode = 1;
    },
  );
}

async function main(): Promise<number> {
  const root = repositoryRoot();
  const state = loadMilestoneState(root);
  const caPath = resolve(root, CA_PATH);
  if (!existsSync(caPath)) {
    throw new Error(`Caddy root CA is missing at ${CA_PATH}`);
  }
  const spki = leafSpki(caPath);
  const collector = new ReportCollector();
  const browser = await chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${spki}`],
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    await context.exposeBinding(CSP_BINDING, (_source, text: unknown) => {
      if (typeof text === 'string' && text.length > 0) {
        collector.add('csp', text);
      }
    });
    await context.addInitScript(cspInitScript(CSP_BINDING));
    await context.route('**/*', async (route) => {
      let origin = '';
      try {
        origin = new URL(route.request().url()).origin;
      } catch {
        origin = '';
      }
      if (origin !== ORIGIN) {
        await route.abort();
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    const flight = new ApiFlight();
    page.on('request', (request) => {
      flight.start(request.url());
    });
    page.on('requestfinished', (request) => {
      flight.finish(request.url());
    });
    page.on('requestfailed', (request) => {
      flight.finish(request.url());
    });
    let signedIn = false;
    let expectedErrors = 0;
    page.on('console', (message) => {
      if (message.type() === 'error') {
        if (
          expectedConsoleError({
            text: message.text(),
            url: message.location().url,
            signedIn,
            origin: ORIGIN,
          })
        ) {
          expectedErrors += 1;
          return;
        }
        collector.add('console', message.text());
      }
    });
    page.on('pageerror', (error) => {
      collector.add('pageerror', error.message);
    });
    const settle = (): Promise<void> => flight.waitIdle(API_SETTLE_MS, delay);
    const health = await page.goto(`${ORIGIN}/api/health/ready`, { waitUntil: 'domcontentloaded' });
    assertNoHsts(health, 'api health');
    await settle();
    const login = await page.goto(`${ORIGIN}/login`, { waitUntil: 'domcontentloaded' });
    assertDocumentHeaders(login, 'login');
    await page.getByRole('button', { name: 'admin.a@example.test' }).waitFor();
    await settle();
    await page.getByRole('button', { name: 'admin.a@example.test' }).click();
    await page.waitForURL(/\/c\/[0-9a-f-]{36}/i);
    signedIn = true;
    const orders = await page.goto(`${ORIGIN}/c/${state.companyA}/orders`, {
      waitUntil: 'domcontentloaded',
    });
    assertDocumentHeaders(orders, 'orders');
    const orderRows = page.locator('.order-table tbody tr, .order-card').filter({ visible: true });
    await orderRows.first().waitFor();
    if (!ordersLoaded(await orderRows.count())) {
      throw new Error('orders have no data row');
    }
    await settle();
    const orderHref = await page.getByRole('link', { name: '#1001' }).getAttribute('href');
    if (!orderHref) {
      throw new Error('order link was not shown');
    }
    const order = await page.goto(new URL(orderHref, ORIGIN).toString(), {
      waitUntil: 'domcontentloaded',
    });
    assertDocumentHeaders(order, 'order');
    const giftMessage = page.locator('[data-testid="gift-message"]').filter({ visible: true });
    const fulfilmentStatus = page
      .locator('[data-testid="fulfilment-status"]')
      .filter({ visible: true });
    await giftMessage.or(fulfilmentStatus).first().waitFor();
    if (
      !orderDetailLoaded({
        giftMessage: (await giftMessage.count()) > 0,
        statusBlock: (await fulfilmentStatus.count()) > 0,
      })
    ) {
      throw new Error('order detail has no gift message or status');
    }
    await settle();
    const invoices = await page.goto(`${ORIGIN}/c/${state.companyA}/invoices`, {
      waitUntil: 'domcontentloaded',
    });
    assertDocumentHeaders(invoices, 'invoices');
    const invoiceRows = page.locator('bp-invoice-list tbody tr').filter({ visible: true });
    const invoiceEmpty = page.getByText('No invoices', { exact: true }).filter({ visible: true });
    await invoiceRows.or(invoiceEmpty).first().waitFor();
    if (
      !invoicesLoaded({
        rows: await invoiceRows.count(),
        empty: (await invoiceEmpty.count()) > 0,
      })
    ) {
      throw new Error('invoices have no row and no empty state');
    }
    await settle();
    const editor = await page.goto(`${ORIGIN}/c/${state.companyA}/invoices/${state.invoiceId}`, {
      waitUntil: 'domcontentloaded',
    });
    assertDocumentHeaders(editor, 'invoice editor');
    const invoiceTotals = page.locator('[data-testid="invoice-totals"]').filter({ visible: true });
    await invoiceTotals.waitFor();
    const invoiceTotal = page
      .locator('[data-testid="invoice-totals"] [data-testid="total"]')
      .filter({ visible: true });
    await invoiceTotal.waitFor();
    await page.waitForFunction(`() => {
      for (const select of document.querySelectorAll('select')) {
        for (const option of select.options) {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(option.value)) {
            return true;
          }
        }
      }
      return false;
    }`);
    const totals: InvoiceTotals = {
      subtotal: await trimmedText(invoiceTotals.locator('[data-testid="subtotal"]')),
      discountTotal: await trimmedText(invoiceTotals.locator('[data-testid="discount"]')),
      netTotal: await trimmedText(invoiceTotals.locator('[data-testid="net"]')),
      taxTotal: await trimmedText(invoiceTotals.locator('[data-testid="tax"]')),
      total: await trimmedText(invoiceTotal),
    };
    const catalogOptions = await page.locator('select option').evaluateAll((options) => {
      return options.filter((option) => {
        const value = option.getAttribute('value') ?? '';
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      }).length;
    });
    if (!invoiceEditorLoaded({ totals, expected: state.invoiceTotals, catalogOptions })) {
      throw new Error(
        `invoice editor showed ${totalsLabel(totals)}; expected ${totalsLabel(state.invoiceTotals)}`,
      );
    }
    await settle();
    if (collector.failures.length > 0) {
      console.error(`console errors and csp violations: ${String(collector.failures.length)}`);
      for (const failure of collector.failures) {
        console.error(failure);
      }
      return 1;
    }
    console.log('csp check passed');
    console.log(`expected pre-login 401 on /api/me: ${String(expectedErrors)}`);
    console.log('headers: nosniff, referrer-policy, permissions-policy, csp; no HSTS; no Server');
    return 0;
  } finally {
    await browser.close();
  }
}

function loadMilestoneState(root: string) {
  try {
    return readState(resolve(root, 'var/milestone-state.json'));
  } catch {
    throw new Error('milestone state is missing; run pnpm milestone:verify --phase=initial first');
  }
}

function totalsLabel(totals: InvoiceTotals): string {
  return `subtotal ${totals.subtotal}, discount ${totals.discountTotal}, net ${totals.netTotal}, tax ${totals.taxTotal}, total ${totals.total}`;
}

async function trimmedText(locator: Locator): Promise<string> {
  const text = await locator.textContent();
  return (text ?? '').trim();
}

function leafSpki(caPath: string): string {
  const client = execFileSync(
    'openssl',
    [
      's_client',
      '-connect',
      'localhost:8443',
      '-servername',
      'localhost',
      '-CAfile',
      caPath,
      '-verify_return_error',
      '-verify_hostname',
      'localhost',
    ],
    { input: '', timeout: 15_000 },
  );
  const text = client.toString('utf8');
  if (!text.includes('Verify return code: 0 (ok)')) {
    throw new Error('certificate verification failed');
  }
  const pem = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text);
  if (!pem) {
    throw new Error('the local certificate did not verify against the Caddy root CA');
  }
  const pubkey = execFileSync('openssl', ['x509', '-pubkey', '-noout'], { input: pem[0] });
  const der = execFileSync('openssl', ['pkey', '-pubin', '-outform', 'der'], { input: pubkey });
  return execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: der }).toString('base64');
}

function assertNoHsts(response: Response | null, name: string): void {
  if (!response || !response.ok()) {
    throw new Error(`${name} was not served`);
  }
  if (response.headers()['strict-transport-security']) {
    throw new Error('HSTS is set on the local stack');
  }
}

function assertDocumentHeaders(response: Response | null, name: string): void {
  if (!response || !response.ok()) {
    throw new Error(`${name} document was not served`);
  }
  const headers = response.headers();
  if (headers['strict-transport-security']) {
    throw new Error('HSTS is set on the local stack');
  }
  if (headers['server']) {
    throw new Error('Server header is present');
  }
  expectHeader(headers, 'x-content-type-options', 'nosniff');
  expectHeader(headers, 'referrer-policy', 'strict-origin-when-cross-origin');
  const permissions = headers['permissions-policy'] ?? '';
  for (const part of ['camera=()', 'microphone=()', 'geolocation=()']) {
    if (!permissions.includes(part)) {
      throw new Error(`Permissions-Policy is missing ${part}`);
    }
  }
  const csp = headers['content-security-policy'] ?? '';
  for (const part of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ]) {
    if (!csp.includes(part)) {
      throw new Error(`CSP is missing ${part}`);
    }
  }
  if (csp.includes('unsafe-eval') || /script-src[^;]*unsafe-inline/.test(csp)) {
    throw new Error('CSP allows inline or eval scripts');
  }
}

function expectHeader(headers: Record<string, string>, name: string, expected: string): void {
  if (headers[name] !== expected) {
    throw new Error(`${name} was not ${expected}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
