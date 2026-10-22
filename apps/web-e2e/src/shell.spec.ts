import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/d2fix1');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

test('admin.a sees company A and not company B', async ({ page, request }) => {
  await page.goto('/login');
  await expect(page.getByRole('status')).toContainText('DEVELOPMENT LOGIN — fictional users');
  await shot(page, 'login');

  await devLogin(page, 'admin.a@example.test');
  await ensureEnglish(page);
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '#1001' })).toBeVisible();
  await expect(page.getByText('Current: Nutbox (demo data)')).toBeVisible();
  await expect(page.getByText('Olive Grove (demo data)')).toHaveCount(0);
  await shot(page, 'orders');

  await openCompanyList(page);
  const options = page.getByRole('listbox').getByRole('option');
  await expect(options).toHaveCount(1);
  await expect(options).toContainText('Nutbox (demo data)');
  await page.keyboard.press('Escape');

  await openSection(page, 'Clients', 'clients');
  await openSection(page, 'Invoices', 'invoices');
  await openSection(page, 'Members', 'admin-members');
  await openSection(page, 'Automation', 'admin-automation');
  await page.getByRole('link', { name: 'Audit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Audit log', exact: true })).toBeVisible();
  await shot(page, 'admin-audit');
  await openSection(page, 'Printers', 'admin-printers');

  const companyB = await companyId(request, 'Olive Grove (demo data)');
  const ordersUrl = page.url().replace(/\/admin\/printers$/, '/orders');
  await page.goto(`/c/${companyB}/orders`);
  await expect(page.getByRole('heading', { name: 'Not found', exact: true })).toBeVisible();
  await shot(page, 'not-found');

  await page.goto(ordersUrl);
  await ensureEnglish(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.locator('.p-drawer');
  await expect.poll(async () => Math.round((await drawer.boundingBox())?.x ?? -1)).toBe(0);
  const drawerOrders = drawer.getByRole('link', { name: 'Orders', exact: true });
  await expect
    .poll(async () => (await drawerOrders.boundingBox())?.x ?? -1)
    .toBeGreaterThanOrEqual(0);
  await expect(drawerOrders).toBeVisible();
  await shot(page, 'shell-mobile');
  await page.getByRole('button', { name: 'Close menu' }).click();
  await expect(page.getByText('Sections', { exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await shot(page, 'orders-mobile');
});

test('fulfil.a has no invoices or admin, and invoices are forbidden', async ({ page, request }) => {
  await devLogin(page, 'fulfil.a@example.test');
  await ensureEnglish(page);
  await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invoices', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Admin', exact: true })).toHaveCount(0);

  const companyA = await companyId(request, 'Nutbox (demo data)');
  await page.goto(`/c/${companyA}/invoices`);
  await expect(page.getByRole('heading', { name: 'Forbidden', exact: true })).toBeVisible();
  await shot(page, 'forbidden');
});

test('Greek shell text survives a reload', async ({ page }) => {
  await devLogin(page, 'admin.a@example.test');
  await ensureEnglish(page);
  await chooseLanguage(page, 'Ελληνικά');
  await expect(page.getByRole('link', { name: 'Παραγγελίες', exact: true })).toBeVisible();
  await expect(page.getByText('Τρέχουσα:')).toBeVisible();
  await shot(page, 'shell-el');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Παραγγελίες', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Διαχείριση', exact: true })).toBeVisible();
  await chooseLanguage(page, 'English');
  await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
});

async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('status')).toContainText('DEVELOPMENT LOGIN — fictional users');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/c\/[0-9a-f-]+\/orders$/);
}

async function ensureEnglish(page: Page): Promise<void> {
  const orders = page.getByRole('link', { name: 'Orders', exact: true });
  if (await orders.isVisible()) {
    return;
  }
  await chooseLanguage(page, 'English');
  await expect(orders).toBeVisible();
}

async function chooseLanguage(page: Page, language: 'English' | 'Ελληνικά'): Promise<void> {
  await page.getByRole('button', { name: /Account menu|Μενού λογαριασμού/ }).click();
  await page.getByRole('button', { name: language, exact: true }).click();
}

async function openCompanyList(page: Page): Promise<void> {
  await page.getByRole('combobox', { name: 'Company' }).click();
}

async function openSection(page: Page, name: string, file: string): Promise<void> {
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await shot(page, file);
}

async function companyId(request: APIRequestContext, tradingName: string): Promise<string> {
  const response = await request.get('/api/auth/dev/users');
  expect(response.ok()).toBe(true);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body['users'])) {
    throw new Error('dev users response has no users');
  }
  for (const user of body['users']) {
    if (!isRecord(user) || !Array.isArray(user['memberships'])) {
      continue;
    }
    for (const membership of user['memberships']) {
      if (!isRecord(membership) || membership['tradingName'] !== tradingName) {
        continue;
      }
      const id = membership['companyId'];
      if (typeof id === 'string' && id.length > 0) {
        return id;
      }
    }
  }
  throw new Error(`no company named ${tradingName}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await waitForSettledPaint(page);
  await page.screenshot({
    path: path.join(screenshots, `${name}.png`),
    fullPage,
    animations: 'disabled',
  });
}
