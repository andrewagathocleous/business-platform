import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { assertButtonContrast } from './button-contrast';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/r2h2');

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

test('client CSV exports customer data and imports only new clients from a restored preview', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString();
  await page.goto('/login');
  await expect(page.getByRole('status')).toContainText('DEVELOPMENT LOGIN — fictional users');
  await page.getByRole('button', { name: 'owner@example.test' }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]+\//);
  const company = await api(page, 'post', '/api/platform/companies', {
    legalName: `E2E CSV ${stamp} Ltd (fictional)`,
    tradingName: `E2E CSV ${stamp}`,
    isFictional: true,
  });
  const companyId = text(field(field(company, 'company'), 'id'));
  const base = `/api/c/${companyId}`;
  const duplicateName = `CSV Existing ${stamp} (fictional)`;
  const newName = `CSV Νέος ${stamp} (fictional)`;
  const existing = await api(page, 'post', `${base}/clients`, {
    kind: 'organisation',
    displayName: duplicateName,
    email: `existing-${stamp}@example.test`,
  });
  const existingId = text(field(field(existing, 'client'), 'id'));
  await page.goto(`/c/${companyId}/clients`);
  await ensureEnglish(page);
  const exportPanel = page.getByTestId('client-csv-export');
  await expect(exportPanel).toContainText('customer data');
  await checkScreen(page, 'client-csv-list');
  const downloadEvent = page.waitForEvent('download');
  await exportPanel.getByRole('button', { name: 'Export CSV', exact: true }).click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toMatch(/^clients-\d{4}-\d{2}-\d{2}\.csv$/);
  const file = await download.path();
  if (!file) throw new Error('download file is missing');
  const bytes = await readFile(file);
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const header =
    'kind,display_name,legal_name,vat_number,tax_id,email,phone,website,notes,default_currency,default_language,payment_terms_days,accepts_e_invoices,billing_line1,billing_line2,billing_city,billing_region,billing_postal_code,billing_country_code,archived';
  expect(bytes.toString('utf8').startsWith(`\uFEFF${header}\r\n`)).toBe(true);
  expect(bytes.toString('utf8')).toContain(duplicateName);

  const content =
    [
      'kind,display_name,email,notes',
      `person,${newName},new-${stamp}@example.test,"  Γραμμή ένα\nΓραμμή δύο  "`,
      `organisation,${duplicateName},existing-${stamp}@example.test,`,
      `person,CSV Invalid ${stamp} (fictional),not-an-email,`,
    ].join('\r\n') + '\r\n';
  const importPanel = page.getByTestId('client-csv-import');
  await importPanel.getByLabel('CSV file', { exact: true }).setInputFiles({
    name: 'fictional-clients.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(content, 'utf8'),
  });
  const preview = page.getByTestId('client-csv-preview');
  await expect(preview.getByTestId('import-counts')).toHaveText('New: 1 · Duplicate: 1 · Error: 1');
  await expect(preview.locator('tbody tr').nth(0)).toContainText('Error');
  await expect(preview.locator('tbody tr').nth(0)).toContainText('invalid_email');
  await expect(preview.locator('tbody tr').nth(1)).toContainText('Duplicate');
  await expect(preview.locator('tbody tr').nth(1)).toContainText(`Matches client ${existingId}`);
  await expect(preview.locator('tbody tr').nth(2)).toContainText(newName);
  await expect(page).toHaveURL(/importId=[0-9a-f-]+/);
  await checkScreen(page, 'client-csv-preview');
  await page.reload();
  await expect(preview.getByTestId('import-counts')).toHaveText('New: 1 · Duplicate: 1 · Error: 1');
  await preview.getByRole('button', { name: 'Import 1 new clients', exact: true }).click();
  await expect(importPanel).toContainText('Created 1 clients.');
  await expect(preview).toHaveCount(0);
  await expect(page).not.toHaveURL(/importId=/);
  await expect(page.getByRole('link', { name: newName, exact: true })).toBeVisible();
  const clients = list(field(await api(page, 'get', `${base}/clients`), 'clients'));
  expect(clients).toHaveLength(2);
  const created = clients.find((client) => field(client, 'displayName') === newName);
  const details = await api(page, 'get', `${base}/clients/${text(field(created, 'id'))}`);
  expect(field(field(details, 'client'), 'notes')).toBe('  Γραμμή ένα\nΓραμμή δύο  ');
  await checkScreen(page, 'client-csv-imported');
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
