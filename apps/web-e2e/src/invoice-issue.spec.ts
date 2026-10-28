import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { assertButtonContrast } from './button-contrast';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/r2c3');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

/**
 * Issued invoices are never deleted and lock the company currency, so this runs in a
 * company created for the run. The platform owner sets it up through the API, then issues
 * and records the delivery through the screens.
 */
test('the owner issues an invoice and records its paper delivery', async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString();
  await page.goto('/login');
  await expect(page.getByRole('status')).toContainText('DEVELOPMENT LOGIN — fictional users');
  await page.getByRole('button', { name: 'owner@example.test' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]+\//);

  const company = await api(page, 'post', '/api/platform/companies', {
    legalName: `E2E Issue ${stamp} Ltd (fictional)`,
    tradingName: `E2E Issue ${stamp}`,
    isFictional: true,
  });
  const companyId = text(field(field(company, 'company'), 'id'));
  const base = `/api/c/${companyId}`;
  const series = await api(page, 'post', `${base}/invoice-series`, {
    code: `E2E${stamp}`.slice(0, 32),
    documentType: 'invoice',
    prefix: `E${stamp.slice(-6)}-`,
  });
  const creditSeries = await api(page, 'post', `${base}/invoice-series`, {
    code: `E2C${stamp}`.slice(0, 32),
    documentType: 'credit_note',
    prefix: `C${stamp.slice(-6)}-`,
  });
  const details = await api(page, 'get', `${base}/context`);
  await api(page, 'patch', `${base}/company`, {
    expectedVersion: field(field(details, 'company'), 'version'),
    // Fictional: all zeros, not a registered number.
    vatNumber: 'CY00000000X',
    address: { line1: '1 Demo Street', city: 'Nicosia', postcode: '1010', countryCode: 'CY' },
    defaultInvoiceSeriesId: field(field(series, 'series'), 'id'),
    defaultCreditNoteSeriesId: field(field(creditSeries, 'series'), 'id'),
  });
  const client = await api(page, 'post', `${base}/clients`, {
    kind: 'organisation',
    displayName: `E2E Client ${stamp}`,
    addresses: [
      {
        kind: 'billing',
        line1: '2 Demo Road',
        city: 'Limassol',
        countryCode: 'CY',
        isDefault: true,
      },
    ],
  });
  const taxCodes = await api(page, 'get', `${base}/tax-codes`);
  const standard = list(field(taxCodes, 'taxCodes')).find(
    (code) => field(code, 'code') === 'STD19',
  );
  const draft = await api(page, 'post', `${base}/invoices`, {
    clientId: field(field(client, 'client'), 'id'),
    pricesIncludeTax: true,
    lines: [
      {
        position: 1,
        description: 'Mixed nuts gift box (demo)',
        quantity: '1',
        unit: 'box',
        unitPrice: '11.90',
        taxCodeId: field(standard, 'id'),
      },
    ],
  });
  const invoiceId = text(field(field(draft, 'invoice'), 'id'));
  await page.request.put(`${base}/automation/switches/invoice.issue_real`, {
    headers: await csrf(page),
    data: { enabled: true, reason: 'e2e issue test' },
  });

  await page.goto(`/c/${companyId}/invoices/${invoiceId}`);
  await ensureEnglish(page);
  const panel = page.getByTestId('issue-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByLabel('Supply date (empty: the issue date)')).toBeVisible();
  await checkScreen(page, 'invoice-draft-issue');
  await panel.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(panel).toContainText('cannot be edited or deleted');
  await panel.getByRole('button', { name: 'Issue now', exact: true }).click();

  const summary = page.getByTestId('issued-summary');
  await expect(summary).toContainText(`Invoice E${stamp.slice(-6)}-0001`);
  await expect(summary).toContainText('Deliver to the client by');
  await expect(page.getByTestId('issue-panel')).toHaveCount(0);
  await expect(page.getByText('DRAFT — not a tax invoice')).toHaveCount(0);
  const pdfUrl = await page
    .getByRole('link', { name: 'Open the issued PDF', exact: true })
    .getAttribute('href');
  const pdf = await page.request.get(pdfUrl ?? '');
  expect(pdf.ok()).toBe(true);
  expect((await pdf.body()).subarray(0, 4).toString('utf8')).toBe('%PDF');

  const deliveries = page.getByTestId('deliveries');
  await expect(deliveries).toContainText('No delivery recorded yet.');
  const record = deliveries.getByRole('button', { name: 'Record delivery', exact: true });
  await expect(record).toBeDisabled();
  await deliveries.getByLabel("The company's paper copy is kept in the file").check();
  await deliveries.getByLabel('Note').fill('Handed to reception (demo)');
  await record.click();
  await expect(summary).toContainText('Delivered on');
  await expect(deliveries).toContainText('Handed over');
  await expect(deliveries).toContainText('Handed to reception (demo)');
  await checkScreen(page, 'invoice-issued');

  await page.goto(`/c/${companyId}/invoices?delivery=pending`);
  await expect(page.getByRole('heading', { name: 'Invoices', exact: true })).toBeVisible();
  await expect(page.getByText('No invoices', { exact: true })).toBeVisible();
  await page.goto(`/c/${companyId}/invoices?status=issued`);
  await expect(
    page.getByRole('link', { name: `E${stamp.slice(-6)}-0001`, exact: true }),
  ).toBeVisible();
  await checkScreen(page, 'invoices-issued-list');

  // A credit note of the whole invoice: drafted on the invoice, issued in its own series.
  await page.goto(`/c/${companyId}/invoices/${invoiceId}`);
  const credits = page.getByTestId('credit-panel');
  await expect(credits).toContainText('No credit notes yet.');
  await credits.getByRole('button', { name: 'Create a credit note', exact: true }).click();
  await credits.getByLabel('Reason (printed on the credit note)').fill('Order cancelled (demo)');
  await credits.getByLabel('Chosen quantities').check();
  await expect(credits.getByLabel('Quantity to credit on line 1')).toBeVisible();
  await checkScreen(page, 'invoice-credit-form');
  await credits.getByLabel('Everything not yet credited').check();
  await credits.getByRole('button', { name: 'Create draft', exact: true }).click();
  const note = page.getByTestId('credit-note');
  await expect(note).toContainText('Credit note (draft)');
  await expect(note).toContainText(`Credits invoice E${stamp.slice(-6)}-0001`);
  await expect(note).toContainText('11.90 EUR');
  await checkScreen(page, 'credit-note-draft');
  const issueCredit = page.getByTestId('credit-issue-panel');
  await issueCredit.getByRole('button', { name: 'Issue credit note', exact: true }).click();
  await expect(issueCredit).toContainText('number in the credit-note series');
  await issueCredit.getByRole('button', { name: 'Issue now', exact: true }).click();
  await expect(page.getByTestId('issued-summary')).toContainText(
    `Credit note C${stamp.slice(-6)}-0001`,
  );
  await expect(page.getByTestId('credit-issue-panel')).toHaveCount(0);
  await expect(page.getByTestId('credit-reason')).toHaveText('Order cancelled (demo)');
  await checkScreen(page, 'credit-note-issued');
  await page
    .getByTestId('credit-note')
    .getByTestId('credited-invoice')
    .getByRole('link', { name: `E${stamp.slice(-6)}-0001`, exact: true })
    .click();
  await expect(page.getByTestId('credit-panel')).toContainText(
    'Everything on this invoice has been credited.',
  );
  await expect(page.getByTestId('credit-panel')).toContainText(`C${stamp.slice(-6)}-0001`);

  // A quote becomes a new draft invoice, once.
  const quote = await api(page, 'post', `${base}/invoices`, {
    documentType: 'quote',
    clientId: field(field(client, 'client'), 'id'),
    pricesIncludeTax: true,
    lines: [
      {
        position: 1,
        description: 'Quoted hamper (demo)',
        quantity: '2',
        unit: 'box',
        unitPrice: '25.00',
        taxCodeId: field(standard, 'id'),
      },
    ],
  });
  const quoteId = text(field(field(quote, 'invoice'), 'id'));
  await page.goto(`/c/${companyId}/invoices/${quoteId}`);
  const convert = page.getByTestId('convert-panel');
  await expect(convert).toContainText("This makes a new draft invoice with the quote's lines.");
  await expect(page.getByTestId('total')).toHaveText('50.00');
  await checkScreen(page, 'quote-convert');
  await convert.getByRole('button', { name: 'Convert to invoice', exact: true }).click();
  await expect(page.getByTestId('source-quote')).toContainText('Made from a quote.');
  await expect(page).not.toHaveURL(new RegExp(quoteId));
  await expect(page.getByTestId('issue-panel')).toBeVisible();
  await page.getByTestId('source-quote').getByRole('link', { name: 'Open the quote' }).click();
  await expect(page.getByTestId('convert-panel')).toContainText(
    'This quote was converted to an invoice.',
  );
});

async function api(
  page: Page,
  method: 'get' | 'post' | 'patch',
  url: string,
  data?: unknown,
): Promise<unknown> {
  const response = await page.request[method](url, {
    headers: await csrf(page),
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method.toUpperCase()} ${url}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<unknown>;
}

async function csrf(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const token = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value ?? '';
  return { 'X-XSRF-TOKEN': token };
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw new Error(`${key} is missing`);
  }
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('expected text');
  }
  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected a list');
  }
  return value;
}

async function ensureEnglish(page: Page): Promise<void> {
  const orders = page.getByRole('link', { name: 'Orders', exact: true });
  if (await orders.isVisible()) {
    return;
  }
  await page.getByRole('button', { name: /Account menu|Μενού λογαριασμού/ }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(orders).toBeVisible();
}

async function checkScreen(page: Page, name: string): Promise<void> {
  await shot(page, name);
  await assertButtonContrast(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scroll.scrollWidth, `${name} mobile scroll`).toBeLessThanOrEqual(scroll.innerWidth);
  await shot(page, `${name}-mobile`);
  await page.setViewportSize({ width: 1280, height: 800 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await waitForSettledPaint(page);
  const file = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  expect((await stat(file)).size).toBeGreaterThan(1000);
}
