import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { assertButtonContrast } from './button-contrast';
import { waitForSettledPaint } from './settle-paint';

const screenshots = path.resolve(process.cwd(), 'var/screenshots/d3fix2');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
});

test('finance.a creates a client and an E4 draft invoice', async ({ page, request }) => {
  test.setTimeout(180_000);
  const stamp = Date.now().toString();
  const displayName = `D3 Client ${stamp}`;
  const duplicateName = `D3 Duplicate ${stamp}`;
  const email = `d3.client.${stamp}@example.test`;

  await devLogin(page, 'finance.a@example.test');
  await ensureEnglish(page);
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Clients', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'New client', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New client', exact: true })).toBeVisible();
  await page.getByLabel('Display name').fill(displayName);
  await page.getByLabel('Email').first().fill(email);
  await page.getByLabel('Default currency').fill('EUR');
  await page.getByRole('button', { name: 'Add contact', exact: true }).click();
  await page.getByLabel('Contact name').fill('Nikos Demo');
  await page.getByRole('checkbox', { name: 'Primary contact', exact: true }).check();
  await page.getByRole('button', { name: 'Add address', exact: true }).click();
  await page.getByLabel('Address line 1').fill('1 Demo Street');
  await page.getByLabel('City').fill('Nicosia');
  await page.getByLabel('Country code').fill('CY');
  await checkScreen(page, 'client-form');

  await page.getByRole('button', { name: 'Save client', exact: true }).click();
  await expect(page).toHaveURL(/\/clients\/[0-9a-f-]{36}$/i);
  await expect(page.getByRole('heading', { name: 'Edit client', exact: true })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Clients', exact: true })
    .click();
  await page.getByRole('link', { name: 'New client', exact: true }).click();
  await page.getByLabel('Display name').fill(duplicateName);
  await page.getByLabel('Email').first().fill(email);
  await page.getByRole('button', { name: 'Save client', exact: true }).click();
  const dialog = page.getByTestId('duplicate-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Possible duplicate — save anyway?');
  await expect(dialog.getByRole('link', { name: displayName, exact: true })).toBeVisible();
  await checkScreen(page, 'client-duplicate');
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Display name')).toHaveValue(duplicateName);

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Clients', exact: true })
    .click();
  await expect(page.getByRole('link', { name: displayName, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: duplicateName, exact: true })).toHaveCount(0);
  await checkScreen(page, 'clients-list');

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Invoices', exact: true })
    .click();
  await page.getByRole('link', { name: 'New invoice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New invoice', exact: true })).toBeVisible();
  await page.getByLabel('Client').fill(displayName);
  await page.getByRole('button', { name: displayName, exact: true }).click();
  await expect(page.getByTestId('document-language')).toContainText('Document language:');
  await expect(page.getByLabel('Prices include tax')).not.toBeChecked();
  await expect(page.getByRole('option', { name: 'STD19', exact: true })).toBeAttached();
  await page.getByLabel('Description', { exact: true }).fill('Demo nuts');
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByLabel('Unit', { exact: true }).fill('kg');
  await page.getByLabel('Unit price', { exact: true }).fill('10.00');
  await page.getByLabel('Discount %', { exact: true }).fill('15');
  await page
    .getByRole('combobox', { name: 'Tax code', exact: true })
    .selectOption({ label: 'STD19' });
  await expect(page.getByTestId('subtotal')).toHaveText('20.00');
  await expect(page.getByTestId('discount')).toHaveText('3.00');
  await expect(page.getByTestId('net')).toHaveText('17.00');
  await expect(page.getByTestId('tax')).toHaveText('3.23');
  await expect(page.getByTestId('total')).toHaveText('20.23');
  await expect(page.locator('.line-amounts')).toContainText('Subtotal 20.00');
  await expect(page.locator('.line-amounts')).toContainText('Discount 3.00');
  await expect(page.locator('.line-amounts')).toContainText('Net 17.00 (excl. tax)');
  await expect(page.locator('.line-amounts')).not.toContainText('Gross');
  await expect(page.getByText('DRAFT — not a tax invoice')).toHaveCount(0);
  await checkScreen(page, 'invoice-editor');

  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/i);
  await expect(page.getByText('DRAFT — not a tax invoice')).toBeVisible();
  await expect(page.getByTestId('total')).toHaveText('20.23');
  await page.reload();
  await expect(page.getByTestId('subtotal')).toHaveText('20.00');
  await expect(page.getByTestId('discount')).toHaveText('3.00');
  await expect(page.getByTestId('net')).toHaveText('17.00');
  await expect(page.getByTestId('tax')).toHaveText('3.23');
  await expect(page.getByTestId('total')).toHaveText('20.23');
  const pdfUrl = await page
    .getByRole('link', { name: 'Open draft PDF', exact: true })
    .getAttribute('href');
  if (!pdfUrl) {
    throw new Error('draft PDF link is missing');
  }
  const pdf = await page.request.get(pdfUrl);
  expect(pdf.ok()).toBe(true);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 4).toString('utf8')).toBe('%PDF');
  await expect(
    page.getByRole('combobox', { name: 'Tax code', exact: true }).locator('option:checked'),
  ).toHaveText('STD19');
  await expect(page.getByRole('link', { name: 'Open draft PDF', exact: true })).toBeVisible();
  await expect(page.getByText('DRAFT — not a tax invoice')).toBeVisible();
  await checkScreen(page, 'invoice-editor-saved');

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Invoices', exact: true })
    .click();
  await expect(page.getByRole('link', { name: 'Draft', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: displayName, exact: true })).toBeVisible();
  await checkScreen(page, 'invoices-list');

  const companyA = await companyId(request, 'Nutbox (demo data)');
  expect(page.url()).toContain(`/c/${companyA}/invoices`);
});

test('admin.a invites a member, toggles a switch, and reviews printers', async ({ page }) => {
  test.setTimeout(180_000);
  const email = `d3.invite.${Date.now().toString()}@example.test`;
  await devLogin(page, 'admin.a@example.test');
  await ensureEnglish(page);
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Members', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Staff baseline', exact: true })).toBeAttached();
  await checkScreen(page, 'admin-members');

  await page.getByLabel('Email').fill(email);
  await page
    .getByRole('combobox', { name: 'Role', exact: true })
    .selectOption({ label: 'Staff baseline' });
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByTestId('invite-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('This link is shown only once. No email was sent.');
  await expect(dialog.getByTestId('accept-link')).toContainText('/api/auth/oidc/start');
  await expect(dialog.getByTestId('accept-link')).toContainText('invitation=');
  await expect(dialog.getByTestId('accept-link')).toContainText(new URL(page.url()).origin);
  await checkScreen(page, 'admin-invite');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('accept-link')).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Automation', exact: true })
    .click();
  await expect(page.getByText('The global outbound.all switch is not managed here.')).toBeVisible();
  const printing = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'printing', exact: true }) });
  await printing.getByRole('button', { name: 'Turn off printing', exact: true }).click();
  const switchDialog = page.getByTestId('switch-dialog');
  await expect(switchDialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await switchDialog.getByLabel('Reason').fill('d3 switch off');
  await switchDialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(printing).toContainText('Off');
  await printing.getByRole('button', { name: 'Turn on printing', exact: true }).click();
  await expect(switchDialog.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
  await switchDialog.getByLabel('Reason').fill('d3 switch on');
  await switchDialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(printing).toContainText('On');
  await expect(printing).toContainText('d3 switch on');
  await checkScreen(page, 'admin-automation');

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Audit', exact: true })
    .click();
  const filtered = page.waitForResponse(
    (response) =>
      response.url().includes('/audit-events') && response.url().includes('automation_switch'),
  );
  await page.getByLabel('Action').fill('automation_switch.updated');
  await filtered;
  await expect(page.getByRole('status')).toHaveCount(0);
  const actionCell = page
    .getByRole('cell', { name: 'automation_switch.updated', exact: true })
    .first();
  await expect(actionCell).toBeVisible();
  expect(await textLineCount(actionCell), 'audit action stays on one line').toBe(1);
  const objectType = page.locator('.audit-table tbody td:nth-child(4) div').first();
  expect(await textLineCount(objectType), 'audit object type stays on one line').toBe(1);
  const actor = page.locator('.audit-table tbody td:nth-child(2)').first();
  expect(await textLineCount(actor), 'audit actor stays on one line').toBe(1);
  const details = page.getByRole('button', { name: 'Details', exact: true });
  const count = await details.count();
  for (let index = 0; index < count; index += 1) {
    await details.nth(index).click();
  }
  await expect(page.locator('pre').filter({ hasText: 'd3 switch off' })).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'd3 switch on' })).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: '"enabled": false' })).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: '"enabled": true' })).toBeVisible();
  for (let index = 1; index < count; index += 1) {
    await details.nth(index).click();
  }
  await expect(page.locator('pre')).toHaveCount(1);
  await checkScreen(page, 'admin-audit');

  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('link', { name: 'Printers', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Printers', exact: true })).toBeVisible();
  await expect(page.getByText('Mock LaserJet (online)').first()).toBeVisible();
  await expect(page.getByText('Simulated printer').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Discover simulated printers', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Packing slip').first()).toBeVisible();
  await expect(page.getByRole('option', { name: 'A4', exact: true }).first()).toBeAttached();
  const packing = page.getByRole('row', { name: /Packing slip/ }).filter({
    has: page.locator('option:checked', { hasText: 'Mock LaserJet (online)' }),
  });
  await expect(packing.first()).toBeVisible();
  await checkScreen(page, 'admin-printers');
});

test('fulfil.a cannot open clients, invoices or admin', async ({ page, request }) => {
  await devLogin(page, 'fulfil.a@example.test');
  await ensureEnglish(page);
  await page.getByRole('link', { name: '#1002' }).click();
  await expect(page.getByRole('heading', { name: '#1002', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mark as Preparing' }).click();
  await expect(page.getByTestId('fulfilment-status')).toHaveText('Preparing');
  await expect(page.getByText('Not available: Ready — Payment is not settled')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveCount(0);
  await shot(page, 'order-detail-print');
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav.getByRole('link', { name: 'Orders', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Clients', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Invoices', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Members', exact: true })).toHaveCount(0);
  const companyA = await companyId(request, 'Nutbox (demo data)');
  await page.goto(`/c/${companyA}/clients`);
  await expect(page.getByRole('heading', { name: 'Forbidden', exact: true })).toBeVisible();
  await page.goto(`/c/${companyA}/invoices`);
  await expect(page.getByRole('heading', { name: 'Forbidden', exact: true })).toBeVisible();
  await page.goto(`/c/${companyA}/admin/members`);
  await expect(page.getByRole('heading', { name: 'Forbidden', exact: true })).toBeVisible();
  await page.goto(`/c/${companyA}/admin`);
  await expect(page.getByRole('heading', { name: 'Forbidden', exact: true })).toBeVisible();
});

async function checkScreen(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('status')).toHaveCount(0);
  const link = page.getByTestId('accept-link');
  const mask = (await link.count()) > 0 ? [link] : [];
  if (name === 'admin-members' || name === 'admin-audit') {
    const box = page.locator('.table-scroll').first();
    const fit = await box.evaluate((node) => ({
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(fit.scrollWidth, `${name} table scroll`).toBeLessThanOrEqual(fit.clientWidth);
  }
  await shot(page, name, mask);
  await assertButtonContrast(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const scroll = await scrollWidth(page);
  expect(scroll.scrollWidth, `${name} mobile scroll`).toBeLessThanOrEqual(scroll.innerWidth);
  await assertButtonContrast(page);
  if (name === 'invoice-editor') {
    await shot(page, 'invoice-editor-mobile');
  }
  await page.setViewportSize({ width: 1280, height: 800 });
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
  await page.getByRole('button', { name: /Account menu|Μενού λογαριασμού/ }).click();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(orders).toBeVisible();
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

async function shot(page: Page, name: string, mask: Locator[] = []): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await waitForSettledPaint(page);
  const options = {
    path: path.join(screenshots, `${name}.png`),
    fullPage: true,
    animations: 'disabled' as const,
    mask,
  };
  if (name === 'admin-invite') {
    expect(options.mask, 'the invitation link is masked in the screenshot').toHaveLength(1);
  }
  await page.screenshot(options);
  const info = await stat(options.path);
  expect(info.size).toBeGreaterThan(1000);
  if (name === 'admin-invite') {
    expect(mask).toHaveLength(1);
  }
}

async function scrollWidth(page: Page): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

async function textLineCount(locator: Locator): Promise<number> {
  return locator.evaluate((node) => {
    const text =
      Array.from(node.childNodes).find((child) => child.nodeType === Node.TEXT_NODE) ?? node;
    const range = document.createRange();
    range.selectNodeContents(text);
    return range.getClientRects().length;
  });
}
