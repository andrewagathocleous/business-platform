import { execFileSync } from 'node:child_process';
import type { Dispatcher } from 'undici';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parsePhase } from './args';
import { giftMessageSha256 } from './gift';
import { assertRevokedSession } from './logout';
import { milestoneExternalId, milestoneGiftMessage, milestoneOrderPayload } from './order-fixture';
import { acceptedNewPrintJob, printAuditCovers } from './print-request';
import { attemptWithPrinting } from './print-switch';
import {
  Session,
  asRecord,
  bearer,
  field,
  localAgent,
  nested,
  numberField,
  staffSessionCookie,
  type Reply,
} from './http';
import { formatTable, hasFailure, scrub, type Row } from './report';
import { repositoryRoot } from './root';
import {
  E4_TOTALS,
  parseState,
  totalsEqual,
  writeState,
  type InvoiceTotals,
  type MilestoneState,
} from './state';

const ORIGIN = 'https://localhost:8443';
const COMPANY_A = 'Demo Company A Ltd (fictional)';
const COMPANY_B = 'Demo Company B Ltd (fictional)';
const ORDER_NUMBER = '#1001';
const PRESTA_NUMBER = '#P-1001';
const COMPANY_B_ORDER = '#2001';
const SWITCH_ON = 'milestone: mock printing for acceptance';
const SWITCH_OFF = 'milestone: printing off after acceptance';
const OIDC_TEST = 'completes an OIDC login and records whether amr includes mfa';
const LOGIN_AUDIT_TEST =
  'logs in through the development picker and lists only authorised companies';
const PRINT_SUCCESS = new Set(['done_reported', 'confirmed_printed']);
const PRINT_FAILURE = new Set(['failed', 'not_printed', 'cancelled', 'uncertain', 'held']);

async function main(): Promise<number> {
  const phase = parsePhase(process.argv.slice(2));
  const rows = phase === 'initial' ? await runInitial() : await runAfterRestart();
  console.log(formatTable(rows));
  return hasFailure(rows) ? 1 : 0;
}

async function runInitial(): Promise<Row[]> {
  const rows: Row[] = [];
  const check = checker(rows);
  check.pass('1 oidc', `covered by test \`${OIDC_TEST}\``);
  const root = repositoryRoot();
  let transport: Transport;
  try {
    transport = openTransport(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'local stack is not reachable';
    for (const item of [
      '1 dev login',
      '2 companies',
      '3 roles',
      '4 client',
      '5 invoice',
      '6 order import',
      '7 gift message',
      '8 ready',
      '9 print',
      '9 print switch restored',
      '10 audit',
      '12 admin.b order',
      '12 admin.b invoice',
      '12 admin.b pdf',
      '12 admin.b file',
      '12 admin.b print job',
      '12 fulfil.a invoices',
      '12 fulfil.a prestashop order',
      '12 service token connection',
      '12 service token company',
      '13 no HSTS',
      '12 suspended user',
      '12 logout',
    ]) {
      check.fail(item, message);
    }
    return rows;
  }
  const admin = connect(transport);
  const adminB = connect(transport);
  const fulfil = connect(transport);
  const ids: Partial<MilestoneState> = {};
  await check.run('13 no HSTS', () => assertNoHsts(admin));
  const loggedIn = await check.run('1 dev login', async () => {
    await login(admin, 'admin.a@example.test');
    return 'dev login admin.a@example.test';
  });
  if (!loggedIn) {
    await transport.close();
    failUnchecked(check, ['2 companies', ...UNCHECKED], 'dev login failed');
    return rows;
  }
  const companiesOk = await check.run('2 companies', async () => {
    await login(adminB, 'admin.b@example.test');
    const mine = await companyIds(admin);
    const theirs = await companyIds(adminB);
    ids.companyA = idOf(mine, COMPANY_A);
    ids.companyB = idOf(theirs, COMPANY_B);
    if (mine.some((company) => company.legalName === COMPANY_B)) {
      throw new Error('admin.a can see company B');
    }
    if (theirs.some((company) => company.legalName === COMPANY_A)) {
      throw new Error('admin.b can see company A');
    }
    return 'admin.a sees only company A; admin.b sees only company B';
  });
  if (!companiesOk) {
    await transport.close();
    failUnchecked(check, UNCHECKED, 'companies were not isolated');
    return rows;
  }
  const companyA = need(ids.companyA, 'company A');
  const companyB = need(ids.companyB, 'company B');
  await check.run('3 roles', async () => {
    await login(fulfil, 'fulfil.a@example.test');
    const allowed = await admin.send('GET', `/api/c/${companyA}/invoices`);
    const denied = await fulfil.send('GET', `/api/c/${companyA}/invoices`);
    if (allowed.status !== 200) {
      throw statusError('admin.a invoices', allowed);
    }
    if (denied.status !== 403) {
      throw new Error(`fulfil.a invoices returned ${String(denied.status)}`);
    }
    return 'admin.a can list invoices; fulfil.a is 403';
  });
  await check.run('4 client', async () => {
    const created = await admin.send('POST', `/api/c/${companyA}/clients`, {
      kind: 'organisation',
      displayName: 'Milestone Client (fictional)',
      defaultLanguage: 'en',
      paymentTermsDays: 30,
    });
    if (created.status !== 200) {
      throw statusError('create client', created);
    }
    ids.clientId = field(nested(created.body, 'client'), 'id');
    const loaded = await admin.send('GET', `/api/c/${companyA}/clients/${ids.clientId}`);
    if (loaded.status !== 200) {
      throw statusError('read client', loaded);
    }
    return 'client created';
  });
  await check.run('5 invoice', async () => {
    const clientId = need(ids.clientId, 'client');
    const taxCodeId = await taxCode(admin, companyA, 'STD19');
    const created = await admin.send('POST', `/api/c/${companyA}/invoices`, {
      documentType: 'invoice',
      clientId,
      pricesIncludeTax: false,
      lines: [
        {
          position: 1,
          description: 'Fictional exclusive line',
          quantity: '2',
          unit: 'ea',
          unitPrice: '10.00',
          discountPercent: '15',
          taxCodeId,
        },
      ],
    });
    if (created.status !== 200) {
      throw statusError('create invoice', created);
    }
    const invoice = nested(created.body, 'invoice');
    ids.invoiceId = field(invoice, 'id');
    ids.invoiceTotals = totalsOf(invoice);
    if (!totalsEqual(ids.invoiceTotals, E4_TOTALS)) {
      throw new Error(`totals ${ids.invoiceTotals.total}`);
    }
    if (field(invoice, 'status') !== 'draft') {
      throw new Error('invoice is not a draft');
    }
    const pdf = await admin.send('GET', `/api/c/${companyA}/invoices/${ids.invoiceId}/pdf`);
    if (pdf.status !== 200 || !pdf.bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) {
      throw new Error(`pdf returned ${String(pdf.status)}`);
    }
    return `draft total ${ids.invoiceTotals.total}; pdf ok`;
  });
  let sentGift = '';
  await check.run('6 order import', async () => {
    const existing = await findOrder(admin, companyA, ORDER_NUMBER);
    const connectionA = field(existing, 'connectionId');
    const token = await serviceToken(
      admin,
      transport.dispatcher,
      companyA,
      resolve(root, 'var/milestone-service-token.json'),
    );
    const externalId = milestoneExternalId();
    sentGift = milestoneGiftMessage(externalId);
    const at = new Date().toISOString();
    const posted = await connect(transport).send(
      'POST',
      `/api/automation/v1/c/${companyA}/store-connections/${connectionA}/events`,
      {
        eventId: `milestone:${externalId}`,
        topic: 'orders/create',
        occurredAt: at,
        payload: milestoneOrderPayload(externalId, sentGift, at),
      },
      bearer(token),
    );
    if (posted.status !== 202) {
      throw statusError('order import', posted);
    }
    if (field(posted.body, 'status') !== 'accepted') {
      throw new Error(`import status ${field(posted.body, 'status')}`);
    }
    const summary = await waitForOrder(admin, companyA, `#${externalId}`);
    ids.orderId = field(summary, 'id');
    if (field(summary, 'sourcePlatform') !== 'shopify') {
      throw new Error('order is not a shopify import');
    }
    return `${externalId} imported`;
  });
  await check.run('7 gift message', async () => {
    if (sentGift.length === 0) {
      throw new Error('gift message was not sent');
    }
    const order = await orderDetail(admin, companyA, need(ids.orderId, 'order'));
    const message = field(order, 'giftMessage');
    const hash = giftMessageSha256(sentGift);
    if (giftMessageSha256(message) !== hash) {
      throw new Error('gift message bytes differ from the bytes sent');
    }
    ids.giftSha256 = hash;
    return hash;
  });
  await check.run('8 ready', async () => {
    await moveToReady(admin, companyA, need(ids.orderId, 'order'));
    const order = await orderDetail(admin, companyA, need(ids.orderId, 'order'));
    if (field(order, 'fulfilmentStatus') !== 'ready') {
      throw new Error(`status ${field(order, 'fulfilmentStatus')}`);
    }
    return 'ready';
  });
  await runPrint(check, admin, companyA, ids);
  await check.run('10 audit', async () => {
    await expectAudit(admin, companyA, 'client.created', need(ids.clientId, 'client'));
    await expectAudit(admin, companyA, 'invoice.created', need(ids.invoiceId, 'invoice'));
    await expectAudit(admin, companyA, 'order.imported', need(ids.orderId, 'order'));
    const transitions = await auditEvents(
      admin,
      companyA,
      'order.transition',
      need(ids.orderId, 'order'),
    );
    if (!transitions.some((event) => asRecord(event.details)?.to === 'ready')) {
      throw new Error('order.transition to ready was not audited');
    }
    await expectPrintAudit(
      admin,
      companyA,
      'print_job.requested',
      need(ids.printJobId, 'print job'),
      need(ids.orderId, 'order'),
    );
    await expectPrintAudit(
      admin,
      companyA,
      'print_job.done_reported',
      need(ids.printJobId, 'print job'),
      need(ids.orderId, 'order'),
    );
    if (ids.printSwitchChanged) {
      await expectSwitchAudit(admin, companyA, SWITCH_ON);
      await expectSwitchAudit(admin, companyA, SWITCH_OFF);
    }
    return `company actions audited; login audit covered by test \`${LOGIN_AUDIT_TEST}\``;
  });
  await check.run('12 admin.b order', () =>
    expectStatus(adminB, 'GET', `/api/c/${companyB}/orders/${need(ids.orderId, 'order')}`, 404),
  );
  await check.run('12 admin.b invoice', () =>
    expectStatus(
      adminB,
      'GET',
      `/api/c/${companyB}/invoices/${need(ids.invoiceId, 'invoice')}`,
      404,
    ),
  );
  await check.run('12 admin.b pdf', () =>
    expectStatus(
      adminB,
      'GET',
      `/api/c/${companyB}/invoices/${need(ids.invoiceId, 'invoice')}/pdf`,
      404,
    ),
  );
  await check.run('12 admin.b file', () =>
    expectStatus(adminB, 'GET', `/api/c/${companyB}/files/${need(ids.fileId, 'file')}`, 404),
  );
  await check.run('12 admin.b print job', () =>
    expectStatus(
      adminB,
      'GET',
      `/api/c/${companyB}/print-jobs/${need(ids.printJobId, 'print job')}`,
      404,
    ),
  );
  await check.run('12 fulfil.a invoices', () =>
    expectStatus(fulfil, 'GET', `/api/c/${companyA}/invoices`, 403),
  );
  await check.run('12 fulfil.a prestashop order', async () => {
    const summary = await findOrder(admin, companyA, PRESTA_NUMBER);
    ids.prestashopOrderId = field(summary, 'id');
    const visible = await admin.send('GET', `/api/c/${companyA}/orders/${ids.prestashopOrderId}`);
    if (visible.status !== 200) {
      throw new Error('admin.a cannot see the PrestaShop order');
    }
    return expectStatus(fulfil, 'GET', `/api/c/${companyA}/orders/${ids.prestashopOrderId}`, 404);
  });
  await check.run('12 service token connection', async () => {
    const summary = await findOrder(adminB, companyB, COMPANY_B_ORDER);
    ids.connectionB = field(summary, 'connectionId');
    const token = await serviceToken(
      admin,
      transport.dispatcher,
      companyA,
      resolve(root, 'var/milestone-service-token.json'),
    );
    return expectPostedStatus(
      connect(transport),
      `/api/automation/v1/c/${companyA}/store-connections/${ids.connectionB}/events`,
      isolationEvent(`MS-connection-${String(Date.now())}`),
      bearer(token),
      404,
    );
  });
  await check.run('12 service token company', async () => {
    const token = await serviceToken(
      admin,
      transport.dispatcher,
      companyA,
      resolve(root, 'var/milestone-service-token.json'),
    );
    return expectPostedStatus(
      connect(transport),
      `/api/automation/v1/c/${companyB}/store-connections/${need(ids.connectionB, 'connection')}/events`,
      isolationEvent(`MS-company-${String(Date.now())}`),
      bearer(token),
      404,
    );
  });
  await check.run('12 suspended user', async () => {
    const suspended = connect(transport);
    await login(suspended, 'suspended.a@example.test');
    const me = await suspended.send('GET', '/api/me');
    if (me.status !== 200) {
      throw statusError('suspended session', me);
    }
    const list = asRecord(me.body)?.companies;
    if (!Array.isArray(list) || list.length !== 0) {
      throw new Error('suspended user still has a company');
    }
    return expectStatus(suspended, 'GET', `/api/c/${companyA}/orders`, 404);
  });
  await check.run('12 logout', async () => {
    const fresh = connect(transport);
    await login(fresh, 'admin.a@example.test');
    const sessionCookie = staffSessionCookie(fresh.jar);
    return assertRevokedSession({
      sessionCookie,
      logout: async () => fresh.send('POST', '/api/auth/logout'),
      me: async (saved) => fresh.send('GET', '/api/me', undefined, undefined, saved),
    });
  });
  writeIfComplete(root, ids);
  await transport.close();
  return rows;
}

async function runAfterRestart(): Promise<Row[]> {
  const rows: Row[] = [];
  const check = checker(rows);
  const root = repositoryRoot();
  let state: MilestoneState;
  try {
    state = parseState(readFileSync(resolve(root, 'var/milestone-state.json'), 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'state file is missing';
    for (const item of [
      '11 client',
      '11 invoice totals',
      '11 order',
      '11 gift message',
      '11 ready',
      '11 print job',
      '11 audit',
    ]) {
      check.fail(item, message);
    }
    return rows;
  }
  let transport: Transport;
  try {
    transport = openTransport(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'local stack is not reachable';
    for (const item of [
      '11 client',
      '11 invoice totals',
      '11 order',
      '11 gift message',
      '11 ready',
      '11 print job',
      '11 audit',
      '13 no HSTS',
    ]) {
      check.fail(item, message);
    }
    return rows;
  }
  const admin = connect(transport);
  await check.run('13 no HSTS', () => assertNoHsts(admin));
  const loggedIn = await check.run('11 login', async () => {
    await login(admin, 'admin.a@example.test');
    return 'dev login admin.a@example.test';
  });
  if (!loggedIn) {
    await transport.close();
    return rows;
  }
  await check.run('11 client', async () => {
    const reply = await admin.send('GET', `/api/c/${state.companyA}/clients/${state.clientId}`);
    if (reply.status !== 200) {
      throw statusError('client', reply);
    }
    return 'client still exists';
  });
  await check.run('11 invoice totals', async () => {
    const reply = await admin.send('GET', `/api/c/${state.companyA}/invoices/${state.invoiceId}`);
    if (reply.status !== 200) {
      throw statusError('invoice', reply);
    }
    const totals = totalsOf(nested(reply.body, 'invoice'));
    if (!totalsEqual(totals, state.invoiceTotals)) {
      throw new Error(`total ${totals.total} changed`);
    }
    return `total ${totals.total}`;
  });
  await check.run('11 order', async () => {
    const reply = await admin.send('GET', `/api/c/${state.companyA}/orders/${state.orderId}`);
    if (reply.status !== 200) {
      throw statusError('order', reply);
    }
    return 'order still exists';
  });
  await check.run('11 gift message', async () => {
    const order = await orderDetail(admin, state.companyA, state.orderId);
    const hash = giftMessageSha256(field(order, 'giftMessage'));
    if (hash !== state.giftSha256) {
      throw new Error('gift message bytes changed');
    }
    return hash;
  });
  await check.run('11 ready', async () => {
    const order = await orderDetail(admin, state.companyA, state.orderId);
    if (field(order, 'fulfilmentStatus') !== 'ready') {
      throw new Error(`status ${field(order, 'fulfilmentStatus')}`);
    }
    return 'ready';
  });
  await check.run('11 print job', async () => {
    const reply = await admin.send(
      'GET',
      `/api/c/${state.companyA}/print-jobs/${state.printJobId}`,
    );
    if (reply.status !== 200) {
      throw statusError('print job', reply);
    }
    const status = field(nested(reply.body, 'printJob'), 'status');
    if (!PRINT_SUCCESS.has(status)) {
      throw new Error(`status ${status}`);
    }
    return status;
  });
  await check.run('11 audit', async () => {
    await expectAudit(admin, state.companyA, 'client.created', state.clientId);
    await expectAudit(admin, state.companyA, 'invoice.created', state.invoiceId);
    await expectAudit(admin, state.companyA, 'order.imported', state.orderId);
    const transitions = await auditEvents(admin, state.companyA, 'order.transition', state.orderId);
    if (!transitions.some((event) => asRecord(event.details)?.to === 'ready')) {
      throw new Error('order.transition to ready is missing');
    }
    await expectPrintAudit(
      admin,
      state.companyA,
      'print_job.requested',
      state.printJobId,
      state.orderId,
    );
    await expectPrintAudit(
      admin,
      state.companyA,
      'print_job.done_reported',
      state.printJobId,
      state.orderId,
    );
    if (state.printSwitchChanged) {
      await expectSwitchAudit(admin, state.companyA, SWITCH_ON);
      await expectSwitchAudit(admin, state.companyA, SWITCH_OFF);
    }
    return 'audit events still exist';
  });
  await transport.close();
  return rows;
}

type Transport = {
  dispatcher: Dispatcher;
  close: () => Promise<void>;
};

function openTransport(root: string): Transport {
  const agent = localAgent(ensureCa(root));
  return { dispatcher: agent, close: () => agent.close() };
}

function connect(transport: Transport): Session {
  return new Session(ORIGIN, transport.dispatcher);
}

function ensureCa(root: string): string {
  const caPath = resolve(root, 'var/local-stack/caddy-root.crt');
  mkdirSync(dirname(caPath), { recursive: true, mode: 0o700 });
  execFileSync(
    'docker',
    [
      'compose',
      '-p',
      'business-platform-local',
      '-f',
      'infra/compose/compose.prod.yml',
      '-f',
      'infra/compose/compose.local.yml',
      '--env-file',
      '.env.local-stack',
      'cp',
      'caddy:/data/caddy/pki/authorities/local/root.crt',
      caPath,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );
  return caPath;
}

const UNCHECKED = [
  '3 roles',
  '4 client',
  '5 invoice',
  '6 order import',
  '7 gift message',
  '8 ready',
  '9 print',
  '9 print switch restored',
  '10 audit',
  '12 admin.b order',
  '12 admin.b invoice',
  '12 admin.b pdf',
  '12 admin.b file',
  '12 admin.b print job',
  '12 fulfil.a invoices',
  '12 fulfil.a prestashop order',
  '12 service token connection',
  '12 service token company',
  '12 suspended user',
  '12 logout',
];

function failUnchecked(
  check: { fail: (item: string, detail: string) => void },
  items: readonly string[],
  detail: string,
): void {
  for (const item of items) {
    check.fail(item, detail);
  }
}

function checker(rows: Row[]): {
  pass: (item: string, detail: string) => void;
  fail: (item: string, detail: string) => void;
  run: (item: string, fn: () => Promise<string>) => Promise<boolean>;
} {
  return {
    pass(item, detail) {
      rows.push({ item, result: 'PASS', detail });
    },
    fail(item, detail) {
      rows.push({ item, result: 'FAIL', detail: scrub(detail) });
    },
    async run(item, fn) {
      try {
        rows.push({ item, result: 'PASS', detail: await fn() });
        return true;
      } catch (error) {
        rows.push({
          item,
          result: 'FAIL',
          detail: scrub(error instanceof Error ? error.message : 'failed'),
        });
        return false;
      }
    },
  };
}

async function login(session: Session, email: string): Promise<void> {
  const reply = await session.send('POST', '/api/auth/dev/login', { email });
  if (reply.status !== 200) {
    throw statusError(`login ${email}`, reply);
  }
}

async function companyIds(session: Session): Promise<{ id: string; legalName: string }[]> {
  const reply = await session.send('GET', '/api/me');
  if (reply.status !== 200) {
    throw statusError('session', reply);
  }
  const list = asRecord(reply.body)?.companies;
  if (!Array.isArray(list)) {
    throw new Error('session did not include companies');
  }
  return list.map((item) => {
    const record = asRecord(item);
    if (!record || typeof record.id !== 'string' || typeof record.legalName !== 'string') {
      throw new Error('session did not include companies');
    }
    return { id: record.id, legalName: record.legalName };
  });
}

function idOf(companies: { id: string; legalName: string }[], legalName: string): string {
  const found = companies.find((company) => company.legalName === legalName);
  if (!found) {
    throw new Error(`company ${legalName} is not in this session`);
  }
  return found.id;
}

async function taxCode(session: Session, companyId: string, code: string): Promise<string> {
  const reply = await session.send('GET', `/api/c/${companyId}/tax-codes`);
  if (reply.status !== 200) {
    throw statusError('tax codes', reply);
  }
  const list = asRecord(reply.body)?.taxCodes;
  if (!Array.isArray(list)) {
    throw new Error('tax codes are missing');
  }
  for (const item of list) {
    const record = asRecord(item);
    if (record?.code === code && typeof record.id === 'string') {
      return record.id;
    }
  }
  throw new Error(`tax code ${code} was not found`);
}

function totalsOf(invoice: Record<string, unknown>): InvoiceTotals {
  return {
    subtotal: field(invoice, 'subtotal'),
    discountTotal: field(invoice, 'discountTotal'),
    netTotal: field(invoice, 'netTotal'),
    taxTotal: field(invoice, 'taxTotal'),
    total: field(invoice, 'total'),
  };
}

async function findOrder(
  session: Session,
  companyId: string,
  externalNumber: string,
): Promise<Record<string, unknown>> {
  const reply = await session.send(
    'GET',
    `/api/c/${companyId}/orders?pageSize=100&q=${encodeURIComponent(externalNumber)}`,
  );
  if (reply.status !== 200) {
    throw statusError('order list', reply);
  }
  const orders = asRecord(reply.body)?.orders;
  if (!Array.isArray(orders)) {
    throw new Error('order list is missing');
  }
  for (const item of orders) {
    const record = asRecord(item);
    if (record?.externalNumber === externalNumber) {
      return record;
    }
  }
  throw new Error(`order ${externalNumber} was not found`);
}

async function orderDetail(
  session: Session,
  companyId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  const reply = await session.send('GET', `/api/c/${companyId}/orders/${orderId}`);
  if (reply.status !== 200) {
    throw statusError('order', reply);
  }
  return nested(reply.body, 'order');
}

async function moveToReady(session: Session, companyId: string, orderId: string): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    const order = await orderDetail(session, companyId, orderId);
    const status = field(order, 'fulfilmentStatus');
    if (status === 'ready') {
      return;
    }
    const next =
      status === 'new' || status === 'review_required'
        ? 'preparing'
        : status === 'preparing'
          ? 'ready'
          : '';
    if (next.length === 0) {
      throw new Error(`cannot move ${status} to ready`);
    }
    const reply = await session.send('POST', `/api/c/${companyId}/orders/${orderId}/transitions`, {
      to: next,
      expectedVersion: numberField(order, 'version'),
    });
    if (reply.status !== 200) {
      throw statusError(`transition to ${next}`, reply);
    }
  }
  throw new Error('transition did not reach ready');
}

async function printPackingSlip(
  session: Session,
  companyId: string,
  orderId: string,
): Promise<{ id: string; fileId: string; status: string }> {
  const requested = await session.send('POST', `/api/c/${companyId}/print-requests`, {
    documentType: 'packing_slip',
    sourceType: 'order',
    sourceId: orderId,
  });
  if (requested.status !== 200) {
    if (asRecord(asRecord(requested.body)?.error)?.code === 'already_printed') {
      throw new Error('already_printed');
    }
    throw statusError('print request', requested);
  }
  const created = acceptedNewPrintJob(requested.body, orderId, 'packing_slip');
  const printJobId = created.id;
  const deadline = Date.now() + 90_000;
  let status = '';
  let fileId = '';
  while (Date.now() < deadline) {
    const reply = await session.send('GET', `/api/c/${companyId}/print-jobs/${printJobId}`);
    if (reply.status !== 200) {
      throw statusError('print job', reply);
    }
    const job = nested(reply.body, 'printJob');
    status = field(job, 'status');
    if (typeof job.fileId === 'string') {
      fileId = job.fileId;
    }
    if (PRINT_SUCCESS.has(status)) {
      if (fileId.length === 0) {
        throw new Error('print job has no file');
      }
      return { id: printJobId, fileId, status };
    }
    if (PRINT_FAILURE.has(status)) {
      throw new Error(`print job ${status}`);
    }
    await delay(1000);
  }
  throw new Error(`print job still ${status}`);
}

async function auditEvents(
  session: Session,
  companyId: string,
  action: string,
  objectId?: string,
): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({ action, limit: '100', outcome: 'success' });
  if (objectId) {
    query.set('objectId', objectId);
  }
  const reply = await session.send('GET', `/api/c/${companyId}/audit-events?${query.toString()}`);
  if (reply.status !== 200) {
    throw statusError(`audit ${action}`, reply);
  }
  const events = asRecord(reply.body)?.events;
  if (!Array.isArray(events)) {
    throw new Error('audit events are missing');
  }
  return events.filter((item): item is Record<string, unknown> => asRecord(item) !== null);
}

async function expectAudit(
  session: Session,
  companyId: string,
  action: string,
  objectId: string,
): Promise<void> {
  const events = await auditEvents(session, companyId, action, objectId);
  if (events.length === 0) {
    throw new Error(`${action} was not audited`);
  }
}

async function expectPrintAudit(
  session: Session,
  companyId: string,
  action: string,
  printJobId: string,
  orderId: string,
): Promise<void> {
  const events = await auditEvents(session, companyId, action, printJobId);
  if (!printAuditCovers(events, action, printJobId, orderId)) {
    throw new Error(`${action} was not audited for this print job and order`);
  }
}

async function expectSwitchAudit(
  session: Session,
  companyId: string,
  reason: string,
): Promise<void> {
  const events = await auditEvents(session, companyId, 'automation_switch.updated');
  const found = events.some((event) => asRecord(event.details)?.reason === reason);
  if (!found) {
    throw new Error(`switch reason was not audited`);
  }
}

async function serviceToken(
  session: Session,
  dispatcher: Dispatcher,
  companyId: string,
  file: string,
): Promise<string> {
  const existing = readToken(file);
  if (existing?.companyId === companyId) {
    const probe = new Session(ORIGIN, dispatcher);
    const ping = await probe.send(
      'GET',
      `/api/automation/v1/c/${companyId}/ping`,
      undefined,
      bearer(existing.token),
    );
    if (ping.status === 200) {
      return existing.token;
    }
  }
  const created = await session.send('POST', `/api/c/${companyId}/service-identities`, {
    name: 'milestone-import',
    purpose: 'milestone acceptance',
    permissions: ['store.events.ingest'],
  });
  if (created.status !== 200) {
    throw statusError('service identity', created);
  }
  const token = field(created.body, 'token');
  if (!token.startsWith('bps_')) {
    throw new Error('service identity did not return a token');
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ companyId, token })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

function readToken(file: string): { companyId: string; token: string } | null {
  if (!existsSync(file)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const record = asRecord(parsed);
  if (!record || typeof record.companyId !== 'string' || typeof record.token !== 'string') {
    throw new Error('token file is unreadable');
  }
  return { companyId: record.companyId, token: record.token };
}

async function expectStatus(
  session: Session,
  method: 'GET' | 'POST',
  path: string,
  status: number,
): Promise<string> {
  const reply = await session.send(method, path);
  if (reply.status !== status) {
    throw new Error(`expected ${String(status)}, got ${String(reply.status)}`);
  }
  return String(status);
}

function writeIfComplete(root: string, ids: Partial<MilestoneState>): void {
  if (!isComplete(ids)) {
    return;
  }
  writeState(resolve(root, 'var/milestone-state.json'), ids);
}

function isComplete(ids: Partial<MilestoneState>): ids is MilestoneState {
  return (
    typeof ids.companyA === 'string' &&
    typeof ids.companyB === 'string' &&
    typeof ids.clientId === 'string' &&
    typeof ids.invoiceId === 'string' &&
    ids.invoiceTotals !== undefined &&
    totalsEqual(ids.invoiceTotals, E4_TOTALS) &&
    typeof ids.orderId === 'string' &&
    typeof ids.giftSha256 === 'string' &&
    typeof ids.printJobId === 'string' &&
    typeof ids.fileId === 'string' &&
    typeof ids.prestashopOrderId === 'string' &&
    typeof ids.connectionB === 'string' &&
    typeof ids.printSwitchChanged === 'boolean'
  );
}

async function assertNoHsts(session: Session): Promise<string> {
  const health = await session.send('GET', '/api/health/ready');
  if (health.status !== 200) {
    throw statusError('api health', health);
  }
  if (health.headers.get('strict-transport-security')) {
    throw new Error('HSTS is set on the local API');
  }
  return 'api health has no HSTS';
}

async function runPrint(
  check: {
    pass: (item: string, detail: string) => void;
    fail: (item: string, detail: string) => void;
  },
  session: Session,
  companyId: string,
  ids: Partial<MilestoneState>,
): Promise<void> {
  try {
    const listed = await session.send('GET', `/api/c/${companyId}/automation/switches`);
    const enabled = printingEnabled(listed);
    const readEnabled = async (): Promise<boolean> => {
      const again = await session.send('GET', `/api/c/${companyId}/automation/switches`);
      return printingEnabled(again);
    };
    const attempt = await attemptWithPrinting({
      enabled,
      enableReason: SWITCH_ON,
      restoreReason: SWITCH_OFF,
      enable: (reason) => setPrinting(session, companyId, true, reason),
      readEnabled,
      restore: (next, reason) => setPrinting(session, companyId, next, reason),
      run: () => printPackingSlip(session, companyId, need(ids.orderId, 'order')),
    });
    ids.printSwitchChanged = attempt.changed;
    if (attempt.value) {
      ids.printJobId = attempt.value.id;
      ids.fileId = attempt.value.fileId;
    }
    if (attempt.error instanceof Error) {
      check.fail('9 print', attempt.error.message);
    } else if (attempt.error) {
      check.fail('9 print', 'print failed');
    } else if (attempt.value) {
      check.pass('9 print', attempt.value.status);
    } else {
      check.fail('9 print', 'print did not return a job');
    }
    if (attempt.cleanupError instanceof Error) {
      check.fail('9 print switch restored', attempt.cleanupError.message);
    } else if (attempt.cleanupError) {
      check.fail('9 print switch restored', 'restore failed');
    } else if (attempt.persisted === undefined) {
      check.fail('9 print switch restored', 'printing switch was not read back');
    } else {
      const readBack = attempt.persisted ? 'on' : 'off';
      check.pass(
        '9 print switch restored',
        attempt.changed ? `restored ${readBack}` : `unchanged ${readBack}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'print failed';
    check.fail('9 print', message);
    check.fail('9 print switch restored', message);
  }
}

function printingEnabled(reply: Reply): boolean {
  if (reply.status !== 200) {
    throw statusError('printing switch', reply);
  }
  const switches = asRecord(reply.body)?.switches;
  if (!Array.isArray(switches)) {
    throw new Error('switches are missing');
  }
  for (const item of switches) {
    const record = asRecord(item);
    if (record?.key === 'printing') {
      if (typeof record.enabled !== 'boolean') {
        throw new Error('printing switch is missing');
      }
      return record.enabled;
    }
  }
  throw new Error('printing switch is missing');
}

async function setPrinting(
  session: Session,
  companyId: string,
  enabled: boolean,
  reason: string,
): Promise<void> {
  const reply = await session.send('PUT', `/api/c/${companyId}/automation/switches/printing`, {
    enabled,
    reason,
  });
  if (reply.status !== 200) {
    throw statusError('printing switch', reply);
  }
}

async function waitForOrder(
  session: Session,
  companyId: string,
  externalNumber: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 90_000;
  let last = `order ${externalNumber} was not found`;
  while (Date.now() < deadline) {
    try {
      return await findOrder(session, companyId, externalNumber);
    } catch (error) {
      last = error instanceof Error ? error.message : last;
      await delay(1000);
    }
  }
  throw new Error(last);
}

function isolationEvent(externalId: string): unknown {
  const at = '2026-03-01T00:00:00.000Z';
  return {
    eventId: `milestone:isolation:${externalId}`,
    topic: 'orders/create',
    occurredAt: at,
    payload: milestoneOrderPayload(externalId, milestoneGiftMessage(externalId), at),
  };
}

async function expectPostedStatus(
  session: Session,
  path: string,
  payload: unknown,
  authorization: string,
  status: number,
): Promise<string> {
  const reply = await session.send('POST', path, payload, authorization);
  if (reply.status !== status) {
    throw new Error(`expected ${String(status)}, got ${String(reply.status)}`);
  }
  return String(status);
}

function need(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is not available`);
  }
  return value;
}

function statusError(action: string, reply: Reply): Error {
  const snippet = reply.text.replace(/\s+/g, ' ').slice(0, 180);
  return new Error(scrub(`${action} returned ${String(reply.status)} ${snippet}`));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('verify.ts') || entry.endsWith('verify.js')) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(scrub(error instanceof Error ? error.message : 'milestone verify failed'));
      process.exitCode = 1;
    },
  );
}
