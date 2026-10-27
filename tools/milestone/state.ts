import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type InvoiceTotals = {
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
};

export type MilestoneState = {
  companyA: string;
  companyB: string;
  clientId: string;
  invoiceId: string;
  invoiceTotals: InvoiceTotals;
  orderId: string;
  giftSha256: string;
  printJobId: string;
  fileId: string;
  prestashopOrderId: string;
  connectionB: string;
  printSwitchChanged: boolean;
};

export const E4_TOTALS: InvoiceTotals = {
  subtotal: '20.00',
  discountTotal: '3.00',
  netTotal: '17.00',
  taxTotal: '3.23',
  total: '20.23',
};

const TOTAL_KEYS = ['subtotal', 'discountTotal', 'netTotal', 'taxTotal', 'total'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export function totalsEqual(actual: InvoiceTotals, expected: InvoiceTotals): boolean {
  return TOTAL_KEYS.every((key) => actual[key] === expected[key]);
}

export function parseState(text: string): MilestoneState {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.invoiceTotals)) {
    throw new Error('milestone state is unreadable');
  }
  const totals = parsed.invoiceTotals;
  const invoiceTotals: InvoiceTotals = {
    subtotal: money(totals, 'subtotal'),
    discountTotal: money(totals, 'discountTotal'),
    netTotal: money(totals, 'netTotal'),
    taxTotal: money(totals, 'taxTotal'),
    total: money(totals, 'total'),
  };
  return {
    companyA: uuidField(parsed, 'companyA'),
    companyB: uuidField(parsed, 'companyB'),
    clientId: uuidField(parsed, 'clientId'),
    invoiceId: uuidField(parsed, 'invoiceId'),
    invoiceTotals,
    orderId: uuidField(parsed, 'orderId'),
    giftSha256: shaField(parsed),
    printJobId: uuidField(parsed, 'printJobId'),
    fileId: uuidField(parsed, 'fileId'),
    prestashopOrderId: uuidField(parsed, 'prestashopOrderId'),
    connectionB: uuidField(parsed, 'connectionB'),
    printSwitchChanged: booleanField(parsed, 'printSwitchChanged'),
  };
}

export function readState(file: string): MilestoneState {
  return parseState(readFileSync(file, 'utf8'));
}

export function writeState(file: string, state: MilestoneState): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function money(record: Record<string, unknown>, key: keyof InvoiceTotals): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error('milestone state is unreadable');
  }
  return value;
}

function uuidField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('milestone state is unreadable');
  }
  return value;
}

function shaField(record: Record<string, unknown>): string {
  const value = record.giftSha256;
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error('milestone state is unreadable');
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error('milestone state is unreadable');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
