import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');

loadEnv({ path: resolve(root, '.env') });

for (const relative of [
  'packages/db/dist/index.js',
  'packages/domain/dist/index.js',
  'packages/documents/dist/index.js',
  'packages/integrations/dist/index.js',
]) {
  require(resolve(root, relative));
  console.log(`loaded ${relative}`);
}

const documents = require(resolve(root, 'packages/documents/dist/index.js'));
const draftPdf = await documents.renderInvoiceDraft({
  language: 'el',
  documentType: 'invoice',
  currency: 'EUR',
  pricesIncludeTax: false,
  issueDate: '2026-03-01',
  dueDate: '2026-03-31',
  reference: null,
  notes: null,
  terms: null,
  subtotal: '1.00',
  discountTotal: '0.00',
  netTotal: '1.00',
  taxTotal: '0.19',
  total: '1.19',
  seller: {
    displayName: 'Nutbox (demo data)',
    legalName: 'Demo Company A Ltd (fictional)',
    vatNumber: null,
    addressLines: ['Nicosia'],
  },
  client: {
    displayName: 'Μαρία Παπαδοπούλου',
    legalName: null,
    vatNumber: null,
    addressLines: [],
  },
  lines: [
    {
      description: 'Mixed nuts',
      quantity: '1.0000',
      unit: 'ea',
      unitPrice: '1.0000',
      discountPercent: '0.00',
      taxRatePercent: '19.0000',
      lineNet: '1.00',
    },
  ],
  taxSummary: [{ code: 'STD19', ratePercent: '19.0000', net: '1.00', tax: '0.19', gross: '1.19' }],
});
if (!Buffer.isBuffer(draftPdf) || draftPdf.subarray(0, 5).toString('utf8') !== '%PDF-') {
  console.error('built documents package did not render a PDF');
  process.exit(1);
}
console.log(`rendered draft PDF ${String(draftPdf.length)} bytes`);

const packingPdf = await documents.renderPackingSlip(
  {
    orderNumber: '#1001',
    storeName: 'Nutbox Demo Shopify',
    deliveryMethod: 'courier_cy',
    recipientName: 'Μαρία Παπαδοπούλου',
    recipientLines: ['1 Demo Street'],
    items: [{ sku: 'NUTS', title: 'Mixed nuts', variantTitle: '250 g', quantity: '2.0000' }],
    hasGiftMessage: true,
  },
  { legalName: 'Demo Company A Ltd (fictional)', tradingName: 'Nutbox (demo data)' },
  'en',
);
if (!Buffer.isBuffer(packingPdf) || packingPdf.subarray(0, 5).toString('utf8') !== '%PDF-') {
  console.error('built documents package did not render a packing slip');
  process.exit(1);
}
console.log(`rendered packing slip ${String(packingPdf.length)} bytes`);

const gift = await documents.renderGiftMessage('Χρόνια πολλά, Μαρία!\n\nΜε αγάπη, \nΓιώργος & Ελένη — «καλή χρονιά»', {
  pageWidthMm: '148.00',
  pageHeightMm: '105.00',
  marginTopMm: '12.00',
  marginRightMm: '12.00',
  marginBottomMm: '12.00',
  marginLeftMm: '12.00',
  fontSizePt: '16.00',
  minFontSizePt: '10.00',
  lineHeight: '1.200',
  align: 'center',
  verticalAlign: 'middle',
});
if (!Buffer.isBuffer(gift.pdf) || gift.pdf.subarray(0, 5).toString('utf8') !== '%PDF-' || gift.fits !== true) {
  console.error('built documents package did not render a gift message');
  process.exit(1);
}
const box = mediaBox(gift.pdf);
const widthPt = (148 * 72) / 25.4;
const heightPt = (105 * 72) / 25.4;
if (!box || Math.abs(box.width - widthPt) > 0.5 || Math.abs(box.height - heightPt) > 0.5) {
  console.error('gift message page size is not 148 × 105 mm');
  process.exit(1);
}
console.log(`rendered gift message ${String(gift.pdf.length)} bytes`);

const integrations = require(resolve(root, 'packages/integrations/dist/index.js'));
const mapped = integrations.mapShopifyOrder(
  {
    id: 'gid://shopify/Order/smoke',
    name: '#smoke',
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:15:00.000Z',
    displayFinancialStatus: 'PAID',
    currencyCode: 'EUR',
    shippingLine: { code: 'local', title: 'Local courier' },
    lineItems: { nodes: [] },
    subtotalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
    totalShippingPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
    totalTaxSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
    totalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'EUR' } },
  },
  { giftMessageKeys: ['Gift Message'], deliveryMethodMap: { local: 'courier_cy' } },
);
if (mapped.externalNumber !== '#smoke' || mapped.paymentStatus !== 'paid') {
  console.error('built integrations package did not map a Shopify order');
  process.exit(1);
}
console.log('mapped Shopify order');

const printRoot = await mkdtemp(join(tmpdir(), 'bp-smoke-print-'));
try {
  const provider = new integrations.MockPrintProvider(printRoot);
  const companyId = '01932a1e-7b4c-7c2a-8e10-111111111111';
  const printJobId = '01932a1e-7b4c-7c2a-8e10-222222222222';
  const submitted = await provider.submit({
    companyId,
    printJobId,
    printerExternalId: 'mock-laserjet-online',
    pdf: packingPdf,
    copies: 1,
    paperSize: 'A4',
    title: 'packing slip',
    idempotencyKey: `pj_${printJobId}`,
  });
  if (provider.provider !== 'mock' || provider.label !== 'Simulated — no physical printing') {
    console.error('mock print provider is not labelled as simulated');
    process.exit(1);
  }
  if (submitted.providerJobId !== `mock:${companyId}:${printJobId}`) {
    console.error('mock print did not return a provider job id');
    process.exit(1);
  }
  const written = await readFile(join(printRoot, companyId, `${printJobId}.pdf`));
  if (!written.equals(packingPdf)) {
    console.error('mock print output PDF is missing');
    process.exit(1);
  }
  console.log(`mock print wrote ${String(written.length)} bytes`);
} finally {
  await rm(printRoot, { recursive: true, force: true });
}

const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl) {
  console.error('DATABASE_URL_TEST is required to smoke-check the built API');
  process.exit(1);
}

const port = await freePort();
const env = {
  ...process.env,
  APP_ENV: 'test',
  AUTH_DEV_LOGIN_ENABLED: 'false',
  SESSION_COOKIE_SECURE: 'false',
  CSRF_SECRET: 'smoke-dist-csrf-secret',
  AUTH_REQUIRE_MFA_FOR_PRIVILEGED: 'false',
  OIDC_ISSUER: '',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
  OIDC_REDIRECT_URI: '',
  APP_MASTER_KEYS: JSON.stringify({ k1: Buffer.alloc(32, 3).toString('base64') }),
  APP_MASTER_KEY_ACTIVE: 'k1',
  DATABASE_URL: databaseUrl,
  PORT: String(port),
  HOST: '127.0.0.1',
  THROTTLE_ENABLED_IN_TEST: 'false',
};

await smokeHttp(env, port);
await smokeWorker(env);
console.log('built API ready and both processes exited 0');

async function smokeHttp(childEnv, listenPort) {
  const child = start(resolve(root, 'apps/api/dist/main.js'), childEnv);
  try {
    await waitForReady(listenPort, child);
    console.log(`GET /api/health/ready 200 on port ${String(listenPort)}`);
    await stop(child, 'api');
  } catch (error) {
    await stop(child, 'api').catch(() => undefined);
    console.error(scrub(child.output()));
    throw error;
  }
}

async function smokeWorker(childEnv) {
  const child = start(resolve(root, 'apps/api/dist/main.worker.js'), childEnv);
  try {
    await waitForOutput(child, 'job loop started');
    await waitForOutput(child, 'worker ready');
    console.log('worker job loop started');
    await stop(child, 'worker');
  } catch (error) {
    await stop(child, 'worker').catch(() => undefined);
    console.error(scrub(child.output()));
    throw error;
  }
}

function mediaBox(pdf) {
  const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function start(script, childEnv) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk) => {
    output += chunk.toString();
    if (output.length > 20_000) {
      output = output.slice(-20_000);
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  return {
    child,
    output: () => output,
    includes: (text) => output.includes(text),
  };
}

async function waitForReady(listenPort, running) {
  const deadline = Date.now() + 20_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) {
      throw new Error(`api exited ${String(running.child.exitCode)} before ready`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${String(listenPort)}/api/health/ready`);
      if (response.status === 200) {
        return;
      }
      last = `status ${String(response.status)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : 'fetch failed';
    }
    await delay(200);
  }
  throw new Error(`GET /api/health/ready did not return 200 (${last})`);
}

async function waitForOutput(running, text) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (running.includes(text)) {
      return;
    }
    if (running.child.exitCode !== null) {
      throw new Error(`worker exited ${String(running.child.exitCode)} before ${text}`);
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${text}`);
}

async function stop(running, name) {
  if (running.child.exitCode !== null) {
    if (running.child.exitCode !== 0) {
      throw new Error(`${name} already exited ${String(running.child.exitCode)}`);
    }
    return;
  }
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      running.child.kill('SIGKILL');
      reject(new Error(`${name} did not exit 0 after SIGTERM`));
    }, 10_000);
    running.child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited ${String(code)}`));
    });
  });
  running.child.kill('SIGTERM');
  await exited;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const listenPort = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (listenPort < 1) {
          reject(new Error('could not allocate a port'));
          return;
        }
        resolvePort(listenPort);
      });
    });
  });
}

function scrub(text) {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]');
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
