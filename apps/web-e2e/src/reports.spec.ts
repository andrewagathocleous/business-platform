import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { assertButtonContrast } from './button-contrast';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/r2g3');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

test('reports reconcile an invoice, partial payment and credit note, and download a ZIP', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString();
  await page.goto('/login');
  await expect(page.getByRole('status')).toContainText('DEVELOPMENT LOGIN — fictional users');
  await page.getByRole('button', { name: 'owner@example.test' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]+\//);

  const company = await api(page, 'post', '/api/platform/companies', {
    legalName: `E2E Reports ${stamp} Ltd (fictional)`,
    tradingName: `E2E Reports ${stamp}`,
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
        description: 'Report test gift box (fictional)',
        quantity: '2',
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

  // All financial fixtures are set up through the API in this fictional company.
  const issued = await api(page, 'post', `${base}/invoices/${invoiceId}/issue`, {
    expectedVersion: field(field(draft, 'invoice'), 'version'),
  });
  const invoice = field(issued, 'invoice');
  const issueDate = text(field(invoice, 'issueDate'));
  const clientId = text(field(field(client, 'client'), 'id'));
  const payment = await api(
    page,
    'post',
    `${base}/payments`,
    {
      clientId,
      amount: '4.00',
      receivedOn: issueDate,
      method: 'bank_transfer',
      reference: 'Partial payment (fictional)',
    },
    randomUUID(),
  );
  await api(
    page,
    'post',
    `${base}/allocations`,
    {
      paymentId: field(field(payment, 'payment'), 'id'),
      invoiceId,
      amount: '4.00',
    },
    randomUUID(),
  );
  const credit = await api(page, 'post', `${base}/invoices/${invoiceId}/credit-notes`, {
    reason: 'One gift box returned (fictional)',
    lines: [{ invoiceLineId: field(list(field(invoice, 'lines'))[0], 'id'), quantity: '1' }],
  });
  const creditId = text(field(field(credit, 'creditNote'), 'id'));
  await api(page, 'post', `${base}/credit-notes/${creditId}/issue`, {
    expectedVersion: field(field(credit, 'creditNote'), 'version'),
  });

  await page.goto(`/c/${companyId}/reports`);
  await ensureEnglish(page);
  await expect(page.getByRole('link', { name: 'Reports', exact: true })).toBeVisible();
  const reports = page.getByTestId('reports');
  const selector = reports.getByRole('combobox', { name: 'Report', exact: true });
  const invoiced = reports.getByTestId('invoiced-currency');
  await expect(invoiced).toBeVisible();
  const invoiceTotals = invoiced
    .locator('table')
    .first()
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Grand totals', exact: true }) });
  await expect(invoiceTotals.getByRole('cell')).toHaveText([
    '—',
    '10.00',
    '1.90',
    '11.90',
    'by issue date; credit notes subtracted',
  ]);
  await expect(invoiced.getByTestId('tax-code-totals')).toContainText('STD19');
  await checkScreen(page, 'reports-invoiced');

  await selector.selectOption('collected');
  const collected = reports.getByTestId('collected-currency');
  await expect(collected).toContainText('Bank transfer');
  const collectedTotals = collected.locator('tfoot tr');
  const collectionBasis = 'by payment and refund date; voided payments and refunds are excluded';
  await expect(collectedTotals.nth(0).getByRole('cell')).toHaveText([
    'Payments',
    '1',
    '4.00',
    collectionBasis,
  ]);
  await expect(collectedTotals.nth(1).getByRole('cell')).toHaveText([
    'Refunds',
    '0',
    '0.00',
    collectionBasis,
  ]);
  await expect(collectedTotals.nth(2).getByRole('cell')).toHaveText([
    'Net collected',
    '—',
    '4.00',
    collectionBasis,
  ]);
  await checkScreen(page, 'reports-collected');

  await selector.selectOption('ageing');
  const ageing = reports.getByTestId('ageing-currency');
  const totals = ageing.getByTestId('ageing-totals');
  await expect(
    totals.getByRole('columnheader', { name: 'Client credit (separate)', exact: true }),
  ).toBeVisible();
  const clientRow = totals.locator('tbody tr');
  for (const row of [clientRow, totals.locator('tfoot tr')]) {
    // Five buckets, followed by the open total and separate client credit.
    await expect(row.getByRole('cell').nth(0)).toHaveText('7.90');
    for (const index of [1, 2, 3, 4])
      await expect(row.getByRole('cell').nth(index)).toHaveText('0.00');
    await expect(row.getByRole('cell').nth(5)).toHaveText('7.90');
    await expect(row.getByRole('cell').nth(6)).toContainText('0.00');
  }
  await expect(ageing).toContainText(
    'by due date; allocations and refunds counted by their effective dates',
  );
  await expect(
    ageing.getByRole('link', { name: text(field(invoice, 'number')), exact: true }),
  ).toHaveAttribute('href', `/c/${companyId}/invoices/${invoiceId}`);
  await expect(totals.getByRole('link')).toHaveAttribute(
    'href',
    `/c/${companyId}/clients/${clientId}`,
  );
  await checkScreen(page, 'reports-ageing');

  const exportPanel = reports.getByTestId('accountant-export');
  await expect(exportPanel).toContainText('customer and financial data');
  await expect(
    exportPanel.getByLabel('Include the stored PDFs', { exact: true }),
  ).not.toBeChecked();
  // Include the two sealed PDFs as well as the CSVs.
  await exportPanel.getByLabel('Include the stored PDFs', { exact: true }).check();
  await checkScreen(page, 'reports-export');
  const downloadEvent = page.waitForEvent('download');
  await exportPanel.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(
    /^accountant-export-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.zip$/,
  );
  const file = await download.path();
  expect(file).not.toBeNull();
  if (!file) throw new Error('download file is missing');
  const bytes = await readFile(file);
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
  await expect(exportPanel.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
});

async function api(
  page: Page,
  method: 'get' | 'post' | 'patch',
  url: string,
  data?: unknown,
  key?: string,
): Promise<unknown> {
  const response = await page.request[method](url, {
    headers: { ...(await csrf(page)), ...(key ? { 'Idempotency-Key': key } : {}) },
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
