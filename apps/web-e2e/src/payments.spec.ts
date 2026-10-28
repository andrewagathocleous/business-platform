import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { assertButtonContrast } from './button-contrast';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/r2e3');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

test('payments settle an invoice and refunds preserve the client credit history', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString();
  await page.goto('/login');
  await expect(page.getByRole('status')).toContainText('DEVELOPMENT LOGIN — fictional users');
  await page.getByRole('button', { name: 'owner@example.test' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]+\//);

  const company = await api(page, 'post', '/api/platform/companies', {
    legalName: `E2E Payments ${stamp} Ltd (fictional)`,
    tradingName: `E2E Payments ${stamp}`,
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
        description: 'Payment test gift box (demo)',
        quantity: '1',
        unit: 'box',
        unitPrice: '11.90',
        taxCodeId: field(standard, 'id'),
      },
    ],
  });
  const invoiceId = text(field(field(draft, 'invoice'), 'id'));
  const enabled = await page.request.put(`${base}/automation/switches/invoice.issue_real`, {
    headers: await csrf(page),
    data: { enabled: true, reason: 'e2e issue test' },
  });

  expect(enabled.ok()).toBe(true);

  await page.goto(`/c/${companyId}/invoices/${invoiceId}`);
  await ensureEnglish(page);
  const issue = page.getByTestId('issue-panel');
  await issue.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await issue.getByRole('button', { name: 'Issue now', exact: true }).click();
  await expect(page.getByTestId('issued-summary')).toContainText(`E${stamp.slice(-6)}-0001`);

  const payments = page.getByTestId('invoice-payments');
  await expect(payments).toContainText('Open balance: 11.90 EUR');
  await expect(payments).toContainText('Unpaid');
  await payments.getByLabel('Amount', { exact: true }).fill('4,00');
  await payments.getByLabel('Reference', { exact: true }).fill('Partial payment (demo)');
  await payments.getByLabel('Notes', { exact: true }).fill('Received in two parts.\n  Demo only.');
  await checkScreen(page, 'record-payment');
  await payments.getByRole('button', { name: 'Record a payment', exact: true }).click();
  await expect(payments).toContainText('Partly paid');
  await expect(payments).toContainText('Open balance: 7.90 EUR');
  await expect(payments.getByTestId('allocations')).toContainText('Partial payment (demo)');
  await expect(
    payments.getByRole('button', { name: 'Record another payment', exact: true }),
  ).toBeEnabled();
  await checkScreen(page, 'invoice-partly-paid');
  await payments.getByRole('button', { name: 'Record another payment', exact: true }).click();
  await expect(payments.getByLabel('Amount', { exact: true })).toHaveValue('7.90');
  await payments.getByLabel('Reference', { exact: true }).fill('Final payment (demo)');
  await payments.getByRole('button', { name: 'Record a payment', exact: true }).click();
  await expect(payments.locator('p-tag')).toHaveText('Paid');
  await expect(payments).toContainText('Open balance: 0.00 EUR');
  await expect(
    payments.getByRole('button', { name: 'Record another payment', exact: true }),
  ).toBeEnabled();
  await checkScreen(page, 'invoice-paid');

  await page.goto(`/c/${companyId}/invoices?payment=open`);
  await expect(page.getByText('No invoices', { exact: true })).toBeVisible();
  const clientId = text(field(field(client, 'client'), 'id'));
  await page.goto(`/c/${companyId}/clients/${clientId}`);
  const account = page.getByTestId('client-account');
  await expect(account).toContainText('No open invoices.');
  await expect(account).toContainText('Total money owing: 0.00 EUR');
  await expect(account.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await checkScreen(page, 'client-settled');

  // Money already received, deliberately left as unused client credit.
  await page.goto(`/c/${companyId}/invoices/${invoiceId}`);
  await expect(payments).toContainText('Open balance: 0.00 EUR');
  await payments.getByLabel('Amount', { exact: true }).fill('20.00');
  await payments.getByLabel('Apply it to this invoice', { exact: true }).uncheck();
  await payments.getByLabel('Reference', { exact: true }).fill('Unused payment (demo)');
  await payments.getByRole('button', { name: 'Record a payment', exact: true }).click();
  await expect(
    payments.getByRole('button', { name: 'Record another payment', exact: true }),
  ).toBeEnabled();
  await expect(payments).toContainText('Saved.');
  await page.goto(`/c/${companyId}/clients/${clientId}`);
  await expect(account).toContainText('Total unused credit: 20.00 EUR');
  const credit = account.getByTestId('client-credit').filter({ hasText: 'Unused payment (demo)' });
  await credit.getByRole('button', { name: 'Record a refund', exact: true }).click();
  const refund = account.getByTestId('credit-action');
  await expect(refund).toContainText('This does not send money');
  await expect(refund.getByLabel('Amount', { exact: true })).toHaveValue('20.00');
  await refund.getByLabel('Amount', { exact: true }).fill('5,00');
  // A select's label text includes its options, so it is found by role (as in d3.spec.ts).
  const method = refund.getByRole('combobox', { name: 'Method', exact: true });
  await method.selectOption({ label: 'Cash' });
  await expect(method).toHaveValue('cash');
  await refund.getByLabel('Reference', { exact: true }).fill('Refund receipt (demo)');
  await checkScreen(page, 'record-refund');
  await refund.getByRole('button', { name: 'Record a refund', exact: true }).click();
  await expect(account).toContainText('Total unused credit: 15.00 EUR');
  await expect(refund).toHaveCount(0);
  const detail = account.getByTestId('payment-detail');
  await expect(detail).toContainText('Unused payment (demo)');
  const recordedRefund = detail.getByTestId('refund-detail');
  await expect(recordedRefund).toContainText('5.00');
  await expect(
    recordedRefund.getByRole('button', { name: 'Void refund', exact: true }),
  ).toBeVisible();
  await expect(recordedRefund.getByLabel('Reason', { exact: true })).toBeEnabled();
  await checkScreen(page, 'refund-recorded');
  await recordedRefund
    .getByLabel('Reason', { exact: true })
    .fill('Refund recorded by mistake (demo)');
  await recordedRefund.getByRole('button', { name: 'Void refund', exact: true }).click();
  await expect(account).toContainText('Total unused credit: 20.00 EUR');
  await expect(recordedRefund).toContainText('Voided');
  await expect(recordedRefund).toContainText('Refund recorded by mistake (demo)');
  await expect(account.getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await checkScreen(page, 'refund-voided');
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
  await assertButtonContrast(page);
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
