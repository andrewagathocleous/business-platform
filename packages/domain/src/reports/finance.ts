import { parseAmount } from '../money';
import { countedOn, openBalance, sourceRemaining, type DatedAmount } from '../payments/settlement';

export const INVOICED_BASIS = 'by issue date; credit notes subtracted';
export const COLLECTED_BASIS =
  'by payment and refund date; voided payments and refunds are excluded';

export type ReportFigure = { amount: string; basis: string };
type TaxAmounts = { basis: string; net: string; tax: string; gross: string };
type CountedTaxAmounts = TaxAmounts & { count: number };
export type InvoicedDocument = {
  documentType: 'invoice' | 'credit_note';
  currency: string;
  taxSummary: readonly {
    taxCodeId: string;
    code: string;
    name: string;
    net: string;
    tax: string;
    gross: string;
  }[];
};
type TaxCodeReport = {
  taxCodeId: string;
  code: string;
  name: string;
  invoiced: TaxAmounts;
  credited: TaxAmounts;
  totals: TaxAmounts;
};
type InvoicedCurrency = {
  currency: string;
  invoiced: CountedTaxAmounts;
  credited: CountedTaxAmounts;
  totals: TaxAmounts;
  taxCodes: TaxCodeReport[];
};

function taxAmounts(): TaxAmounts {
  return { basis: INVOICED_BASIS, net: '0.00', tax: '0.00', gross: '0.00' };
}

function addTaxAmounts(target: TaxAmounts, row: Omit<TaxAmounts, 'basis'>, subtract = false) {
  for (const key of ['net', 'tax', 'gross'] as const) {
    const amount = parseAmount(row[key], 2);
    target[key] = (
      subtract
        ? parseAmount(target[key], 2).minus(amount)
        : parseAmount(target[key], 2).plus(amount)
    ).toFixed(2);
  }
}

/** Rows are in issue-date/id order. A renamed code keeps its first snapshot in the period. */
export function invoicedReport(documents: readonly InvoicedDocument[]): InvoicedCurrency[] {
  const currencies = new Map<string, InvoicedCurrency & { codes: Map<string, TaxCodeReport> }>();
  for (const document of documents) {
    let group = currencies.get(document.currency);
    if (!group) {
      group = {
        currency: document.currency,
        invoiced: { ...taxAmounts(), count: 0 },
        credited: { ...taxAmounts(), count: 0 },
        totals: taxAmounts(),
        taxCodes: [],
        codes: new Map(),
      };
      currencies.set(document.currency, group);
    }
    const credit = document.documentType === 'credit_note';
    const kind = credit ? 'credited' : 'invoiced';
    group[kind].count += 1;
    for (const row of document.taxSummary) {
      let code = group.codes.get(row.taxCodeId);
      if (!code) {
        code = {
          taxCodeId: row.taxCodeId,
          code: row.code,
          name: row.name,
          invoiced: taxAmounts(),
          credited: taxAmounts(),
          totals: taxAmounts(),
        };
        group.codes.set(row.taxCodeId, code);
        group.taxCodes.push(code);
      }
      addTaxAmounts(code[kind], row);
      addTaxAmounts(code.totals, row, credit);
      addTaxAmounts(group[kind], row);
      addTaxAmounts(group.totals, row, credit);
    }
  }
  return [...currencies.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((group) => ({
      currency: group.currency,
      invoiced: group.invoiced,
      credited: group.credited,
      totals: group.totals,
      taxCodes: group.taxCodes.sort((a, b) => a.taxCodeId.localeCompare(b.taxCodeId)),
    }));
}

export type CollectedMovement = {
  kind: 'payment' | 'refund';
  currency: string;
  method: string;
  amount: string;
};
type CountedFigure = ReportFigure & { count: number };
type CollectionTotals = { payments: CountedFigure; refunds: CountedFigure; total: ReportFigure };
type CollectedCurrency = CollectionTotals & {
  currency: string;
  methods: (CollectionTotals & { method: string })[];
};

function figure(basis: string): ReportFigure {
  return { basis, amount: '0.00' };
}

function collectionTotals(): CollectionTotals {
  return {
    payments: { ...figure(COLLECTED_BASIS), count: 0 },
    refunds: { ...figure(COLLECTED_BASIS), count: 0 },
    total: figure(COLLECTED_BASIS),
  };
}

function addFigure(target: ReportFigure, amount: string, subtract = false) {
  target.amount = (
    subtract
      ? parseAmount(target.amount, 2).minus(parseAmount(amount, 2))
      : parseAmount(target.amount, 2).plus(parseAmount(amount, 2))
  ).toFixed(2);
}

export function collectedReport(movements: readonly CollectedMovement[]): CollectedCurrency[] {
  const currencies = new Map<string, CollectedCurrency>();
  const methods = new Map<string, Map<string, CollectionTotals & { method: string }>>();
  for (const movement of movements) {
    let group = currencies.get(movement.currency);
    if (!group) {
      group = { currency: movement.currency, ...collectionTotals(), methods: [] };
      currencies.set(movement.currency, group);
      methods.set(movement.currency, new Map());
    }
    const currencyMethods = methods.get(movement.currency);
    if (!currencyMethods) throw new Error('Missing currency methods');
    let method = currencyMethods.get(movement.method);
    if (!method) {
      method = { method: movement.method, ...collectionTotals() };
      currencyMethods.set(movement.method, method);
      group.methods.push(method);
    }
    const refund = movement.kind === 'refund';
    for (const target of [group, method]) {
      const amount = target[refund ? 'refunds' : 'payments'];
      amount.count += 1;
      addFigure(amount, movement.amount);
      addFigure(target.total, movement.amount, refund);
    }
  }
  return [...currencies.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((group) => ({
      ...group,
      methods: group.methods.sort((a, b) => a.method.localeCompare(b.method)),
    }));
}

type ClientCurrency = { clientId: string; clientName: string; currency: string };
export type AgeingInvoice = ClientCurrency & {
  id: string;
  number: string | null;
  issueDate: string;
  dueDate: string;
  total: string;
  allocations: readonly DatedAmount[];
};
export type AgeingSource = ClientCurrency & {
  id: string;
  type: 'payment' | 'credit_note';
  date: string;
  voidedOn: string | null;
  amount: string;
  allocations: readonly DatedAmount[];
  refunds: readonly DatedAmount[];
};
export type AgeingBucket = 'current' | 'days1To30' | 'days31To60' | 'days61To90' | 'over90';
type Buckets = Record<AgeingBucket, ReportFigure>;
type AgeingTotals = { buckets: Buckets; openTotal: ReportFigure; creditTotal: ReportFigure };
type AgeingClient = AgeingTotals & {
  clientId: string;
  clientName: string;
  invoices: {
    id: string;
    number: string | null;
    issueDate: string;
    dueDate: string;
    bucket: AgeingBucket;
    openBalance: ReportFigure;
  }[];
  credits: { id: string; type: AgeingSource['type']; date: string; remaining: ReportFigure }[];
};
type AgeingCurrency = AgeingTotals & { currency: string; clients: AgeingClient[] };

export function ageingBucket(dueDate: string, asOf: string): AgeingBucket {
  const days = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000;
  if (days <= 0) return 'current';
  if (days <= 30) return 'days1To30';
  if (days <= 60) return 'days31To60';
  if (days <= 90) return 'days61To90';
  return 'over90';
}

function ageingTotals(basis: string): AgeingTotals {
  return {
    buckets: {
      current: figure(basis),
      days1To30: figure(basis),
      days31To60: figure(basis),
      days61To90: figure(basis),
      over90: figure(basis),
    },
    openTotal: figure(basis),
    creditTotal: figure(basis),
  };
}

export function ageingReport(
  invoices: readonly AgeingInvoice[],
  sources: readonly AgeingSource[],
  asOf: string,
): AgeingCurrency[] {
  const basis = `as of ${asOf}, by due date; allocations and refunds counted by their effective dates`;
  const currencies = new Map<string, AgeingCurrency>();
  const clients = new Map<string, Map<string, AgeingClient>>();
  function clientGroup(row: ClientCurrency): [AgeingCurrency, AgeingClient] {
    let group = currencies.get(row.currency);
    if (!group) {
      group = { currency: row.currency, ...ageingTotals(basis), clients: [] };
      currencies.set(row.currency, group);
      clients.set(row.currency, new Map());
    }
    const currencyClients = clients.get(row.currency);
    if (!currencyClients) throw new Error('Missing currency clients');
    let client = currencyClients.get(row.clientId);
    if (!client) {
      client = {
        clientId: row.clientId,
        clientName: row.clientName,
        ...ageingTotals(basis),
        invoices: [],
        credits: [],
      };
      currencyClients.set(row.clientId, client);
      group.clients.push(client);
    }
    return [group, client];
  }
  for (const invoice of invoices) {
    if (invoice.issueDate > asOf) continue;
    const amount = openBalance(invoice, asOf);
    if (!parseAmount(amount, 2).gt('0')) continue;
    const [group, client] = clientGroup(invoice);
    const bucket = ageingBucket(invoice.dueDate, asOf);
    client.invoices.push({
      id: invoice.id,
      number: invoice.number,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      bucket,
      openBalance: { amount, basis },
    });
    for (const target of [group, client]) {
      addFigure(target.buckets[bucket], amount);
      addFigure(target.openTotal, amount);
    }
  }
  for (const source of sources) {
    if (source.date > asOf || (source.voidedOn !== null && source.voidedOn <= asOf)) continue;
    // Collapse historical usage into active totals for the shared remaining-credit arithmetic.
    const usage = (items: readonly DatedAmount[]): DatedAmount[] => [
      { amount: countedOn(items, asOf), from: asOf, until: null },
    ];
    const amount = sourceRemaining({
      amount: source.amount,
      allocations: usage(source.allocations),
      refunds: usage(source.refunds),
    });
    if (!parseAmount(amount, 2).gt('0')) continue;
    const [group, client] = clientGroup(source);
    client.credits.push({
      id: source.id,
      type: source.type,
      date: source.date,
      remaining: { amount, basis },
    });
    addFigure(group.creditTotal, amount);
    addFigure(client.creditTotal, amount);
  }
  return [...currencies.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((group) => ({
      ...group,
      clients: group.clients
        .sort(
          (a, b) =>
            a.clientName.localeCompare(b.clientName) || a.clientId.localeCompare(b.clientId),
        )
        .map((client) => ({
          ...client,
          invoices: client.invoices.sort(
            (a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id),
          ),
          credits: client.credits.sort(
            (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
          ),
        })),
    }));
}
