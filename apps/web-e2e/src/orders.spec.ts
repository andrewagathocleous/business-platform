import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { assertButtonContrast } from './button-contrast';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/d2fix2');
const giftFixture = path.resolve(
  process.cwd(),
  'packages/integrations/shopify/fixtures/order-1001-paid-greek-gift.json',
);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

test('admin.a works an order from the list through a confirmed print', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await devLogin(page, 'admin.a@example.test');
  await ensureEnglish(page);
  await openCompanyList(page);
  const companies = page.getByRole('listbox').getByRole('option');
  await expect(companies).toHaveCount(1);
  await expect(companies).toContainText('Nutbox (demo data)');
  await page.keyboard.press('Escape');

  await expect(page.getByRole('link', { name: '#1001' })).toBeVisible();
  await expect(page.getByRole('link', { name: '#1002' })).toBeVisible();
  await expect(page.getByRole('link', { name: '#1003' })).toBeVisible();
  const row = page.getByRole('row', { name: /#1001/ });
  await expect(row.getByTestId('payment-status')).toHaveClass(/p-tag-success/);
  await expect(row.getByTestId('fulfilment-status')).toBeVisible();
  await expect(row.getByTestId('integration-status')).toBeVisible();
  const review = page.getByRole('row', { name: /#1003/ });
  await expect(review.getByTestId('fulfilment-status')).toHaveClass(/p-tag-warn/);
  await expect(review.locator('.pi-exclamation-triangle')).toBeVisible();
  await expect(review).toContainText('Review required');
  await expect(page.getByRole('status')).toHaveCount(0);
  await shot(page, 'orders-list');
  await assertButtonContrast(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expect(page.getByRole('link', { name: '#1001' })).toBeVisible();
  const listScroll = await scrollWidth(page);
  console.log(
    `orders-list-mobile scrollWidth=${String(listScroll.scrollWidth)} innerWidth=${String(listScroll.innerWidth)}`,
  );
  expect(listScroll.scrollWidth).toBeLessThanOrEqual(listScroll.innerWidth);
  await expectCompanySelect(page);
  await shot(page, 'orders-list-mobile');
  await assertButtonContrast(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page).toHaveURL(/fulfilmentStatus=new/);
  await page.reload();
  await expect(page).toHaveURL(/fulfilmentStatus=new/);
  await expect(page.getByRole('button', { name: 'New', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('link', { name: '#1001' })).toBeVisible();

  await page.getByRole('link', { name: '#1001' }).click();
  await expect(page.getByRole('heading', { name: '#1001', exact: true })).toBeVisible();
  const gift = fixtureGiftMessage();
  const shown = await page.getByTestId('gift-message').evaluate((element) => element.textContent);
  expect(shown).toBe(gift);

  await page.getByRole('button', { name: 'Mark as Preparing' }).click();
  await expect(page.getByTestId('fulfilment-status')).toHaveText('Preparing');
  await page.getByRole('button', { name: 'Mark as Ready' }).click();
  await expect(page.getByTestId('fulfilment-status')).toHaveText('Ready');
  await expect(page.getByRole('status')).toHaveCount(0);
  await expect(page.getByLabel('Assign to')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assign', exact: true })).toBeVisible();
  await shot(page, 'order-detail');
  await assertButtonContrast(page);

  await page.setViewportSize({ width: 390, height: 844 });
  const detailScroll = await scrollWidth(page);
  console.log(
    `order-detail-mobile scrollWidth=${String(detailScroll.scrollWidth)} innerWidth=${String(detailScroll.innerWidth)}`,
  );
  expect(detailScroll.scrollWidth).toBeLessThanOrEqual(detailScroll.innerWidth);
  await shot(page, 'order-detail-mobile');
  await assertButtonContrast(page);
  await page.setViewportSize({ width: 1280, height: 800 });

  const packing = page.locator('[data-document="packing_slip"]');
  await packing.getByRole('button', { name: 'Print', exact: true }).click();
  await expect(packing.getByText('Simulated printer')).toBeVisible();
  await expect(
    packing.getByText('Sent to printer (provider reported done — not confirmed)'),
  ).toBeVisible({
    timeout: 60_000,
  });
  await packing.getByRole('button', { name: 'Confirm printed', exact: true }).click();
  await expect(packing.getByText('Confirmed printed', { exact: true })).toBeVisible();
  await shot(page, 'order-detail-print');
  await assertButtonContrast(page);

  const activity = page.locator('.activity');
  await expect(activity).toContainText('Imported');
  await expect(activity).toContainText('Status changed');
  await expect(activity).toContainText('Print requested');

  await chooseLanguage(page, 'Ελληνικά');
  await expect(
    page.getByRole('heading', { name: 'Μήνυμα δώρου', exact: true }).first(),
  ).toBeVisible();
  await shot(page, 'order-detail-el');
  await chooseLanguage(page, 'English');
  await expect(
    page.getByRole('heading', { name: 'Gift message', exact: true }).first(),
  ).toBeVisible();

  const companyA = await companyId(request, 'Nutbox (demo data)');
  expect(page.url()).toContain(`/c/${companyA}/orders/`);
});

test('fulfil.a can open an order and cannot assign it', async ({ page, request }) => {
  await devLogin(page, 'fulfil.a@example.test');
  await ensureEnglish(page);
  await expect(page.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Invoices', exact: true })).toHaveCount(0);
  const companyA = await companyId(request, 'Nutbox (demo data)');
  await page.goto(`/c/${companyA}/invoices`);
  await expect(page.getByRole('heading', { name: 'Forbidden', exact: true })).toBeVisible();
  await page.goto(`/c/${companyA}/orders`);
  await page.getByRole('link', { name: '#1001' }).click();
  await expect(page.getByRole('heading', { name: '#1001', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assign', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Claim', exact: true })).toBeVisible();
});

test('a stale transition shows the conflict toast and reload fetches the new state', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await devLogin(page, 'admin.a@example.test');
  await ensureEnglish(page);
  await page.getByRole('link', { name: '#1001' }).click();
  await expect(page.getByRole('button', { name: 'Mark as Handed to courier' })).toBeVisible();
  const companyA = await companyId(request, 'Nutbox (demo data)');
  const orderId = orderIdFrom(page.url());
  await changeThroughApi(page, companyA, orderId);
  await page.getByRole('button', { name: 'Mark as Handed to courier' }).click();
  await expect(page.getByRole('alert')).toContainText('This order was changed by someone else');
  await expect(page.getByRole('status')).toHaveCount(0);
  await shot(page, 'order-conflict');
  await assertButtonContrast(page);
  await page.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(page.getByTestId('fulfilment-status')).toHaveText('Handed to courier');
});

function fixtureGiftMessage(): string {
  const parsed: unknown = JSON.parse(readFileSync(giftFixture, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed['customAttributes'])) {
    throw new Error('gift fixture has no custom attributes');
  }
  for (const attribute of parsed['customAttributes']) {
    if (
      isRecord(attribute) &&
      attribute['key'] === 'Gift Message' &&
      typeof attribute['value'] === 'string'
    ) {
      return attribute['value'];
    }
  }
  throw new Error('gift fixture has no Gift Message');
}

async function changeThroughApi(page: Page, companyId: string, orderId: string): Promise<void> {
  const cookies = await page.context().cookies();
  const token = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN')?.value;
  if (!token) {
    throw new Error('missing XSRF cookie');
  }
  const detail = await page.request.get(`/api/c/${companyId}/orders/${orderId}`);
  expect(detail.ok()).toBe(true);
  const body: unknown = await detail.json();
  if (!isRecord(body) || !isRecord(body['order']) || typeof body['order']['version'] !== 'number') {
    throw new Error('order version is missing');
  }
  const changed = await page.request.post(`/api/c/${companyId}/orders/${orderId}/transitions`, {
    headers: { 'X-XSRF-TOKEN': token },
    data: { to: 'handed_to_courier', expectedVersion: body['order']['version'] },
  });
  expect(changed.ok()).toBe(true);
}

function orderIdFrom(url: string): string {
  const match = /\/orders\/([0-9a-f-]+)$/i.exec(url);
  if (!match?.[1]) {
    throw new Error('order id is missing from the page url');
  }
  return match[1];
}

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

async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await waitForSettledPaint(page);
  await page.screenshot({
    path: path.join(screenshots, `${name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

async function scrollWidth(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

async function expectCompanySelect(page: Page): Promise<void> {
  const box = await page.getByTestId('company-switcher').boundingBox();
  const label = await page.locator('.company-switch .p-select-label').boundingBox();
  const chevron = await page.locator('.company-switch .p-select-dropdown').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(160);
  expect(chevron?.x ?? 0).toBeGreaterThan((label?.x ?? 0) + (label?.width ?? 0) - 1);
}
