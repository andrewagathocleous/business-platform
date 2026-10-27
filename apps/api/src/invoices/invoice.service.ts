import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import {
  addDaysToBusinessDate,
  businessDateInZone,
  calculateDocumentTotals,
  currencyMinorDigits,
  DocumentValidationError,
  type DocumentTotals,
} from '@bp/domain';
import { renderInvoiceDraft, type DocumentLanguage } from '@bp/documents';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { decimalField, fixed, formatDateOnly, parseDateOnly } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';

export type InvoiceLineInput = {
  position: number;
  kind?: 'item' | 'shipping';
  productId?: string | null;
  description: string;
  quantity: unknown;
  unit: string;
  unitPrice: unknown;
  discountPercent?: unknown;
  taxCodeId: string;
};

export type InvoiceWrite = {
  documentType?: 'quote' | 'invoice';
  clientId: string;
  pricesIncludeTax: boolean;
  issueDate?: string | null;
  dueDate?: string | null;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  lines: InvoiceLineInput[];
};

export type InvoicePatch = {
  expectedVersion: number;
  documentType?: 'quote' | 'invoice';
  clientId?: string;
  pricesIncludeTax?: boolean;
  issueDate?: string | null;
  dueDate?: string | null;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  lines?: InvoiceLineInput[];
};

export type InvoiceQuery = {
  status?: 'draft' | 'issued' | 'cancelled';
  clientId?: string;
  from?: string;
  to?: string;
  q?: string;
};

export type InvoiceLineView = {
  id: string;
  position: number;
  kind: 'item' | 'shipping';
  productId: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxCodeId: string;
  taxCode: string;
  taxRatePercent: string;
  lineSubtotal: string;
  lineDiscount: string;
  lineNet: string;
  lineGross: string;
};

export type TaxSummaryView = {
  id: string;
  taxCodeId: string;
  taxCode: string;
  taxRatePercent: string;
  net: string;
  tax: string;
  gross: string;
};

export type InvoiceSummary = {
  id: string;
  documentType: string;
  status: string;
  clientId: string;
  clientDisplayName: string;
  currency: string;
  language: string;
  pricesIncludeTax: boolean;
  issueDate: string | null;
  dueDate: string | null;
  reference: string | null;
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceDetail = InvoiceSummary & {
  notes: string | null;
  terms: string | null;
  lines: InvoiceLineView[];
  taxSummary: TaxSummaryView[];
};

type ReadyLine = {
  position: number;
  kind: 'item' | 'shipping';
  productId: string | null;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxCodeId: string;
  taxCode: string;
  taxRatePercent: string;
};

type ClientRow = {
  id: string;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  email: string | null;
  defaultCurrency: string | null;
  defaultLanguage: string | null;
  paymentTermsDays: number | null;
  addresses: {
    kind: 'billing' | 'shipping';
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string | null;
    countryCode: string;
    isDefault: boolean;
  }[];
};

type CompanyRow = {
  legalName: string;
  tradingName: string;
  vatNumber: string | null;
  registrationNumber: string | null;
  address: unknown;
  timezone: string;
  paymentTermsDays: number;
  documentLanguage: 'en' | 'el';
  defaultCurrency: string;
};

const detailInclude = {
  client: true,
  lines: { orderBy: { position: 'asc' as const }, include: { taxCode: true } },
  taxSummary: { include: { taxCode: true } },
} as const;

@Injectable()
export class InvoiceService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async preview(
    ctx: RequestContext,
    input: { pricesIncludeTax: boolean; lines: InvoiceLineInput[] },
    meta: RequestMeta,
  ): Promise<DocumentTotals> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const lines = await this.resolveLines(tx, ctx.companyId, input.lines);
        return calculated(input.pricesIncludeTax, lines);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async list(
    ctx: RequestContext,
    query: InvoiceQuery,
    meta: RequestMeta,
  ): Promise<InvoiceSummary[]> {
    const actor = requireActor(ctx);
    try {
      return await this.listIn(ctx, actor, query);
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private async listIn(
    ctx: RequestContext,
    actor: string,
    query: InvoiceQuery,
  ): Promise<InvoiceSummary[]> {
    const from = query.from ? parseDateOnly(query.from, 'from') : undefined;
    const to = query.to ? parseDateOnly(query.to, 'to') : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new CommerceError(400, 'invalid_date', 'invoice', null, 'from is after to');
    }
    const rows = await this.tenants.run(this.context(ctx, actor), (tx) =>
      tx.invoice.findMany({
        where: {
          companyId: ctx.companyId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.clientId ? { clientId: query.clientId.toLowerCase() } : {}),
          ...(from || to
            ? { issueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
            : {}),
          ...(query.q
            ? {
                OR: [
                  { reference: { contains: query.q, mode: 'insensitive' } },
                  { notes: { contains: query.q, mode: 'insensitive' } },
                  { number: { contains: query.q, mode: 'insensitive' } },
                  { client: { displayName: { contains: query.q, mode: 'insensitive' } } },
                ],
              }
            : {}),
        },
        include: { client: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
    );
    return rows.map((row) => toSummary(row));
  }

  async get(ctx: RequestContext, invoiceId: string, meta: RequestMeta): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) =>
        toDetail(await this.load(tx, ctx.companyId, invoiceId)),
      );
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async create(
    ctx: RequestContext,
    input: InvoiceWrite,
    meta: RequestMeta,
  ): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const company = await this.company(tx, ctx.companyId);
        const client = await this.client(tx, ctx.companyId, input.clientId);
        const currency = invoiceCurrency(client.defaultCurrency ?? company.defaultCurrency, null);
        const lines = await this.resolveLines(tx, ctx.companyId, input.lines);
        const totals = calculated(input.pricesIncludeTax, lines);
        const issueDate = input.issueDate ? parseDateOnly(input.issueDate, 'issueDate') : null;
        const dueDate = this.dueDate(input.dueDate, issueDate, client, company);
        const created = await tx.invoice.create({
          data: {
            companyId: ctx.companyId,
            documentType: input.documentType ?? 'invoice',
            status: 'draft',
            clientId: client.id,
            currency,
            language: languageOf(client.defaultLanguage, company.documentLanguage),
            pricesIncludeTax: input.pricesIncludeTax,
            issueDate,
            dueDate,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            terms: input.terms ?? null,
            ...moneyFields(totals),
            createdById: actor,
          },
        });
        await this.writeLines(tx, ctx.companyId, created.id, lines, totals);
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'invoice.created',
          objectType: 'invoice',
          objectId: created.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { version: created.version, total: totals.total },
        });
        return toDetail(await this.load(tx, ctx.companyId, created.id));
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async update(
    ctx: RequestContext,
    invoiceId: string,
    patch: InvoicePatch,
    meta: RequestMeta,
  ): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const current = await this.load(tx, ctx.companyId, invoiceId);
        if (current.status !== 'draft') {
          throw new CommerceError(
            409,
            'not_draft',
            'invoice',
            current.id,
            'only drafts can be edited',
          );
        }
        if (current.version !== patch.expectedVersion) {
          throw new CommerceError(
            409,
            'version_conflict',
            'invoice',
            current.id,
            'version conflict',
          );
        }
        const company = await this.company(tx, ctx.companyId);
        const client = patch.clientId
          ? await this.client(tx, ctx.companyId, patch.clientId)
          : current.client;
        const currency = invoiceCurrency(client.defaultCurrency ?? company.defaultCurrency, current.id);
        const pricesIncludeTax = patch.pricesIncludeTax ?? current.pricesIncludeTax;
        const replaceLines = patch.lines !== undefined || patch.pricesIncludeTax !== undefined;
        const lines = patch.lines
          ? await this.resolveLines(tx, ctx.companyId, patch.lines)
          : storedLines(current.lines);
        const totals = calculated(pricesIncludeTax, lines);
        const issueDate =
          patch.issueDate === undefined
            ? current.issueDate
            : patch.issueDate
              ? parseDateOnly(patch.issueDate, 'issueDate')
              : null;
        const dueDate =
          patch.dueDate === undefined
            ? current.dueDate
            : patch.dueDate
              ? parseDateOnly(patch.dueDate, 'dueDate')
              : null;
        const written = await tx.invoice.updateMany({
          where: {
            id: current.id,
            companyId: ctx.companyId,
            version: patch.expectedVersion,
            status: 'draft',
          },
          data: {
            documentType: patch.documentType ?? current.documentType,
            clientId: client.id,
            currency,
            language: languageOf(client.defaultLanguage, company.documentLanguage),
            pricesIncludeTax,
            issueDate,
            dueDate,
            reference: patch.reference === undefined ? current.reference : patch.reference,
            notes: patch.notes === undefined ? current.notes : patch.notes,
            terms: patch.terms === undefined ? current.terms : patch.terms,
            ...(replaceLines ? moneyFields(totals) : {}),
            updatedById: actor,
            version: { increment: 1 },
          },
        });
        if (written.count !== 1) {
          throw new CommerceError(
            409,
            'version_conflict',
            'invoice',
            current.id,
            'version conflict',
          );
        }
        if (replaceLines) {
          await tx.invoiceLine.deleteMany({
            where: { companyId: ctx.companyId, invoiceId: current.id },
          });
          await tx.invoiceTaxSummary.deleteMany({
            where: { companyId: ctx.companyId, invoiceId: current.id },
          });
          await this.writeLines(tx, ctx.companyId, current.id, lines, totals);
        }
        const saved = await this.load(tx, ctx.companyId, current.id);
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'invoice.updated',
          objectType: 'invoice',
          objectId: saved.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { version: saved.version, total: fixed(saved.total, 2) },
        });
        return toDetail(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async pdf(
    ctx: RequestContext,
    invoiceId: string,
    meta: RequestMeta,
  ): Promise<{ id: string; bytes: Buffer }> {
    const actor = requireActor(ctx);
    try {
      const input = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const invoice = await this.load(tx, ctx.companyId, invoiceId);
        if (invoice.status !== 'draft') {
          throw new CommerceError(
            409,
            'not_draft',
            'invoice',
            invoice.id,
            'only drafts can be rendered',
          );
        }
        const company = await this.company(tx, ctx.companyId);
        const client = await tx.client.findFirst({
          where: { id: invoice.clientId, companyId: ctx.companyId },
          include: { addresses: true },
        });
        if (!client) {
          throw new CommerceError(404, 'client_not_found', 'client', invoice.clientId, 'Not found');
        }
        return {
          id: invoice.id,
          pdf: {
            language: languageOf(invoice.language, 'en'),
            documentType: invoice.documentType,
            currency: invoice.currency,
            pricesIncludeTax: invoice.pricesIncludeTax,
            issueDate: formatDateOnly(invoice.issueDate),
            dueDate: formatDateOnly(invoice.dueDate),
            reference: invoice.reference,
            notes: invoice.notes,
            terms: invoice.terms,
            subtotal: fixed(invoice.subtotal, 2),
            discountTotal: fixed(invoice.discountTotal, 2),
            netTotal: fixed(invoice.netTotal, 2),
            taxTotal: fixed(invoice.taxTotal, 2),
            total: fixed(invoice.total, 2),
            seller: {
              displayName: company.tradingName,
              legalName: company.legalName,
              vatNumber: company.vatNumber ?? company.registrationNumber,
              addressLines: jsonAddressLines(company.address),
            },
            client: {
              displayName: client.displayName,
              legalName: client.legalName,
              vatNumber: client.vatNumber,
              email: client.email,
              addressLines: clientAddressLines(client.addresses),
            },
            lines: invoice.lines.map((line) => ({
              description: line.description,
              quantity: fixed(line.quantity, 4),
              unit: line.unit,
              unitPrice: fixed(line.unitPrice, 4),
              discountPercent: fixed(line.discountPercent, 2),
              taxRatePercent: fixed(line.taxRatePercent, 4),
              lineNet: fixed(line.lineNet, 2),
            })),
            taxSummary: invoice.taxSummary.map((row) => ({
              code: row.taxCode.code,
              ratePercent: fixed(row.taxRatePercent, 4),
              net: fixed(row.net, 2),
              tax: fixed(row.tax, 2),
              gross: fixed(row.gross, 2),
            })),
          },
        };
      });
      return { id: input.id, bytes: await renderInvoiceDraft(input.pdf) };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  private async company(tx: TenantTransaction, companyId: string): Promise<CompanyRow> {
    const company = await tx.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new CommerceError(404, 'company_not_found', 'company', companyId, 'Not found');
    }
    return company;
  }

  private async client(
    tx: TenantTransaction,
    companyId: string,
    clientId: string,
  ): Promise<ClientRow> {
    if (!isUuid(clientId)) {
      throw new CommerceError(400, 'invalid_client', 'client', null, 'clientId is invalid');
    }
    const client = await tx.client.findFirst({
      where: { id: clientId.toLowerCase(), companyId },
      include: { addresses: true },
    });
    if (!client) {
      throw new CommerceError(
        404,
        'client_not_found',
        'client',
        clientId.toLowerCase(),
        'Not found',
      );
    }
    return client;
  }

  private async load(tx: TenantTransaction, companyId: string, invoiceId: string) {
    if (!isUuid(invoiceId)) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
    }
    const row = await tx.invoice.findFirst({
      where: { id: invoiceId.toLowerCase(), companyId },
      include: detailInclude,
    });
    if (!row) {
      throw new CommerceError(
        404,
        'invoice_not_found',
        'invoice',
        invoiceId.toLowerCase(),
        'Not found',
      );
    }
    return row;
  }

  private async resolveLines(
    tx: TenantTransaction,
    companyId: string,
    lines: InvoiceLineInput[],
  ): Promise<ReadyLine[]> {
    const taxIds = [...new Set(lines.map((line) => line.taxCodeId.toLowerCase()))];
    for (const taxCodeId of taxIds) {
      if (!isUuid(taxCodeId)) {
        throw new CommerceError(400, 'invalid_tax_code', 'tax_code', null, 'taxCodeId is invalid');
      }
    }
    const productIds = [
      ...new Set(lines.flatMap((line) => (line.productId ? [line.productId.toLowerCase()] : []))),
    ];
    for (const productId of productIds) {
      if (!isUuid(productId)) {
        throw new CommerceError(400, 'invalid_product', 'product', null, 'productId is invalid');
      }
    }
    const taxCodes = await tx.taxCode.findMany({ where: { companyId, id: { in: taxIds } } });
    const products = await tx.product.findMany({
      where: { companyId, id: { in: productIds } },
      select: { id: true },
    });
    const taxById = new Map(taxCodes.map((code) => [code.id, code]));
    const productIdsFound = new Set(products.map((product) => product.id));
    return lines.map((line) => {
      const tax = taxById.get(line.taxCodeId.toLowerCase());
      if (!tax) {
        throw new CommerceError(
          404,
          'tax_code_not_found',
          'tax_code',
          line.taxCodeId.toLowerCase(),
          'Not found',
        );
      }
      if (!tax.active) {
        throw new CommerceError(
          400,
          'tax_code_inactive',
          'tax_code',
          tax.id,
          'tax code is not active',
        );
      }
      const productId = line.productId ? line.productId.toLowerCase() : null;
      if (productId && !productIdsFound.has(productId)) {
        throw new CommerceError(404, 'product_not_found', 'product', productId, 'Not found');
      }
      return {
        position: line.position,
        kind: line.kind ?? 'item',
        productId,
        description: line.description,
        quantity: decimalField(line.quantity, 4, 'quantity'),
        unit: line.unit,
        unitPrice: decimalField(line.unitPrice, 4, 'unitPrice'),
        discountPercent: decimalField(line.discountPercent ?? '0', 2, 'discountPercent'),
        taxCodeId: tax.id,
        taxCode: tax.code,
        taxRatePercent: fixed(tax.ratePercent, 4),
      };
    });
  }

  private dueDate(
    requested: string | null | undefined,
    issueDate: Date | null,
    client: ClientRow,
    company: CompanyRow,
  ): Date | null {
    if (requested === null) {
      return null;
    }
    if (requested) {
      return parseDateOnly(requested, 'dueDate');
    }
    const anchor = formatDateOnly(issueDate) ?? businessDateInZone(new Date(), company.timezone);
    const terms = client.paymentTermsDays ?? company.paymentTermsDays;
    if (!Number.isInteger(terms) || terms < 0) {
      throw new CommerceError(400, 'invalid_terms', 'invoice', null, 'payment terms are invalid');
    }
    return parseDateOnly(addDaysToBusinessDate(anchor, terms), 'dueDate');
  }

  private async writeLines(
    tx: TenantTransaction,
    companyId: string,
    invoiceId: string,
    lines: ReadyLine[],
    totals: DocumentTotals,
  ): Promise<void> {
    const byPosition = new Map(totals.lines.map((line) => [line.position, line]));
    await tx.invoiceLine.createMany({
      data: lines.map((line) => {
        const amounts = byPosition.get(line.position);
        if (!amounts) {
          throw new CommerceError(
            400,
            'line_totals_missing',
            'invoice',
            null,
            'line totals are missing',
          );
        }
        return {
          companyId,
          invoiceId,
          position: line.position,
          kind: line.kind,
          productId: line.productId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent,
          taxCodeId: line.taxCodeId,
          taxRatePercent: line.taxRatePercent,
          lineSubtotal: amounts.lineSubtotal,
          lineDiscount: amounts.lineDiscount,
          lineNet: amounts.lineNet,
          lineGross: amounts.lineGross,
        };
      }),
    });
    const rateByCode = new Map(lines.map((line) => [line.taxCode, line]));
    await tx.invoiceTaxSummary.createMany({
      data: totals.taxSummary.map((group) => {
        const line = rateByCode.get(group.taxCode);
        if (!line) {
          throw new CommerceError(
            400,
            'tax_summary_missing',
            'invoice',
            null,
            'tax summary is missing a code',
          );
        }
        return {
          companyId,
          invoiceId,
          taxCodeId: line.taxCodeId,
          taxRatePercent: line.taxRatePercent,
          net: group.net,
          tax: group.tax,
          gross: group.gross,
        };
      }),
    });
  }

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function invoiceCurrency(currency: string, invoiceId: string | null): string {
  const code = currency.trim().toUpperCase();
  if (currencyMinorDigits(code) !== 2) {
    throw new CommerceError(
      400,
      'currency_precision',
      'invoice',
      invoiceId,
      'currency precision must be 2 digits',
    );
  }
  return code;
}

function calculated(pricesIncludeTax: boolean, lines: ReadyLine[]): DocumentTotals {
  try {
    return calculateDocumentTotals({
      pricesIncludeTax,
      lines: lines.map((line) => ({
        position: line.position,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxCode: line.taxCode,
        taxRatePercent: line.taxRatePercent,
      })),
    });
  } catch (error) {
    if (error instanceof DocumentValidationError) {
      throw new CommerceError(400, error.code, 'invoice', null, error.message);
    }
    throw error;
  }
}

function moneyFields(totals: DocumentTotals) {
  return {
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    netTotal: totals.netTotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
  };
}

function languageOf(preferred: string | null, fallback: 'en' | 'el'): DocumentLanguage {
  if (preferred === 'el' || preferred === 'en') {
    return preferred;
  }
  return fallback;
}

function storedLines(
  lines: {
    position: number;
    kind: 'item' | 'shipping';
    productId: string | null;
    description: string;
    quantity: { toFixed(digits: number): string };
    unit: string;
    unitPrice: { toFixed(digits: number): string };
    discountPercent: { toFixed(digits: number): string };
    taxCodeId: string;
    taxRatePercent: { toFixed(digits: number): string };
    taxCode: { code: string };
  }[],
): ReadyLine[] {
  return lines.map((line) => ({
    position: line.position,
    kind: line.kind,
    productId: line.productId,
    description: line.description,
    quantity: fixed(line.quantity, 4),
    unit: line.unit,
    unitPrice: fixed(line.unitPrice, 4),
    discountPercent: fixed(line.discountPercent, 2),
    taxCodeId: line.taxCodeId,
    taxCode: line.taxCode.code,
    taxRatePercent: fixed(line.taxRatePercent, 4),
  }));
}

function toSummary(row: {
  id: string;
  documentType: string;
  status: string;
  clientId: string;
  client: { displayName: string };
  currency: string;
  language: string;
  pricesIncludeTax: boolean;
  issueDate: Date | null;
  dueDate: Date | null;
  reference: string | null;
  subtotal: { toFixed(digits: number): string };
  discountTotal: { toFixed(digits: number): string };
  netTotal: { toFixed(digits: number): string };
  taxTotal: { toFixed(digits: number): string };
  total: { toFixed(digits: number): string };
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): InvoiceSummary {
  return {
    id: row.id,
    documentType: row.documentType,
    status: row.status,
    clientId: row.clientId,
    clientDisplayName: row.client.displayName,
    currency: row.currency,
    language: row.language,
    pricesIncludeTax: row.pricesIncludeTax,
    issueDate: formatDateOnly(row.issueDate),
    dueDate: formatDateOnly(row.dueDate),
    reference: row.reference,
    subtotal: fixed(row.subtotal, 2),
    discountTotal: fixed(row.discountTotal, 2),
    netTotal: fixed(row.netTotal, 2),
    taxTotal: fixed(row.taxTotal, 2),
    total: fixed(row.total, 2),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(
  row: Parameters<typeof toSummary>[0] & {
    notes: string | null;
    terms: string | null;
    lines: (Parameters<typeof storedLines>[0][number] & {
      id: string;
      lineSubtotal: { toFixed(digits: number): string };
      lineDiscount: { toFixed(digits: number): string };
      lineNet: { toFixed(digits: number): string };
      lineGross: { toFixed(digits: number): string };
    })[];
    taxSummary: {
      id: string;
      taxCodeId: string;
      taxRatePercent: { toFixed(digits: number): string };
      net: { toFixed(digits: number): string };
      tax: { toFixed(digits: number): string };
      gross: { toFixed(digits: number): string };
      taxCode: { code: string };
    }[];
  },
): InvoiceDetail {
  return {
    ...toSummary(row),
    notes: row.notes,
    terms: row.terms,
    lines: row.lines.map((line) => ({
      id: line.id,
      position: line.position,
      kind: line.kind,
      productId: line.productId,
      description: line.description,
      quantity: fixed(line.quantity, 4),
      unit: line.unit,
      unitPrice: fixed(line.unitPrice, 4),
      discountPercent: fixed(line.discountPercent, 2),
      taxCodeId: line.taxCodeId,
      taxCode: line.taxCode.code,
      taxRatePercent: fixed(line.taxRatePercent, 4),
      lineSubtotal: fixed(line.lineSubtotal, 2),
      lineDiscount: fixed(line.lineDiscount, 2),
      lineNet: fixed(line.lineNet, 2),
      lineGross: fixed(line.lineGross, 2),
    })),
    taxSummary: [...row.taxSummary]
      .sort((left, right) => left.taxCode.code.localeCompare(right.taxCode.code))
      .map((entry) => ({
        id: entry.id,
        taxCodeId: entry.taxCodeId,
        taxCode: entry.taxCode.code,
        taxRatePercent: fixed(entry.taxRatePercent, 4),
        net: fixed(entry.net, 2),
        tax: fixed(entry.tax, 2),
        gross: fixed(entry.gross, 2),
      })),
  };
}

function jsonAddressLines(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  return ['line1', 'line2', 'city', 'region', 'postalCode', 'countryCode'].flatMap((key) => {
    const line = record[key];
    return typeof line === 'string' && line.length > 0 ? [line] : [];
  });
}

function clientAddressLines(
  addresses: {
    kind: string;
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string | null;
    countryCode: string;
    isDefault: boolean;
  }[],
): string[] {
  const billing = addresses.filter((address) => address.kind === 'billing');
  const chosen = billing.find((address) => address.isDefault) ?? billing[0] ?? addresses[0];
  if (!chosen) {
    return [];
  }
  return [
    chosen.line1,
    chosen.line2,
    chosen.city,
    chosen.region,
    chosen.postalCode,
    chosen.countryCode,
  ].flatMap((line) => (line ? [line] : []));
}
