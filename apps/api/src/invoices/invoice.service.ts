import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, TenantDb, type TenantTransaction } from '@bp/db';
import {
  addDaysToBusinessDate,
  allocationEffectiveOn,
  businessDateInZone,
  calculateDocumentTotals,
  currencyMinorDigits,
  deliveryDeadline,
  DocumentValidationError,
  openBalance,
  parseAmount,
  printedUnitAmount,
  sourceRemaining,
  vatExclusiveUnitPrice,
  type DeliveryDeadlineRule,
  type DocumentTotals,
  type InvoicePaymentState,
} from '@bp/domain';
import {
  ISSUED_RENDER_VERSION,
  renderInvoiceDraft,
  renderIssuedInvoice,
  type DocumentLanguage,
  type IssuedInvoicePdfInput,
} from '@bp/documents';
import { SIMULATED_PRINTING_LABEL, storageKey, type StorageAdapter } from '@bp/integrations';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { decimalField, fixed, formatDateOnly, parseDateOnly } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { uuidv7 } from '../correlation/correlation';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { datedAllocation, datedRefund, day, invoiceBalance } from '../payments/settlement';
import { integrityFailed, isStorageMiss } from '../storage/file-errors';
import { STORAGE } from '../storage/storage.module';
import { FileIntegrityError, readVerifiedFile } from '../storage/verified-file';
import { creditTotals } from './credit-totals';
import { issueProblems } from './issue-validation';

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
  /** Time of supply. Empty means the issue date. */
  supplyDate?: string | null;
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
  supplyDate?: string | null;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  lines?: InvoiceLineInput[];
};

export type InvoiceQuery = {
  status?: 'draft' | 'issued' | 'cancelled';
  /** `pending`: issued documents with no delivery recorded yet, earliest deadline first. */
  delivery?: 'pending';
  payment?: 'open';
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
  /** On a credit note: the original line it credits. */
  creditedLineId: string | null;
  /** On an issued invoice: the quantity issued credit notes have credited so far. */
  creditedQuantity: string;
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
  supplyDate: string | null;
  deliveryDeadline: string | null;
  number: string | null;
  issuedAt: string | null;
  /** The latest recorded delivery date, or null when none is recorded. */
  lastDeliveredOn: string | null;
  reference: string | null;
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
  openBalance: string | null;
  paymentState: InvoicePaymentState | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type InvoiceDetail = InvoiceSummary & {
  unappliedAmount: string | null;
  allocations: InvoiceAllocation[];
  notes: string | null;
  terms: string | null;
  lines: InvoiceLineView[];
  taxSummary: TaxSummaryView[];
  deliveries: DeliveryView[];
  /** Print jobs of an issued document, newest first (the latest 20): the history. */
  printJobs: InvoicePrintJob[];
  /** The first print that still counts, however old: another first print is refused; a reprint refers to it. */
  firstPrintJobId: string | null;
  /** A credit note: the invoice it credits, and why. */
  creditedInvoice: { id: string; number: string | null; issueDate: string | null } | null;
  creditReason: string | null;
  /** An invoice: the credit notes made against it, drafts included. */
  creditNotes: {
    id: string;
    number: string | null;
    status: string;
    total: string;
    issueDate: string | null;
  }[];
  /** An invoice converted from a quote, or a quote's converted invoice. */
  sourceQuoteId: string | null;
  convertedInvoiceId: string | null;
};

type InvoiceAllocation = {
  id: string;
  amount: string;
  effectiveOn: string;
  reversedOn: string | null;
  reversalReason: string | null;
} & (
  | {
      source:
        | { type: 'payment'; id: string; receivedOn: string; reference: string | null }
        | { type: 'credit_note'; id: string; number: string | null };
    }
  | { invoice: { id: string; number: string | null } }
);

type DetailExtras = {
  balance?: ReturnType<typeof invoiceBalance>;
  unappliedAmount?: string | null;
  allocations?: InvoiceAllocation[];
  printJobs?: InvoicePrintJob[];
  firstPrintJobId?: string | null;
  /** Per original line id: the quantity issued credit notes credited. */
  creditedQuantities?: ReadonlyMap<string, string>;
};

export type InvoicePrintJob = {
  id: string;
  status: string;
  isReprint: boolean;
  copies: number;
  createdAt: string;
  /** Set for the mock provider: nothing is printed for real. */
  simulationLabel: string | null;
};

export type DeliveryMethod = 'handed_over' | 'posted' | 'emailed_outside_platform' | 'other';

export type DeliveryInput = {
  method: DeliveryMethod;
  deliveredOn: string;
  paperCopyKept?: boolean;
  note?: string | null;
};

export type DeliveryView = {
  id: string;
  method: DeliveryMethod;
  deliveredOn: string;
  paperCopyKept: boolean;
  note: string | null;
  recordedById: string;
  createdAt: string;
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
  countryCode: string;
  vatNumber: string | null;
  registrationNumber: string | null;
  taxOffice: string | null;
  address: unknown;
  timezone: string;
  paymentTermsDays: number;
  documentLanguage: 'en' | 'el';
  defaultCurrency: string;
  invoiceTermsEn: string | null;
  invoiceTermsEl: string | null;
  defaultInvoiceSeriesId: string | null;
  defaultCreditNoteSeriesId: string | null;
};

/** Test seams. Production leaves `hooks` null. */
export type IssueHooks = {
  /** After the number is allocated and before the PDF is rendered and stored. */
  afterNumberAllocated?: () => Promise<void>;
};

export type IssueResult = {
  invoice: InvoiceDetail;
  /** `delivery_deadline_passed`: issued late. Never a refusal (invoice-requirements.md, section 2). */
  warnings: string[];
};

/** What a printed document shows of a tax code. */
type TaxInfo = {
  code: string;
  name: string;
  kind: string;
  noteEn: string | null;
  noteEl: string | null;
};

type TaxCodeLock = {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
  kind: string;
  noteEn: string | null;
  noteEl: string | null;
  active: boolean;
  deadlineRule: DeliveryDeadlineRule;
};

type AddressSnapshot = {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string | null;
};

type SellerSnapshot = {
  legalName: string;
  tradingName: string;
  vatNumber: string | null;
  registrationNumber: string | null;
  taxOffice: string | null;
  address: AddressSnapshot;
  addressLines: string[];
};

type BuyerSnapshot = {
  clientId: string;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxId: string | null;
  email: string | null;
  address: AddressSnapshot | null;
  addressLines: string[];
};

type BankSnapshot = {
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string | null;
};

type TaxSnapshot = {
  code: string;
  name: string;
  kind: string;
  ratePercent: string;
  noteEn: string | null;
  noteEl: string | null;
  deadlineRule: DeliveryDeadlineRule;
};

const ISSUED_KIND = 'invoice_pdf';
const CREDIT_ISSUED = 'credit_note.issued';
/** Kinds whose legal note the issued PDF prints. */
const NOTED_KINDS = new Set(['exempt', 'reverse_charge', 'zero', 'out_of_scope']);

const detailInclude = {
  client: true,
  lines: { orderBy: { position: 'asc' as const }, include: { taxCode: true } },
  taxSummary: { include: { taxCode: true } },
  deliveries: { orderBy: { createdAt: 'asc' as const } },
  creditedInvoice: { select: { id: true, number: true, issueDate: true } },
  creditNotes: {
    orderBy: { createdAt: 'asc' as const },
    select: { id: true, number: true, status: true, total: true, issueDate: true },
  },
  convertedInvoices: { select: { id: true } },
} as const;

/** Paper deliveries keep the company's printed copy (reg. 11Γ(4)). */
const PAPER_METHODS = new Set<DeliveryMethod>(['handed_over', 'posted']);

@Injectable()
export class InvoiceService {
  private readonly tenants: TenantDb;
  /** Test seam. Production leaves it null. */
  hooks: IssueHooks | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
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
    const rows = await this.tenants.run(
      this.context(ctx, actor),
      (tx) =>
        tx.invoice.findMany({
          where: {
            companyId: ctx.companyId,
            ...(query.status ? { status: query.status } : {}),
            ...(query.delivery === 'pending'
              ? { status: 'issued' as const, deliveries: { none: {} } }
              : {}),
            ...(query.payment === 'open'
              ? { status: 'issued' as const, documentType: 'invoice' as const }
              : {}),
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
          include: {
            client: true,
            allocations: { select: { amount: true, effectiveOn: true, reversedOn: true } },
            deliveries: {
              select: { deliveredOn: true },
              orderBy: { deliveredOn: 'desc' },
              take: 1,
            },
          },
          orderBy:
            query.payment === 'open'
              ? [{ dueDate: 'asc' }, { id: 'asc' }]
              : query.delivery === 'pending'
                ? [{ deliveryDeadline: 'asc' }, { id: 'asc' }]
                : [{ updatedAt: 'desc' }, { id: 'desc' }],
        }),
      { isolation: 'repeatable_read' },
    );
    return rows
      .map((row) => toSummary(row, invoiceBalance(row, row.allocations)))
      .filter(
        (row) =>
          query.payment !== 'open' ||
          (row.openBalance !== null && parseAmount(row.openBalance, 2).gt('0')),
      );
  }

  async get(ctx: RequestContext, invoiceId: string, meta: RequestMeta): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(
        this.context(ctx, actor),
        async (tx) => this.detail(tx, ctx.companyId, invoiceId),
        { isolation: 'repeatable_read' },
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
        const company = await this.company(tx, ctx.companyId, { lock: true });
        const client = await this.client(tx, ctx.companyId, input.clientId);
        const currency = draftCurrency(company, client, null);
        const lines = await this.resolveLines(tx, ctx.companyId, input.lines);
        const totals = calculated(input.pricesIncludeTax, lines);
        const issueDate = input.issueDate ? parseDateOnly(input.issueDate, 'issueDate') : null;
        const dueDate = this.dueDate(input.dueDate, issueDate, client, company);
        const supplyDate = input.supplyDate ? parseDateOnly(input.supplyDate, 'supplyDate') : null;
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
            supplyDate,
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
        return this.detail(tx, ctx.companyId, created.id);
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
        if (current.documentType === 'credit_note') {
          throw new CommerceError(
            409,
            'credit_note_draft',
            'invoice',
            current.id,
            'Credit-note drafts are edited through the credit-note routes.',
            'invoice.updated',
          );
        }
        if (patch.documentType !== undefined && patch.documentType !== current.documentType) {
          throw new CommerceError(
            409,
            'document_type_locked',
            'invoice',
            current.id,
            'A draft keeps its document type. Create a new draft instead.',
            'invoice.updated',
          );
        }
        // Lock order: company, then tax codes (resolveLines), then the invoice row (updateMany).
        const company = await this.company(tx, ctx.companyId, { lock: true });
        const client = patch.clientId
          ? await this.client(tx, ctx.companyId, patch.clientId)
          : current.client;
        const currency = draftCurrency(company, client, current.id);
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
        const supplyDate =
          patch.supplyDate === undefined
            ? current.supplyDate
            : patch.supplyDate
              ? parseDateOnly(patch.supplyDate, 'supplyDate')
              : null;
        const written = await tx.invoice.updateMany({
          where: {
            id: current.id,
            companyId: ctx.companyId,
            version: patch.expectedVersion,
            status: 'draft',
          },
          data: {
            clientId: client.id,
            currency,
            language: languageOf(client.defaultLanguage, company.documentLanguage),
            pricesIncludeTax,
            issueDate,
            dueDate,
            supplyDate,
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

  /**
   * Issues a draft invoice: one transaction, locks in the plan's order (company, switches,
   * tax codes, invoice, series). The number, the frozen snapshot and the sealed PDF commit
   * together, so a rollback consumes no number.
   */
  async issue(
    ctx: RequestContext,
    invoiceId: string,
    input: { expectedVersion: number },
    meta: RequestMeta,
  ): Promise<IssueResult> {
    const actor = requireActor(ctx);
    try {
      // Issues queue on the series lock while each renders its PDF, so allow for the queue.
      return await this.tenants.run(
        this.context(ctx, actor),
        (tx) => this.issueIn(tx, ctx, actor, invoiceId, input.expectedVersion, meta),
        { timeoutMs: 30_000, maxWaitMs: 15_000 },
      );
    } catch (error) {
      return this.fail(ctx, meta, numberTakenOr(error, invoiceId));
    }
  }

  private async issueIn(
    tx: TenantTransaction,
    ctx: RequestContext,
    actor: string,
    invoiceId: string,
    expectedVersion: number,
    meta: RequestMeta,
  ): Promise<IssueResult> {
    if (!isUuid(invoiceId)) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
    }
    const id = invoiceId.toLowerCase();
    const companyId = ctx.companyId;
    // Another company's id is 404 before anything else answers. This read takes no lock.
    const visible = await tx.invoice.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!visible) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
    }
    // 1. The company, so its currency and settings hold until commit.
    const company = await this.company(tx, companyId, { lock: true });
    // 2. The switches, checked at execution time.
    await requireIssuance(tx, companyId, id);
    // 3. The tax codes the draft uses, by id. They are read before the invoice is locked,
    //    then checked against the locked draft below.
    const usedCodes = await tx.invoiceLine.findMany({
      where: { companyId, invoiceId: id },
      select: { taxCodeId: true },
      distinct: ['taxCodeId'],
    });
    const taxCodes = await lockTaxCodes(
      tx,
      companyId,
      usedCodes.map((line) => line.taxCodeId),
    );
    // 4. The invoice.
    const lockedRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM invoice
      WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid
      FOR UPDATE
    `;
    if (lockedRows.length === 0) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
    }
    const current = await this.load(tx, companyId, id);
    if (current.status !== 'draft') {
      throw new CommerceError(
        409,
        'not_draft',
        'invoice',
        id,
        'Only a draft can be issued.',
        'invoice.issue',
      );
    }
    if (current.documentType === 'credit_note') {
      throw new CommerceError(
        409,
        'credit_note_draft',
        'invoice',
        id,
        'Credit notes are issued through the credit-note routes.',
        'invoice.issue',
      );
    }
    if (current.documentType !== 'invoice') {
      throw new CommerceError(
        409,
        'not_issuable',
        'invoice',
        id,
        'A quote is not issued.',
        'invoice.issue',
      );
    }
    if (current.version !== expectedVersion) {
      throw new CommerceError(
        409,
        'version_conflict',
        'invoice',
        id,
        'version conflict',
        'invoice.issue',
      );
    }
    const taxById = new Map(taxCodes.map((code) => [code.id, code]));
    if (current.lines.some((line) => !taxById.has(line.taxCodeId))) {
      throw new CommerceError(
        409,
        'version_conflict',
        'invoice',
        id,
        'version conflict',
        'invoice.issue',
      );
    }
    if (current.currency !== 'EUR' || company.defaultCurrency.trim().toUpperCase() !== 'EUR') {
      throw new CommerceError(
        422,
        'currency_not_supported',
        'invoice',
        id,
        'Documents are issued in EUR only, by a company whose currency is EUR.',
        'invoice.issue',
      );
    }
    for (const line of current.lines) {
      const code = taxById.get(line.taxCodeId);
      if (
        !code ||
        fixed(line.taxRatePercent, 4) !== decimalField(code.ratePercent, 4, 'taxRatePercent')
      ) {
        // A code's rate is locked while any line uses it (R2-B), so this should never happen.
        throw new CommerceError(
          409,
          'tax_code_changed',
          'invoice',
          id,
          `Line ${String(line.position)} has a VAT rate its tax code no longer has. Save the draft again.`,
          'invoice.issue',
        );
      }
    }
    const client = await tx.client.findFirst({
      where: { id: current.clientId, companyId },
      include: { addresses: true },
    });
    if (!client) {
      throw new CommerceError(404, 'client_not_found', 'client', current.clientId, 'Not found');
    }
    const bank = await tx.companyBankAccount.findFirst({
      where: { companyId, shownOnInvoices: true, active: true },
    });
    // No lines is reported by the validation below as `lines`, not as a calculation error.
    const totals =
      current.lines.length > 0
        ? calculated(current.pricesIncludeTax, storedLines(current.lines))
        : null;
    // 6. The series, last. The clock is read only after it is locked, so a higher number
    //    never carries an earlier date, and every date below comes from this one instant.
    const seriesId = company.defaultInvoiceSeriesId;
    const series = seriesId ? await lockSeries(tx, companyId, seriesId) : null;
    const issuedAt = new Date();
    const issueDate = businessDateInZone(issuedAt, company.timezone);
    const supplyDate = formatDateOnly(current.supplyDate) ?? issueDate;
    const termsDays = client.paymentTermsDays ?? company.paymentTermsDays;
    if (!Number.isInteger(termsDays) || termsDays < 0) {
      throw new CommerceError(400, 'invalid_terms', 'invoice', id, 'payment terms are invalid');
    }
    const dueDate = addDaysToBusinessDate(issueDate, termsDays);
    const seller = sellerSnapshot(company);
    const buyer = buyerSnapshot(client);
    const problems = issueProblems({
      seller: { legalName: seller.legalName, vatNumber: seller.vatNumber, address: seller.address },
      buyer: { vatNumber: buyer.vatNumber, address: buyer.address },
      lines: current.lines.map((line) => {
        const code = taxById.get(line.taxCodeId);
        return {
          position: line.position,
          description: line.description,
          kind: code?.kind ?? 'standard',
          noteEn: code?.noteEn ?? null,
          noteEl: code?.noteEl ?? null,
          taxCodeActive: code?.active ?? false,
        };
      }),
      total: totals?.total ?? '0.00',
      supplyDate,
      issueDate,
      seriesId,
    });
    if (problems.length > 0 || !totals) {
      throw new CommerceError(
        422,
        'invoice_incomplete',
        'invoice',
        id,
        'The invoice is missing details it must show.',
        'invoice.issue',
        { fields: problems },
      );
    }
    const deadline = deliveryDeadline(
      supplyDate,
      current.lines.map((line) => (taxById.get(line.taxCodeId) as TaxCodeLock).deadlineRule),
    );
    if (!series || !series.active || series.documentType !== 'invoice') {
      throw new CommerceError(
        422,
        'series_unavailable',
        'invoice_series',
        seriesId,
        'The default invoice series is not an active invoice series.',
        'invoice.issue',
      );
    }
    const { number, numberSeq } = await this.takeNumber(tx, companyId, series, id, 'invoice.issue');

    // Freeze the tax codes on the lines and the summary while the document is still a draft;
    // the immutability trigger refuses any change to them once it is issued.
    const amounts = new Map(totals.lines.map((line) => [line.position, line]));
    for (const line of current.lines) {
      const computed = amounts.get(line.position);
      if (!computed) {
        throw new CommerceError(
          400,
          'line_totals_missing',
          'invoice',
          id,
          'line totals are missing',
        );
      }
      await tx.invoiceLine.update({
        where: { id: line.id },
        data: {
          lineSubtotal: computed.lineSubtotal,
          lineDiscount: computed.lineDiscount,
          lineNet: computed.lineNet,
          lineGross: computed.lineGross,
          taxSnapshot: taxSnapshot(taxById.get(line.taxCodeId) as TaxCodeLock),
        },
      });
    }
    await tx.invoiceTaxSummary.deleteMany({ where: { companyId, invoiceId: id } });
    const codeByKey = new Map(taxCodes.map((code) => [code.code, code]));
    await tx.invoiceTaxSummary.createMany({
      data: totals.taxSummary.map((group) => {
        const code = codeByKey.get(group.taxCode);
        if (!code) {
          throw new CommerceError(
            400,
            'tax_summary_missing',
            'invoice',
            id,
            'tax summary is missing a code',
          );
        }
        return {
          companyId,
          invoiceId: id,
          taxCodeId: code.id,
          taxRatePercent: decimalField(code.ratePercent, 4, 'taxRatePercent'),
          net: group.net,
          tax: group.tax,
          gross: group.gross,
          taxSnapshot: taxSnapshot(code),
        };
      }),
    });

    const language = languageOf(current.language, company.documentLanguage);
    const bankCopy: BankSnapshot | null = bank
      ? {
          bankName: bank.bankName,
          accountHolder: bank.accountHolder,
          iban: bank.iban,
          bic: bank.bic,
        }
      : null;
    const terms = present(current.terms)
      ? current.terms
      : ((language === 'el' ? company.invoiceTermsEl : company.invoiceTermsEn) ?? null);
    const pdf = await renderIssuedInvoice(
      issuedPdfInput({
        language,
        number,
        issueDate,
        supplyDate,
        dueDate,
        current,
        totals,
        seller,
        buyer,
        bank: bankCopy,
        terms,
        codeByKey,
      }),
    );
    const fileId = await this.sealPdf(tx, {
      companyId,
      documentId: id,
      sourceVersion: current.version + 1,
      actor,
      issuedAt,
      pdf,
    });
    const written = await tx.invoice.updateMany({
      where: { id, companyId, status: 'draft', version: expectedVersion },
      data: {
        status: 'issued',
        issueDate: parseDateOnly(issueDate, 'issueDate'),
        dueDate: parseDateOnly(dueDate, 'dueDate'),
        supplyDate: parseDateOnly(supplyDate, 'supplyDate'),
        deliveryDeadline: parseDateOnly(deadline, 'deliveryDeadline'),
        seriesId: series.id,
        number,
        numberSeq,
        ...moneyFields(totals),
        sellerSnapshot: seller,
        buyerSnapshot: buyer,
        ...(bankCopy ? { bankSnapshot: bankCopy } : {}),
        termsSnapshot: terms,
        renderVersion: ISSUED_RENDER_VERSION,
        pdfFileId: fileId,
        issuedAt,
        issuedById: actor,
        updatedById: actor,
        version: { increment: 1 },
      },
    });
    if (written.count !== 1) {
      throw new CommerceError(
        409,
        'version_conflict',
        'invoice',
        id,
        'version conflict',
        'invoice.issue',
      );
    }
    const late = deadline < issueDate;
    await this.audit.record(tx, {
      companyId,
      actorType: 'user',
      actorId: actor,
      actorLabel: ctx.actorLabel,
      action: 'invoice.issued',
      objectType: 'invoice',
      objectId: id,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        number,
        total: totals.total,
        version: current.version + 1,
        pdfFileId: fileId,
        ...(late ? { late: true } : {}),
      },
    });
    return {
      invoice: await this.detail(tx, companyId, id),
      warnings: late ? ['delivery_deadline_passed'] : [],
    };
  }

  /**
   * Issues a draft credit note (R2-D): R2-C with the company's credit-note series. With the
   * credit note and its original locked together, its amounts are worked out again against
   * what issued credit notes have credited, and each line must still be the line it credits.
   * The buyer and the tax treatment are the original's, as frozen when it was issued.
   */
  async issueCreditNote(
    ctx: RequestContext,
    creditNoteId: string,
    input: { expectedVersion: number },
    meta: RequestMeta,
  ): Promise<IssueResult> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(
        this.context(ctx, actor),
        (tx) => this.issueCreditIn(tx, ctx, actor, creditNoteId, input.expectedVersion, meta),
        { timeoutMs: 30_000, maxWaitMs: 15_000 },
      );
    } catch (error) {
      return this.fail(ctx, meta, numberTakenOr(error, creditNoteId, CREDIT_ISSUED));
    }
  }

  private async issueCreditIn(
    tx: TenantTransaction,
    ctx: RequestContext,
    actor: string,
    creditNoteId: string,
    expectedVersion: number,
    meta: RequestMeta,
  ): Promise<IssueResult> {
    if (!isUuid(creditNoteId)) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
    }
    const id = creditNoteId.toLowerCase();
    const companyId = ctx.companyId;
    // Another company's id, or a document that is not a credit note, is 404 first. No lock.
    const visible = await tx.invoice.findFirst({
      where: { id, companyId, documentType: 'credit_note' },
      select: { creditedInvoiceId: true },
    });
    const originalId = visible?.creditedInvoiceId;
    if (!originalId) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
    }
    // 1. The company and 2. the switches, at execution time.
    const company = await this.company(tx, companyId, { lock: true });
    await requireIssuance(tx, companyId, id, CREDIT_ISSUED);
    // 3. The credit note and its original, in one statement ordered by id. Another credit of
    //    the same invoice waits here, and then counts this one as issued.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM invoice
      WHERE company_id = ${companyId}::uuid AND id IN (${id}::uuid, ${originalId}::uuid)
      ORDER BY id
      FOR UPDATE
    `;
    if (locked.length !== 2) {
      throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
    }
    const current = await this.load(tx, companyId, id);
    if (current.status !== 'draft') {
      throw new CommerceError(
        409,
        'not_draft',
        'invoice',
        id,
        'Only a draft can be issued.',
        CREDIT_ISSUED,
      );
    }
    if (current.version !== expectedVersion) {
      throw new CommerceError(
        409,
        'version_conflict',
        'invoice',
        id,
        'version conflict',
        CREDIT_ISSUED,
      );
    }
    const original = await tx.invoice.findFirst({
      where: { id: originalId, companyId },
      include: { lines: { orderBy: { position: 'asc' } }, taxSummary: true },
    });
    if (!original || original.documentType !== 'invoice' || original.status !== 'issued') {
      // invoice_credit_guard allows nothing else, and an issued invoice never changes.
      throw new CommerceError(
        409,
        'not_creditable',
        'invoice',
        id,
        'Only an issued invoice is credited.',
        CREDIT_ISSUED,
      );
    }
    if (current.currency !== 'EUR' || company.defaultCurrency.trim().toUpperCase() !== 'EUR') {
      throw new CommerceError(
        422,
        'currency_not_supported',
        'invoice',
        id,
        'Documents are issued in EUR only, by a company whose currency is EUR.',
        CREDIT_ISSUED,
      );
    }
    // 4. Each line is still a copy of the line it credits, and the amounts are worked out
    //    again: issued credit notes may have credited more since this draft was saved.
    const sources = new Map(original.lines.map((line) => [line.id, line]));
    const sourceOf = (line: { position: number; creditedLineId: string | null }) => {
      const source = line.creditedLineId ? sources.get(line.creditedLineId) : undefined;
      if (!source) {
        throw new CommerceError(
          409,
          'credit_changed',
          'invoice',
          id,
          `Line ${String(line.position)} no longer credits a line of the invoice.`,
          CREDIT_ISSUED,
        );
      }
      return source;
    };
    for (const line of current.lines) {
      if (!copiesSource(line, sourceOf(line))) {
        throw new CommerceError(
          409,
          'credit_changed',
          'invoice',
          id,
          `Line ${String(line.position)} no longer matches the invoice line it credits.`,
          CREDIT_ISSUED,
        );
      }
    }
    const before = await creditedQuantitiesOf(tx, companyId, original.id);
    const totals = creditTotals(
      original,
      before,
      current.lines.map((line) => ({
        position: line.position,
        sourceKey: sourceOf(line).id,
        quantity: fixed(line.quantity, 4),
      })),
      { action: CREDIT_ISSUED, objectId: id },
    );
    // The original's frozen tax treatment goes on every line and summary row.
    const amounts = new Map(totals.lines.map((line) => [line.position, line]));
    const lineTax = new Map<string, TaxSnapshot>();
    for (const line of current.lines) {
      const source = sourceOf(line);
      const computed = amounts.get(line.position);
      if (!computed) {
        throw new Error('credit line totals are missing');
      }
      lineTax.set(line.id, frozenTax(source.taxSnapshot));
      await tx.invoiceLine.update({
        where: { id: line.id },
        data: {
          lineSubtotal: computed.lineSubtotal,
          lineDiscount: computed.lineDiscount,
          lineNet: computed.lineNet,
          lineGross: computed.lineGross,
          taxSnapshot: source.taxSnapshot as Prisma.InputJsonValue,
        },
      });
    }
    const originalGroups = new Map(original.taxSummary.map((row) => [row.taxCodeId, row]));
    await tx.invoiceTaxSummary.deleteMany({ where: { companyId, invoiceId: id } });
    await tx.invoiceTaxSummary.createMany({
      data: totals.taxSummary.map((group) => {
        const frozen = originalGroups.get(group.taxCode);
        if (!frozen) {
          throw new Error('a credit tax group has no group on the original');
        }
        return {
          companyId,
          invoiceId: id,
          taxCodeId: frozen.taxCodeId,
          taxRatePercent: fixed(frozen.taxRatePercent, 4),
          net: group.net,
          tax: group.tax,
          gross: group.gross,
          taxSnapshot: frozen.taxSnapshot as Prisma.InputJsonValue,
        };
      }),
    });
    // Defence in depth: with this credit, no line is credited beyond its quantity and no tax
    // group beyond its net, tax or gross. The database checks the same on issue.
    const [limits] = await tx.$queryRaw<{ exceeds: boolean }[]>`
      SELECT credit_note_exceeds_original(${companyId}::uuid, ${id}::uuid) AS exceeds
    `;
    if (limits?.exceeds !== false) {
      throw new CommerceError(
        409,
        'over_credit',
        'invoice',
        id,
        'This credit note would credit more than the invoice shows.',
        CREDIT_ISSUED,
      );
    }
    // 5. The series, last, then the clock (as for invoices). A credit note's supply, issue
    //    and due dates are the day it is issued.
    const seriesId = company.defaultCreditNoteSeriesId;
    const series = seriesId ? await lockSeries(tx, companyId, seriesId) : null;
    const issuedAt = new Date();
    const issueDate = businessDateInZone(issuedAt, company.timezone);
    const seller = sellerSnapshot(company);
    const buyer = frozenBuyer(original.buyerSnapshot);
    const problems = issueProblems({
      seller: { legalName: seller.legalName, vatNumber: seller.vatNumber, address: seller.address },
      buyer: { vatNumber: buyer.vatNumber, address: buyer.address },
      lines: current.lines.map((line) => {
        const tax = lineTax.get(line.id) as TaxSnapshot;
        return {
          position: line.position,
          description: line.description,
          kind: tax.kind,
          noteEn: tax.noteEn,
          noteEl: tax.noteEl,
          // The original's treatment applies, even if its code was retired since.
          taxCodeActive: true,
        };
      }),
      total: totals.total,
      supplyDate: issueDate,
      issueDate,
      seriesId,
    });
    if (problems.length > 0) {
      throw new CommerceError(
        422,
        'invoice_incomplete',
        'invoice',
        id,
        'The credit note is missing details it must show.',
        CREDIT_ISSUED,
        { fields: problems },
      );
    }
    const deadline = deliveryDeadline(
      issueDate,
      [...lineTax.values()].map((tax) => tax.deadlineRule),
    );
    if (!series || !series.active || series.documentType !== 'credit_note') {
      throw new CommerceError(
        422,
        'series_unavailable',
        'invoice_series',
        seriesId,
        'The default credit-note series is not an active credit-note series.',
        CREDIT_ISSUED,
      );
    }
    const { number, numberSeq } = await this.takeNumber(tx, companyId, series, id, CREDIT_ISSUED);
    const originalIssueDate = formatDateOnly(original.issueDate);
    if (!original.number || !originalIssueDate || !current.creditReason) {
      throw new Error('a credit note needs its original number, date and reason');
    }
    const pdf = await renderIssuedInvoice(
      issuedPdfInput({
        language: languageOf(current.language, company.documentLanguage),
        number,
        issueDate,
        supplyDate: issueDate,
        dueDate: null,
        current,
        totals,
        seller,
        buyer,
        bank: null,
        terms: null,
        codeByKey: new Map(
          original.taxSummary.map((row) => [row.taxCodeId, frozenTax(row.taxSnapshot)]),
        ),
        documentType: 'credit_note',
        credits: {
          number: original.number,
          issueDate: originalIssueDate,
          reason: current.creditReason,
        },
      }),
    );
    const fileId = await this.sealPdf(tx, {
      companyId,
      documentId: id,
      sourceVersion: current.version + 1,
      actor,
      issuedAt,
      pdf,
    });
    const written = await tx.invoice.updateMany({
      where: { id, companyId, status: 'draft', version: expectedVersion },
      data: {
        status: 'issued',
        issueDate: parseDateOnly(issueDate, 'issueDate'),
        dueDate: parseDateOnly(issueDate, 'dueDate'),
        supplyDate: parseDateOnly(issueDate, 'supplyDate'),
        deliveryDeadline: parseDateOnly(deadline, 'deliveryDeadline'),
        seriesId: series.id,
        number,
        numberSeq,
        ...moneyFields(totals),
        sellerSnapshot: seller,
        buyerSnapshot: original.buyerSnapshot as Prisma.InputJsonValue,
        termsSnapshot: null,
        renderVersion: ISSUED_RENDER_VERSION,
        pdfFileId: fileId,
        issuedAt,
        issuedById: actor,
        updatedById: actor,
        version: { increment: 1 },
      },
    });
    if (written.count !== 1) {
      throw new CommerceError(
        409,
        'version_conflict',
        'invoice',
        id,
        'version conflict',
        CREDIT_ISSUED,
      );
    }
    // Both invoice rows are already locked together. Read history now, without new locks.
    const originalAllocations = await tx.allocation.findMany({
      where: { companyId, invoiceId: original.id },
    });
    const invoiceSettlement = {
      total: fixed(original.total, 2),
      issueDate: originalIssueDate,
      allocations: originalAllocations.map(datedAllocation),
    };
    const open = parseAmount(openBalance(invoiceSettlement), 2);
    const creditTotal = parseAmount(totals.total, 2);
    const amount = (creditTotal.lte(open) ? creditTotal : open).toFixed(2);
    let applied = '0.00';
    if (parseAmount(amount, 2).gt('0')) {
      const effectiveOn = allocationEffectiveOn({
        amount,
        today: issueDate,
        source: { amount: totals.total, date: issueDate, allocations: [], refunds: [] },
        invoice: invoiceSettlement,
      });
      if (effectiveOn !== null) {
        const allocation = await tx.allocation.create({
          data: {
            companyId,
            creditNoteId: id,
            invoiceId: original.id,
            amount,
            effectiveOn: parseDateOnly(effectiveOn, 'effectiveOn'),
            createdById: actor,
          },
        });
        applied = amount;
        await this.audit.record(tx, {
          companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'allocation.created',
          objectType: 'allocation',
          objectId: allocation.id,
          outcome: 'success',
          ...meta,
          details: { automatic: true, creditNoteId: id },
        });
      }
    }
    await this.audit.record(tx, {
      companyId,
      actorType: 'user',
      actorId: actor,
      actorLabel: ctx.actorLabel,
      action: CREDIT_ISSUED,
      objectType: 'invoice',
      objectId: id,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: {
        number,
        creditedInvoiceId: original.id,
        total: totals.total,
        applied,
        version: current.version + 1,
        pdfFileId: fileId,
      },
    });
    return { invoice: await this.detail(tx, companyId, id), warnings: [] };
  }

  /**
   * The series' next number, under the series lock the caller holds. A number another
   * series already used is refused; a rollback gives the number back.
   */
  private async takeNumber(
    tx: TenantTransaction,
    companyId: string,
    series: LockedSeries,
    documentId: string,
    action: string,
  ): Promise<{ number: string; numberSeq: number }> {
    const numberSeq = series.nextNumber;
    const number = `${series.prefix}${String(numberSeq).padStart(series.padding, '0')}`;
    const taken = await tx.invoice.findFirst({
      where: { companyId, number },
      select: { id: true },
    });
    if (taken) {
      throw numberTaken(documentId, number, action);
    }
    await tx.$executeRaw`
      UPDATE invoice_series
      SET next_number = next_number + 1, version = version + 1
      WHERE company_id = ${companyId}::uuid AND id = ${series.id}::uuid
    `;
    await this.hooks?.afterNumberAllocated?.();
    return { number, numberSeq };
  }

  /** Writes the issued PDF once, under a new key, and records it as the document's sealed file. */
  private async sealPdf(
    tx: TenantTransaction,
    args: {
      companyId: string;
      documentId: string;
      sourceVersion: number;
      actor: string;
      issuedAt: Date;
      pdf: Buffer;
    },
  ): Promise<string> {
    const fileId = uuidv7();
    const key = storageKey({
      companyId: args.companyId,
      kind: ISSUED_KIND,
      id: fileId,
      at: args.issuedAt,
    });
    await this.storage.put(key, args.pdf);
    await tx.storedFile.create({
      data: {
        id: fileId,
        companyId: args.companyId,
        kind: ISSUED_KIND,
        storageKey: key,
        contentType: 'application/pdf',
        sizeBytes: args.pdf.length,
        sha256: createHash('sha256').update(args.pdf).digest('hex'),
        sourceType: 'invoice',
        sourceId: args.documentId,
        sourceVersion: args.sourceVersion,
        createdById: args.actor,
        sealed: true,
      },
    });
    return fileId;
  }

  /**
   * Turns a quote into a new draft invoice with the quote's lines. The quote stays as it is;
   * it converts once (409 already_converted, also enforced by a unique index).
   */
  async convertQuote(
    ctx: RequestContext,
    quoteId: string,
    meta: RequestMeta,
  ): Promise<InvoiceDetail> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        if (!isUuid(quoteId)) {
          throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
        }
        const id = quoteId.toLowerCase();
        const companyId = ctx.companyId;
        const quote = await this.load(tx, companyId, id);
        if (quote.documentType !== 'quote') {
          throw new CommerceError(
            409,
            'not_a_quote',
            'invoice',
            id,
            'Only a quote is converted.',
            'quote.converted',
          );
        }
        if (quote.status !== 'draft') {
          throw new CommerceError(
            409,
            'not_draft',
            'invoice',
            id,
            'This quote can no longer be converted.',
            'quote.converted',
          );
        }
        // A converted quote says so before its lines are checked again (a code may be inactive
        // by now). Checked once more under the lock below, and by the unique index.
        const earlier = await tx.invoice.findFirst({
          where: { companyId, sourceQuoteId: id },
          select: { id: true },
        });
        if (earlier) {
          throw alreadyConverted(id, earlier.id);
        }
        // Lock order: the company, then the tax codes (resolveLines), then the quote row.
        const company = await this.company(tx, companyId, { lock: true });
        const client = await this.client(tx, companyId, quote.clientId);
        const currency = draftCurrency(company, client, null);
        const lines = await this.resolveLines(
          tx,
          companyId,
          quote.lines.map((line) => ({
            position: line.position,
            kind: line.kind,
            productId: line.productId,
            description: line.description,
            quantity: fixed(line.quantity, 4),
            unit: line.unit,
            unitPrice: fixed(line.unitPrice, 4),
            discountPercent: fixed(line.discountPercent, 2),
            taxCodeId: line.taxCodeId,
          })),
        );
        const locked = await tx.$queryRaw<{ version: number }[]>`
          SELECT version FROM invoice
          WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid
          FOR SHARE
        `;
        if (locked[0]?.version !== quote.version) {
          throw new CommerceError(
            409,
            'version_conflict',
            'invoice',
            id,
            'version conflict',
            'quote.converted',
          );
        }
        const existing = await tx.invoice.findFirst({
          where: { companyId, sourceQuoteId: id },
          select: { id: true },
        });
        if (existing) {
          throw alreadyConverted(id, existing.id);
        }
        const totals = calculated(quote.pricesIncludeTax, lines);
        const created = await tx.invoice.create({
          data: {
            companyId,
            documentType: 'invoice',
            status: 'draft',
            clientId: client.id,
            currency,
            language: languageOf(quote.language, company.documentLanguage),
            pricesIncludeTax: quote.pricesIncludeTax,
            dueDate: this.dueDate(undefined, null, client, company),
            reference: quote.reference,
            notes: quote.notes,
            terms: quote.terms,
            sourceQuoteId: id,
            ...moneyFields(totals),
            createdById: actor,
          },
        });
        await this.writeLines(tx, companyId, created.id, lines, totals);
        await this.audit.record(tx, {
          companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'quote.converted',
          objectType: 'invoice',
          objectId: id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { invoiceId: created.id, total: totals.total },
        });
        return this.detail(tx, companyId, created.id);
      });
    } catch (error) {
      // Two conversions raced: the unique index let one through.
      let settled = isUniqueViolation(error)
        ? alreadyConverted(quoteId.toLowerCase(), null)
        : error;
      if (
        settled instanceof CommerceError &&
        settled.reason !== 'already_converted' &&
        isUuid(quoteId)
      ) {
        // Another conversion may have committed while this one waited on a lock; that is the
        // answer, not a refusal found later (for example a tax code switched off since).
        const converted = await this.tenants.run(this.context(ctx, actor), (tx) =>
          tx.invoice.findFirst({
            where: { companyId: ctx.companyId, sourceQuoteId: quoteId.toLowerCase() },
            select: { id: true },
          }),
        );
        if (converted) {
          settled = alreadyConverted(quoteId.toLowerCase(), converted.id);
        }
      }
      // A refusal from the shared draft rules (currency, tax codes, amounts) is a refused
      // conversion of this quote, and is audited as one. The request itself was well formed,
      // so what was 400 (for example tax_code_inactive) is 422: the quote cannot convert as is.
      if (
        settled instanceof CommerceError &&
        settled.status !== 404 &&
        settled.status !== 403 &&
        isUuid(quoteId)
      ) {
        settled = new CommerceError(
          settled.status === 400 ? 422 : settled.status,
          settled.reason,
          'invoice',
          quoteId.toLowerCase(),
          settled.message,
          'quote.converted',
          settled.details,
        );
      }
      return this.fail(ctx, meta, settled);
    }
  }

  /**
   * Records how and when an issued document reached the client (Cyprus VAT reg. 11(5), 11(6)).
   * The record is append-only. A delivery after the deadline is recorded with a warning.
   */
  async recordDelivery(
    ctx: RequestContext,
    invoiceId: string,
    input: DeliveryInput,
    meta: RequestMeta,
  ): Promise<{ invoice: InvoiceDetail; delivery: DeliveryView; warnings: string[] }> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        if (!isUuid(invoiceId)) {
          throw new CommerceError(404, 'invoice_not_found', 'invoice', null, 'Not found');
        }
        const id = invoiceId.toLowerCase();
        const companyId = ctx.companyId;
        const invoice = await tx.invoice.findFirst({
          where: { id, companyId },
          select: {
            id: true,
            status: true,
            clientId: true,
            issueDate: true,
            deliveryDeadline: true,
          },
        });
        if (!invoice) {
          throw new CommerceError(404, 'invoice_not_found', 'invoice', id, 'Not found');
        }
        if (invoice.status !== 'issued') {
          throw new CommerceError(
            409,
            'not_issued',
            'invoice',
            id,
            'Only an issued document is delivered.',
            'invoice.delivery_recorded',
          );
        }
        const company = await this.company(tx, companyId);
        const deliveredOn = parseDateOnly(input.deliveredOn, 'deliveredOn');
        const delivered = formatDateOnly(deliveredOn) ?? input.deliveredOn;
        const issued = formatDateOnly(invoice.issueDate) ?? '';
        if (delivered < issued) {
          throw new CommerceError(
            422,
            'delivered_before_issue',
            'invoice',
            id,
            'A document cannot be delivered before its issue date.',
            'invoice.delivery_recorded',
          );
        }
        if (delivered > businessDateInZone(new Date(), company.timezone)) {
          throw new CommerceError(
            422,
            'delivered_in_future',
            'invoice',
            id,
            'The delivery date is in the future.',
            'invoice.delivery_recorded',
          );
        }
        if (PAPER_METHODS.has(input.method) && input.paperCopyKept !== true) {
          throw new CommerceError(
            422,
            'paper_copy_required',
            'invoice',
            id,
            'Keep the company copy of a paper invoice, then record the delivery.',
            'invoice.delivery_recorded',
          );
        }
        if (input.method === 'emailed_outside_platform') {
          // FOR SHARE: the consent cannot be withdrawn while this delivery is recorded.
          const client = await tx.$queryRaw<{ acceptsEInvoices: boolean }[]>`
            SELECT accepts_e_invoices AS "acceptsEInvoices" FROM client
            WHERE company_id = ${companyId}::uuid AND id = ${invoice.clientId}::uuid
            FOR SHARE
          `;
          if (client[0]?.acceptsEInvoices !== true) {
            throw new CommerceError(
              409,
              'e_invoice_not_accepted',
              'invoice',
              id,
              'This client has not accepted electronic invoices. Print it and deliver it on paper.',
              'invoice.delivery_recorded',
            );
          }
        }
        const created = await tx.invoiceDelivery.create({
          data: {
            companyId,
            invoiceId: id,
            method: input.method,
            deliveredOn,
            paperCopyKept: input.paperCopyKept ?? false,
            note: input.note ?? null,
            recordedById: actor,
          },
        });
        const deadline = formatDateOnly(invoice.deliveryDeadline);
        const late = deadline !== null && delivered > deadline;
        await this.audit.record(tx, {
          companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'invoice.delivery_recorded',
          objectType: 'invoice',
          objectId: id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: {
            deliveryId: created.id,
            method: created.method,
            deliveredOn: delivered,
            paperCopyKept: created.paperCopyKept,
            ...(late ? { late: true } : {}),
          },
        });
        const detail = await this.detail(tx, companyId, id);
        const delivery = detail.deliveries.find((entry) => entry.id === created.id);
        if (!delivery) {
          throw new Error('the recorded delivery is missing');
        }
        return {
          invoice: detail,
          delivery,
          warnings: late ? ['delivered_after_deadline'] : [],
        };
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async pdf(
    ctx: RequestContext,
    invoiceId: string,
    meta: RequestMeta,
  ): Promise<{ id: string; bytes: Buffer; fileName: string }> {
    const actor = requireActor(ctx);
    try {
      const input = await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const invoice = await this.load(tx, ctx.companyId, invoiceId);
        if (invoice.status === 'issued') {
          // The stored file is the legal document. It is never rendered again.
          const file = invoice.pdfFileId
            ? await tx.storedFile.findFirst({
                where: { id: invoice.pdfFileId, companyId: ctx.companyId },
                select: { id: true, storageKey: true, sizeBytes: true, sha256: true },
              })
            : null;
          if (!file) {
            throw new CommerceError(404, 'pdf_not_found', 'invoice', invoice.id, 'Not found');
          }
          return { kind: 'issued' as const, id: invoice.id, number: invoice.number, file };
        }
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
          kind: 'draft' as const,
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
      if (input.kind === 'issued') {
        let bytes: Buffer;
        try {
          bytes = await readVerifiedFile(this.storage, input.file);
        } catch (error) {
          if (error instanceof FileIntegrityError) {
            throw integrityFailed(input.file.id, error);
          }
          if (isStorageMiss(error)) {
            throw new CommerceError(
              404,
              'pdf_not_found',
              'stored_file',
              input.file.id,
              'Not found',
            );
          }
          throw new Error('storage read failed');
        }
        return { id: input.id, bytes, fileName: `${safeFileName(input.number ?? input.id)}.pdf` };
      }
      return {
        id: input.id,
        bytes: await renderInvoiceDraft(input.pdf),
        fileName: `draft-${input.id}.pdf`,
      };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  /** With lock, holds the company row FOR SHARE so its currency cannot change before commit. */
  private async company(
    tx: TenantTransaction,
    companyId: string,
    options: { lock?: boolean } = {},
  ): Promise<CompanyRow> {
    if (options.lock) {
      await tx.$queryRaw`SELECT id FROM company WHERE id = ${companyId}::uuid FOR SHARE`;
    }
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

  /** The full detail of one document, inside the caller's transaction. */
  async detail(
    tx: TenantTransaction,
    companyId: string,
    invoiceId: string,
  ): Promise<InvoiceDetail> {
    const row = await this.load(tx, companyId, invoiceId);
    if (row.status !== 'issued') {
      return toDetail(row);
    }
    const allocations =
      row.documentType === 'invoice' || row.documentType === 'credit_note'
        ? await tx.allocation.findMany({
            where: {
              companyId,
              ...(row.documentType === 'invoice'
                ? { invoiceId: row.id }
                : { creditNoteId: row.id }),
            },
            include: {
              payment: { select: { id: true, receivedOn: true, reference: true } },
              creditNote: { select: { id: true, number: true } },
              invoice: { select: { id: true, number: true } },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];
    const refunds =
      row.documentType === 'credit_note'
        ? await tx.refund.findMany({ where: { companyId, creditNoteId: row.id } })
        : [];
    const creditedQuantities =
      row.documentType === 'invoice'
        ? await creditedQuantitiesOf(tx, companyId, row.id)
        : undefined;
    const jobs = await tx.printJob.findMany({
      where: { companyId, sourceType: 'invoice', sourceId: row.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: {
        id: true,
        status: true,
        isReprint: true,
        copies: true,
        createdAt: true,
        printer: { select: { provider: true } },
      },
    });
    // The same rule as print_job_one_first_print_key.
    const first = await tx.printJob.findFirst({
      where: {
        companyId,
        sourceType: 'invoice',
        sourceId: row.id,
        documentType: 'invoice',
        isReprint: false,
        status: { notIn: ['failed', 'cancelled', 'not_printed'] },
      },
      select: { id: true },
    });
    return toDetail(row, {
      balance: invoiceBalance(row, allocations),
      unappliedAmount:
        row.documentType === 'credit_note'
          ? sourceRemaining({
              amount: fixed(row.total, 2),
              allocations: allocations.map(datedAllocation),
              refunds: refunds.map(datedRefund),
            })
          : null,
      allocations: allocations.map((allocation): InvoiceAllocation => {
        const fields = {
          id: allocation.id,
          amount: fixed(allocation.amount, 2),
          effectiveOn: day(allocation.effectiveOn),
          reversedOn: formatDateOnly(allocation.reversedOn),
          reversalReason: allocation.reversalReason,
        };
        if (row.documentType === 'credit_note') return { ...fields, invoice: allocation.invoice };
        if (allocation.payment) {
          return {
            ...fields,
            source: {
              type: 'payment',
              ...allocation.payment,
              receivedOn: day(allocation.payment.receivedOn),
            },
          };
        }
        if (allocation.creditNote) {
          return { ...fields, source: { type: 'credit_note', ...allocation.creditNote } };
        }
        throw new Error('Allocation requires a source');
      }),
      printJobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        isReprint: job.isReprint,
        copies: job.copies,
        createdAt: job.createdAt.toISOString(),
        simulationLabel: job.printer.provider === 'mock' ? SIMULATED_PRINTING_LABEL : null,
      })),
      firstPrintJobId: first?.id ?? null,
      ...(creditedQuantities ? { creditedQuantities } : {}),
    });
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
    // FOR SHARE, ordered by id: a tax-code edit (FOR UPDATE) waits for this draft, or this draft
    // reads the edited row. Either way the stored line rate equals the code's rate.
    const taxCodes =
      taxIds.length === 0
        ? []
        : await tx.$queryRaw<{ id: string; code: string; ratePercent: string; active: boolean }[]>`
      SELECT id::text AS id, code, rate_percent::text AS "ratePercent", active FROM tax_code
      WHERE company_id = ${companyId}::uuid AND id = ANY(${taxIds}::uuid[])
      ORDER BY id
      FOR SHARE
    `;
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
        taxRatePercent: decimalField(tax.ratePercent, 4, 'taxRatePercent'),
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

/** Drafts are in the company currency only. A client with another default currency is refused. */
function draftCurrency(
  company: CompanyRow,
  client: { defaultCurrency: string | null },
  invoiceId: string | null,
): string {
  const currency = invoiceCurrency(company.defaultCurrency, invoiceId);
  if (client.defaultCurrency && client.defaultCurrency.trim().toUpperCase() !== currency) {
    throw new CommerceError(
      422,
      'currency_not_supported',
      'invoice',
      invoiceId,
      `Drafts are in the company currency (${currency}) only. This client's currency is ${client.defaultCurrency}.`,
      invoiceId ? 'invoice.updated' : 'invoice.created',
    );
  }
  return currency;
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

function toSummary(
  row: {
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
    supplyDate: Date | null;
    deliveryDeadline: Date | null;
    number: string | null;
    issuedAt: Date | null;
    deliveries: { deliveredOn: Date }[];
    reference: string | null;
    subtotal: { toFixed(digits: number): string };
    discountTotal: { toFixed(digits: number): string };
    netTotal: { toFixed(digits: number): string };
    taxTotal: { toFixed(digits: number): string };
    total: { toFixed(digits: number): string };
    version: number;
    createdAt: Date;
    updatedAt: Date;
  },
  balance: ReturnType<typeof invoiceBalance> = { openBalance: null, paymentState: null },
): InvoiceSummary {
  return {
    ...balance,
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
    supplyDate: formatDateOnly(row.supplyDate),
    deliveryDeadline: formatDateOnly(row.deliveryDeadline),
    number: row.number,
    issuedAt: row.issuedAt ? row.issuedAt.toISOString() : null,
    lastDeliveredOn: formatDateOnly(
      row.deliveries.reduce<Date | null>(
        (latest, delivery) =>
          latest === null || delivery.deliveredOn > latest ? delivery.deliveredOn : latest,
        null,
      ),
    ),
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
  row: Omit<Parameters<typeof toSummary>[0], 'deliveries'> & {
    notes: string | null;
    terms: string | null;
    lines: (Parameters<typeof storedLines>[0][number] & {
      id: string;
      creditedLineId: string | null;
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
    deliveries: {
      id: string;
      method: DeliveryMethod;
      deliveredOn: Date;
      paperCopyKept: boolean;
      note: string | null;
      recordedById: string;
      createdAt: Date;
    }[];
    creditReason: string | null;
    sourceQuoteId: string | null;
    creditedInvoice: { id: string; number: string | null; issueDate: Date | null } | null;
    creditNotes: {
      id: string;
      number: string | null;
      status: string;
      total: { toFixed(digits: number): string };
      issueDate: Date | null;
    }[];
    convertedInvoices: { id: string }[];
  },
  extras: DetailExtras = {},
): InvoiceDetail {
  return {
    ...toSummary(row, extras.balance),
    unappliedAmount: extras.unappliedAmount ?? null,
    allocations: extras.allocations ?? [],
    notes: row.notes,
    terms: row.terms,
    printJobs: extras.printJobs ?? [],
    firstPrintJobId: extras.firstPrintJobId ?? null,
    creditReason: row.creditReason,
    creditedInvoice: row.creditedInvoice
      ? {
          id: row.creditedInvoice.id,
          number: row.creditedInvoice.number,
          issueDate: formatDateOnly(row.creditedInvoice.issueDate),
        }
      : null,
    creditNotes: row.creditNotes.map((note) => ({
      id: note.id,
      number: note.number,
      status: note.status,
      total: fixed(note.total, 2),
      issueDate: formatDateOnly(note.issueDate),
    })),
    sourceQuoteId: row.sourceQuoteId,
    convertedInvoiceId: row.convertedInvoices[0]?.id ?? null,
    deliveries: row.deliveries.map((delivery) => ({
      id: delivery.id,
      method: delivery.method,
      deliveredOn: formatDateOnly(delivery.deliveredOn) ?? '',
      paperCopyKept: delivery.paperCopyKept,
      note: delivery.note,
      recordedById: delivery.recordedById,
      createdAt: delivery.createdAt.toISOString(),
    })),
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
      creditedLineId: line.creditedLineId,
      creditedQuantity: extras.creditedQuantities?.get(line.id) ?? '0.0000',
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
  // Company setup stores `postcode`; older rows may say `postalCode`.
  return ['line1', 'line2', 'city', 'region', 'postcode', 'postalCode', 'countryCode'].flatMap(
    (key) => {
      const line = record[key];
      return typeof line === 'string' && line.length > 0 ? [line] : [];
    },
  );
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
  const chosen = chosenAddress(addresses);
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

type ClientAddress = ClientRow['addresses'][number];

/** Per original line: the quantity credited by issued credit notes. Drafts do not count. */
export async function creditedQuantitiesOf(
  tx: TenantTransaction,
  companyId: string,
  invoiceId: string,
): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<{ lineId: string; quantity: string }[]>`
    SELECT l.credited_line_id::text AS "lineId", sum(l.quantity)::text AS quantity
    FROM invoice_line l
    JOIN invoice c ON c.company_id = l.company_id AND c.id = l.invoice_id
    WHERE l.company_id = ${companyId}::uuid
      AND c.credited_invoice_id = ${invoiceId}::uuid
      AND c.status = 'issued'
    GROUP BY l.credited_line_id
  `;
  return new Map(rows.map((row) => [row.lineId, decimalField(row.quantity, 4, 'quantity')]));
}

/** The default billing address, else the first billing address, else any address. */
function chosenAddress<T extends { kind: string; isDefault: boolean }>(
  addresses: readonly T[],
): T | undefined {
  const billing = addresses.filter((address) => address.kind === 'billing');
  return billing.find((address) => address.isDefault) ?? billing[0] ?? addresses[0];
}

/** Both switches, `FOR SHARE`, so turning one off waits for this issue or refuses it. */
async function requireIssuance(
  tx: TenantTransaction,
  companyId: string,
  invoiceId: string,
  action = 'invoice.issue',
): Promise<void> {
  const rows = await tx.$queryRaw<{ key: string; enabled: boolean; companyId: string | null }[]>`
    SELECT key, enabled, company_id::text AS "companyId"
    FROM automation_switch
    WHERE (company_id IS NULL AND key = 'outbound.all')
       OR (company_id = ${companyId}::uuid AND key = 'invoice.issue_real')
    ORDER BY id
    FOR SHARE
  `;
  const outbound = rows.some(
    (row) => row.companyId === null && row.key === 'outbound.all' && row.enabled,
  );
  const issuing = rows.some(
    (row) =>
      row.companyId === companyId.toLowerCase() && row.key === 'invoice.issue_real' && row.enabled,
  );
  if (!outbound || !issuing) {
    throw new CommerceError(
      409,
      'issuance_disabled',
      'invoice',
      invoiceId,
      'Issuing real invoices is switched off.',
      action,
      { outboundAll: outbound, invoiceIssueReal: issuing },
    );
  }
}

async function lockTaxCodes(
  tx: TenantTransaction,
  companyId: string,
  ids: readonly string[],
): Promise<TaxCodeLock[]> {
  if (ids.length === 0) {
    return [];
  }
  return tx.$queryRaw<TaxCodeLock[]>`
    SELECT id::text AS id, code, name, rate_percent::text AS "ratePercent", kind::text AS kind,
           note_en AS "noteEn", note_el AS "noteEl", active, deadline_rule::text AS "deadlineRule"
    FROM tax_code
    WHERE company_id = ${companyId}::uuid AND id = ANY(${[...ids]}::uuid[])
    ORDER BY id
    FOR SHARE
  `;
}

type LockedSeries = {
  id: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  padding: number;
  active: boolean;
};

async function lockSeries(
  tx: TenantTransaction,
  companyId: string,
  seriesId: string,
): Promise<LockedSeries | null> {
  const rows = await tx.$queryRaw<LockedSeries[]>`
    SELECT id::text AS id, document_type::text AS "documentType", prefix,
           next_number AS "nextNumber", padding, active
    FROM invoice_series
    WHERE company_id = ${companyId}::uuid AND id = ${seriesId}::uuid
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function alreadyConverted(quoteId: string, invoiceId: string | null): CommerceError {
  return new CommerceError(
    409,
    'already_converted',
    'invoice',
    quoteId,
    'This quote was already converted to an invoice.',
    'quote.converted',
    invoiceId ? { invoiceId } : undefined,
  );
}

function numberTaken(
  invoiceId: string,
  number: string | null,
  action = 'invoice.issue',
): CommerceError {
  return new CommerceError(
    409,
    'number_taken',
    'invoice',
    invoiceId,
    `${number ? `The number ${number}` : 'The next number'} is already used by another series. Give the series a different prefix.`,
    action,
  );
}

/** A unique violation while issuing means the number exists already (two series, one prefix). */
function numberTakenOr(error: unknown, invoiceId: string, action = 'invoice.issue'): unknown {
  return isUniqueViolation(error) ? numberTaken(invoiceId.toLowerCase(), null, action) : error;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if ('code' in error && (error.code === 'P2002' || error.code === '23505')) {
    return true;
  }
  return 'cause' in error && isUniqueViolation(error.cause);
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sellerSnapshot(company: CompanyRow): SellerSnapshot {
  const record =
    company.address && typeof company.address === 'object' && !Array.isArray(company.address)
      ? (company.address as Record<string, unknown>)
      : {};
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    legalName: company.legalName,
    tradingName: company.tradingName,
    vatNumber: company.vatNumber,
    registrationNumber: company.registrationNumber,
    taxOffice: company.taxOffice,
    address: {
      line1: text('line1'),
      line2: text('line2'),
      city: text('city'),
      region: text('region'),
      postalCode: text('postcode') ?? text('postalCode'),
      countryCode: text('countryCode') ?? company.countryCode,
    },
    addressLines: jsonAddressLines(company.address),
  };
}

function buyerSnapshot(client: {
  id: string;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxId: string | null;
  email: string | null;
  addresses: ClientAddress[];
}): BuyerSnapshot {
  const chosen = chosenAddress(client.addresses);
  return {
    clientId: client.id,
    displayName: client.displayName,
    legalName: client.legalName,
    vatNumber: client.vatNumber,
    taxId: client.taxId,
    email: client.email,
    address: chosen
      ? {
          line1: chosen.line1,
          line2: chosen.line2,
          city: chosen.city,
          region: chosen.region,
          postalCode: chosen.postalCode,
          countryCode: chosen.countryCode,
        }
      : null,
    addressLines: clientAddressLines(client.addresses),
  };
}

function taxSnapshot(code: TaxCodeLock): TaxSnapshot {
  return {
    code: code.code,
    name: code.name,
    kind: code.kind,
    ratePercent: decimalField(code.ratePercent, 4, 'taxRatePercent'),
    noteEn: code.noteEn,
    noteEl: code.noteEl,
    deadlineRule: code.deadlineRule,
  };
}

/** The PDF shows the frozen snapshot, never live data. */
/** A credit line still carries what it copied from the line it credits. */
function copiesSource(
  line: {
    kind: string;
    productId: string | null;
    description: string;
    unit: string;
    unitPrice: { toFixed(digits: number): string };
    discountPercent: { toFixed(digits: number): string };
    taxCodeId: string;
    taxRatePercent: { toFixed(digits: number): string };
  },
  source: typeof line,
): boolean {
  return (
    line.kind === source.kind &&
    line.productId === source.productId &&
    line.description === source.description &&
    line.unit === source.unit &&
    fixed(line.unitPrice, 4) === fixed(source.unitPrice, 4) &&
    fixed(line.discountPercent, 2) === fixed(source.discountPercent, 2) &&
    line.taxCodeId === source.taxCodeId &&
    fixed(line.taxRatePercent, 4) === fixed(source.taxRatePercent, 4)
  );
}

/** An issued document's frozen tax snapshot, read back. */
function frozenTax(value: unknown): TaxSnapshot {
  const record = jsonRecord(value);
  const code = jsonText(record, 'code');
  const name = jsonText(record, 'name');
  const kind = jsonText(record, 'kind');
  const ratePercent = jsonText(record, 'ratePercent');
  const deadlineRule = record?.deadlineRule;
  if (
    !code ||
    !name ||
    !kind ||
    !ratePercent ||
    (deadlineRule !== 'days_30' && deadlineRule !== 'next_month_15')
  ) {
    throw new Error('an issued tax snapshot is incomplete');
  }
  return {
    code,
    name,
    kind,
    ratePercent,
    noteEn: jsonText(record, 'noteEn'),
    noteEl: jsonText(record, 'noteEl'),
    deadlineRule,
  };
}

/** An issued document's frozen buyer, read back. */
function frozenBuyer(value: unknown): BuyerSnapshot {
  const record = jsonRecord(value);
  const clientId = jsonText(record, 'clientId');
  const displayName = jsonText(record, 'displayName');
  if (!record || !clientId || !displayName) {
    throw new Error('an issued buyer snapshot is incomplete');
  }
  const address = jsonRecord(record.address);
  return {
    clientId,
    displayName,
    legalName: jsonText(record, 'legalName'),
    vatNumber: jsonText(record, 'vatNumber'),
    taxId: jsonText(record, 'taxId'),
    email: jsonText(record, 'email'),
    address: address
      ? {
          line1: jsonText(address, 'line1'),
          line2: jsonText(address, 'line2'),
          city: jsonText(address, 'city'),
          region: jsonText(address, 'region'),
          postalCode: jsonText(address, 'postalCode'),
          countryCode: jsonText(address, 'countryCode'),
        }
      : null,
    addressLines: Array.isArray(record.addressLines)
      ? record.addressLines.filter((line): line is string => typeof line === 'string')
      : [],
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

function issuedPdfInput(args: {
  language: DocumentLanguage;
  number: string;
  issueDate: string;
  supplyDate: string;
  dueDate: string | null;
  current: {
    currency: string;
    pricesIncludeTax: boolean;
    reference: string | null;
    notes: string | null;
    lines: {
      position: number;
      description: string;
      quantity: { toFixed(digits: number): string };
      unit: string;
      unitPrice: { toFixed(digits: number): string };
      discountPercent: { toFixed(digits: number): string };
      taxCodeId: string;
      taxRatePercent: { toFixed(digits: number): string };
    }[];
  };
  totals: DocumentTotals;
  seller: SellerSnapshot;
  buyer: BuyerSnapshot;
  bank: BankSnapshot | null;
  terms: string | null;
  /** Per tax-summary group key: the code, name, kind and notes to print. */
  codeByKey: ReadonlyMap<string, TaxInfo>;
  documentType?: 'invoice' | 'credit_note';
  credits?: { number: string; issueDate: string; reason: string } | null;
}): IssuedInvoicePdfInput {
  const { current, totals } = args;
  const amounts = new Map(totals.lines.map((line) => [line.position, line]));
  const lines = [...current.lines]
    .sort((left, right) => left.position - right.position)
    .map((line) => {
      const rate = fixed(line.taxRatePercent, 4);
      const unitPrice = fixed(line.unitPrice, 4);
      return {
        description: line.description,
        quantity: printedQuantity(fixed(line.quantity, 4)),
        unit: line.unit,
        unitPrice: printedUnitAmount(
          current.pricesIncludeTax ? vatExclusiveUnitPrice(unitPrice, rate) : unitPrice,
        ),
        discountPercent: fixed(line.discountPercent, 2),
        taxRatePercent: printedUnitAmount(rate),
        lineNet: amounts.get(line.position)?.lineNet ?? '',
      };
    });
  const printed = (key: string) => args.codeByKey.get(key)?.code ?? key;
  const groups = [...totals.taxSummary].sort((left, right) =>
    printed(left.taxCode).localeCompare(printed(right.taxCode)),
  );
  const notes: string[] = [];
  for (const group of groups) {
    const code = args.codeByKey.get(group.taxCode);
    if (!code || !NOTED_KINDS.has(code.kind)) {
      continue;
    }
    const ordered =
      args.language === 'el' ? [code.noteEl, code.noteEn] : [code.noteEn, code.noteEl];
    for (const note of ordered) {
      const line = present(note) ? `${code.code}: ${note}` : null;
      if (line && !notes.includes(line)) {
        notes.push(line);
      }
    }
  }
  return {
    language: args.language,
    documentType: args.documentType ?? 'invoice',
    credits: args.credits ?? null,
    number: args.number,
    issueDate: args.issueDate,
    supplyDate: args.supplyDate,
    dueDate: args.dueDate,
    currency: current.currency,
    pricesIncludeTax: current.pricesIncludeTax,
    reference: current.reference,
    notes: current.notes,
    terms: args.terms,
    seller: {
      name: args.seller.legalName,
      otherName: args.seller.tradingName,
      vatNumber: args.seller.vatNumber,
      registrationNumber: args.seller.registrationNumber,
      addressLines: args.seller.addressLines,
    },
    buyer: {
      name: args.buyer.legalName ?? args.buyer.displayName,
      otherName: args.buyer.legalName ? args.buyer.displayName : null,
      vatNumber: args.buyer.vatNumber,
      registrationNumber: null,
      addressLines: args.buyer.addressLines,
    },
    bank: args.bank,
    lines,
    taxSummary: groups.map((group) => {
      const code = args.codeByKey.get(group.taxCode);
      return {
        code: code?.code ?? group.taxCode,
        name: code?.name ?? group.taxCode,
        ratePercent: printedUnitAmount(group.taxRatePercent),
        net: group.net,
        tax: group.tax,
        gross: group.gross,
      };
    }),
    vatNotes: notes,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    netTotal: totals.netTotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
  };
}

/** 1.0000 prints 1 and 2.5000 prints 2.5. */
function printedQuantity(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** Letters, digits, dot, dash and underscore only, for a Content-Disposition file name. */
function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'invoice';
}
