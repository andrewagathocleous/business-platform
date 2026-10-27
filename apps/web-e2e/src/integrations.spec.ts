import { expect, test, type Page } from '@playwright/test';

const KEY = 'FictionalShopKey000000000000W9qZ';

test('admin.a saves a PrestaShop connection and the key stays out of the page', async ({
  page,
}) => {
  const stamp = Date.now().toString();
  const brand = `E2E Brand ${stamp}`;
  const location = `E2E Location ${stamp}`;
  const store = `E2E Store ${stamp}`;

  await devLogin(page, 'admin.a@example.test');
  await ensureEnglish(page);
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Stores', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Stores', exact: true })).toBeVisible();

  await page.getByLabel('Brand name').fill(brand);
  await page.getByRole('button', { name: 'Add brand', exact: true }).click();
  await expect(page.getByRole('cell', { name: brand, exact: true })).toBeVisible();

  await page.getByLabel('Location name').fill(location);
  await page.getByLabel('Address line 1').fill('1 Demo Street');
  await page.getByLabel('City').fill('Nicosia');
  await page.getByLabel('Country code').fill('CY');
  await page.getByRole('button', { name: 'Add location', exact: true }).click();
  await expect(page.getByRole('cell', { name: location, exact: true })).toBeVisible();

  const stores = page.getByTestId('stores');
  await stores.getByLabel('Store name').fill(store);
  await stores
    .getByRole('combobox', { name: 'Platform', exact: true })
    .selectOption({ label: 'PrestaShop' });
  await stores.getByRole('combobox', { name: 'Brand', exact: true }).selectOption({ label: brand });
  await stores
    .getByRole('combobox', { name: 'Location', exact: true })
    .selectOption({ label: location });
  await page.getByRole('button', { name: 'Add store', exact: true }).click();
  await expect(page.getByRole('cell', { name: store, exact: true })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Integrations', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Store', exact: true }).selectOption({ label: store });
  await page.getByLabel('Shop URL').fill('https://shop.example.test');
  await page.getByLabel('Webservice key').fill(KEY);
  await page.getByLabel('First import from').fill('2026-01-01 00:00:00');
  await page.getByTestId('prestashop').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Key set on')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Integrations', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Store', exact: true }).selectOption({ label: store });
  await expect(page.getByText('Key set on')).toBeVisible();
  await expect(page.getByLabel('Webservice key')).toHaveCount(0);
  expect(await page.content()).not.toContain(KEY);
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
  await page.getByRole('button', { name: /Account menu|Μενού λογαριασμού/ }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(orders).toBeVisible();
}
