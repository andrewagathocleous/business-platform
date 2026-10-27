import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { fixed } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import {
  rateMatchesKind,
  type BankAccountCreate,
  type BankAccountPatch,
  type SeriesCreate,
  type SeriesPatch,
  type TaxCodeCreate,
  type TaxCodePatch,
  type TaxKindValue,
} from './finance-settings.schema';

export type TaxCodeView = {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
  kind: string;
  noteEn: string | null;
  noteEl: string | null;
  deadlineRule: 'days_30' | 'next_month_15';
  isExample: boolean;
  active: boolean;
  /** An invoice line uses this code, so its rate, kind and notes are locked. */
  inUse: boolean;
  version: number;
};

export type SeriesView = {
  id: string;
  code: string;
  documentType: 'invoice' | 'credit_note' | 'quote';
  prefix: string;
  nextNumber: number;
  padding: number;
  active: boolean;
  /** A number was issued from this series, so its prefix, padding and next number are locked. */
  hasIssued: boolean;
  version: number;
};

export type BankAccountView = {
  id: string;
  bankName: string;
  accountHolder: string;
  iban: string;
  bic: string | null;
  shownOnInvoices: boolean;
  active: boolean;
  version: number;
};

type TaxCodeRow = {
  id: string;
  code: string;
  name: string;
  ratePercent: { toFixed(digits: number): string };
  kind: TaxKindValue;
  noteEn: string | null;
  noteEl: string | null;
  deadlineRule: 'days_30' | 'next_month_15';
  isExample: boolean;
  active: boolean;
  version: number;
};

type SeriesRow = {
  id: string;
  code: string;
  documentType: 'invoice' | 'credit_note' | 'quote';
  prefix: string;
  nextNumber: number;
  padding: number;
  active: boolean;
  version: number;
};

type BankRow = BankAccountView;

/** Fields a tax code keeps once any invoice line, draft or issued, uses it. */
const TAX_LOCKED_FIELDS = new Set(['ratePercent', 'kind', 'noteEn', 'noteEl']);
/** Fields a series keeps once a number is issued from it. */
const SERIES_LOCKED_FIELDS = new Set(['prefix', 'padding', 'nextNumber']);

const bankSelect = {
  id: true,
  bankName: true,
  accountHolder: true,
  iban: true,
  bic: true,
  shownOnInvoices: true,
  active: true,
  version: true,
} as const;

@Injectable()
export class FinanceSettingsService {
  private readonly tenant: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly auditLog: AuditService,
  ) {
    this.tenant = new TenantDb(prisma.client);
  }

  async listTaxCodes(ctx: RequestContext): Promise<TaxCodeView[]> {
    const actor = requireActor(ctx);
    return this.tenant.run(this.context(ctx, actor), async (tx) => {
      const rows = await tx.taxCode.findMany({
        where: { companyId: ctx.companyId },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      });
      const used = await tx.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT tax_code_id::text AS id FROM invoice_line
        WHERE company_id = ${ctx.companyId}::uuid
      `;
      const usedIds = new Set(used.map((row) => row.id));
      return rows.map((row) => toTaxCode(row, usedIds.has(row.id)));
    });
  }

  async createTaxCode(
    ctx: RequestContext,
    input: TaxCodeCreate,
    meta: RequestMeta,
  ): Promise<TaxCodeView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        await lockCode(tx, 'tax_code', ctx.companyId, input.code);
        if (await taxCodeTaken(tx, ctx.companyId, input.code)) {
          throw codeTaken('tax_code', null, 'tax_code.created');
        }
        const created = await tx.taxCode.create({
          data: {
            companyId: ctx.companyId,
            code: input.code,
            name: input.name,
            ratePercent: input.ratePercent,
            kind: input.kind,
            noteEn: input.noteEn ?? null,
            noteEl: input.noteEl ?? null,
            deadlineRule: input.deadlineRule ?? 'days_30',
            isExample: false,
            active: true,
          },
        });
        await this.audit(tx, ctx, meta, 'tax_code.created', 'tax_code', created.id, {
          code: created.code,
          ratePercent: fixed(created.ratePercent, 4),
          kind: created.kind,
        });
        return toTaxCode(created, false);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateTaxCode(
    ctx: RequestContext,
    taxCodeId: string,
    input: TaxCodePatch,
    meta: RequestMeta,
  ): Promise<TaxCodeView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        const current = await this.lockTaxCode(tx, ctx.companyId, taxCodeId);
        if (current.version !== input.expectedVersion) {
          throw versionConflict('tax_code', current.id, 'tax_code.updated');
        }
        const fields = taxCodeFields(current, input);
        const inUse = await taxCodeInUse(tx, ctx.companyId, current.id);
        if (fields.length === 0) {
          return toTaxCode(current, inUse);
        }
        const kind = input.kind ?? current.kind;
        const ratePercent = input.ratePercent ?? fixed(current.ratePercent, 4);
        if (!rateMatchesKind(kind, ratePercent)) {
          throw new CommerceError(
            400,
            'rate_kind_mismatch',
            'tax_code',
            current.id,
            'ratePercent must be above 0 for standard and reduced codes, and 0 for the others',
          );
        }
        const locked = fields.filter((field) => TAX_LOCKED_FIELDS.has(field));
        // An edit holds the code FOR UPDATE; saving a draft holds it FOR SHARE.
        // So a draft that uses the code either committed before this check, or waits for this edit.
        if (locked.length > 0 && inUse) {
          throw new CommerceError(
            409,
            'tax_code_in_use',
            'tax_code',
            current.id,
            'An invoice line uses this tax code. Create a new code instead.',
            'tax_code.updated',
            { fields: locked },
          );
        }
        if (fields.includes('code')) {
          await lockCode(tx, 'tax_code', ctx.companyId, input.code ?? current.code);
          if (await taxCodeTaken(tx, ctx.companyId, input.code ?? current.code, current.id)) {
            throw codeTaken('tax_code', current.id, 'tax_code.updated');
          }
        }
        const written = await tx.taxCode.updateMany({
          where: { id: current.id, companyId: ctx.companyId, version: input.expectedVersion },
          data: {
            ...(fields.includes('code') ? { code: input.code } : {}),
            ...(fields.includes('name') ? { name: input.name } : {}),
            ...(fields.includes('ratePercent') ? { ratePercent: input.ratePercent } : {}),
            ...(fields.includes('kind') ? { kind: input.kind } : {}),
            ...(fields.includes('noteEn') ? { noteEn: input.noteEn } : {}),
            ...(fields.includes('noteEl') ? { noteEl: input.noteEl } : {}),
            ...(fields.includes('deadlineRule') ? { deadlineRule: input.deadlineRule } : {}),
            ...(fields.includes('active') ? { active: input.active } : {}),
            version: { increment: 1 },
          },
        });
        if (written.count !== 1) {
          throw versionConflict('tax_code', current.id, 'tax_code.updated');
        }
        const saved = await tx.taxCode.findFirstOrThrow({
          where: { id: current.id, companyId: ctx.companyId },
        });
        await this.audit(tx, ctx, meta, 'tax_code.updated', 'tax_code', saved.id, { fields });
        return toTaxCode(saved, inUse);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async listSeries(ctx: RequestContext): Promise<SeriesView[]> {
    const actor = requireActor(ctx);
    return this.tenant.run(this.context(ctx, actor), async (tx) => {
      const rows = await tx.invoiceSeries.findMany({
        where: { companyId: ctx.companyId },
        orderBy: [{ documentType: 'asc' }, { code: 'asc' }, { id: 'asc' }],
      });
      const issued = await tx.$queryRaw<{ id: string }[]>`
        SELECT DISTINCT series_id::text AS id FROM invoice
        WHERE company_id = ${ctx.companyId}::uuid AND series_id IS NOT NULL AND number_seq IS NOT NULL
      `;
      const issuedIds = new Set(issued.map((row) => row.id));
      return rows.map((row) => toSeries(row, issuedIds.has(row.id)));
    });
  }

  async createSeries(
    ctx: RequestContext,
    input: SeriesCreate,
    meta: RequestMeta,
  ): Promise<SeriesView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        await lockCode(tx, 'invoice_series', ctx.companyId, input.code);
        if (await seriesCodeTaken(tx, ctx.companyId, input.code)) {
          throw codeTaken('invoice_series', null, 'invoice_series.created');
        }
        const created = await tx.invoiceSeries.create({
          data: {
            companyId: ctx.companyId,
            code: input.code,
            documentType: input.documentType,
            prefix: input.prefix,
            nextNumber: input.nextNumber ?? 1,
            padding: input.padding ?? 4,
            active: true,
          },
        });
        await this.audit(tx, ctx, meta, 'invoice_series.created', 'invoice_series', created.id, {
          code: created.code,
          documentType: created.documentType,
        });
        return toSeries(created, false);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateSeries(
    ctx: RequestContext,
    seriesId: string,
    input: SeriesPatch,
    meta: RequestMeta,
  ): Promise<SeriesView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        // Lock order: company, then the series. Company edits take the company row first too.
        const company = await lockCompanyForShare(tx, ctx.companyId);
        const current = await this.lockSeries(tx, ctx.companyId, seriesId);
        if (current.version !== input.expectedVersion) {
          throw versionConflict('invoice_series', current.id, 'invoice_series.updated');
        }
        const hasIssued = await seriesHasIssued(tx, ctx.companyId, current.id);
        const fields = seriesFields(current, input);
        if (fields.length === 0) {
          return toSeries(current, hasIssued);
        }
        const locked = fields.filter((field) => SERIES_LOCKED_FIELDS.has(field));
        if (locked.length > 0 && hasIssued) {
          throw new CommerceError(
            409,
            'series_in_use',
            'invoice_series',
            current.id,
            'A number was issued from this series. Its prefix, padding and next number cannot change.',
            'invoice_series.updated',
            { fields: locked },
          );
        }
        if (input.nextNumber !== undefined && input.nextNumber < current.nextNumber) {
          throw new CommerceError(
            422,
            'next_number_lowered',
            'invoice_series',
            current.id,
            'The next number can only be raised.',
            'invoice_series.updated',
          );
        }
        if (input.active === false && isDefaultSeries(company, current.id)) {
          throw new CommerceError(
            409,
            'series_is_default',
            'invoice_series',
            current.id,
            'This series is a company default. Choose another default first.',
            'invoice_series.updated',
          );
        }
        if (fields.includes('code')) {
          await lockCode(tx, 'invoice_series', ctx.companyId, input.code ?? current.code);
          if (await seriesCodeTaken(tx, ctx.companyId, input.code ?? current.code, current.id)) {
            throw codeTaken('invoice_series', current.id, 'invoice_series.updated');
          }
        }
        const written = await tx.invoiceSeries.updateMany({
          where: { id: current.id, companyId: ctx.companyId, version: input.expectedVersion },
          data: {
            ...(fields.includes('code') ? { code: input.code } : {}),
            ...(fields.includes('prefix') ? { prefix: input.prefix } : {}),
            ...(fields.includes('padding') ? { padding: input.padding } : {}),
            ...(fields.includes('nextNumber') ? { nextNumber: input.nextNumber } : {}),
            ...(fields.includes('active') ? { active: input.active } : {}),
            version: { increment: 1 },
          },
        });
        if (written.count !== 1) {
          throw versionConflict('invoice_series', current.id, 'invoice_series.updated');
        }
        const saved = await tx.invoiceSeries.findFirstOrThrow({
          where: { id: current.id, companyId: ctx.companyId },
        });
        await this.audit(tx, ctx, meta, 'invoice_series.updated', 'invoice_series', saved.id, {
          fields,
        });
        return toSeries(saved, hasIssued);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async listBankAccounts(ctx: RequestContext): Promise<BankAccountView[]> {
    const actor = requireActor(ctx);
    return this.tenant.run(this.context(ctx, actor), (tx) =>
      tx.companyBankAccount.findMany({
        where: { companyId: ctx.companyId },
        orderBy: [{ active: 'desc' }, { bankName: 'asc' }, { id: 'asc' }],
        select: bankSelect,
      }),
    );
  }

  async createBankAccount(
    ctx: RequestContext,
    input: BankAccountCreate,
    meta: RequestMeta,
  ): Promise<BankAccountView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        await lockBankAccounts(tx, ctx.companyId);
        const shown = input.shownOnInvoices === true;
        if (shown) {
          await this.hideOtherAccounts(tx, ctx, meta, null);
        }
        const created = await tx.companyBankAccount.create({
          data: {
            companyId: ctx.companyId,
            bankName: input.bankName,
            accountHolder: input.accountHolder,
            iban: input.iban,
            bic: input.bic ?? null,
            shownOnInvoices: shown,
            active: true,
          },
          select: bankSelect,
        });
        await this.audit(
          tx,
          ctx,
          meta,
          'bank_account.created',
          'company_bank_account',
          created.id,
          {
            shownOnInvoices: shown,
          },
        );
        return created;
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async updateBankAccount(
    ctx: RequestContext,
    accountId: string,
    input: BankAccountPatch,
    meta: RequestMeta,
  ): Promise<BankAccountView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenant.run(this.context(ctx, actor), async (tx) => {
        await lockBankAccounts(tx, ctx.companyId);
        const current = await this.findBankAccount(tx, ctx.companyId, accountId);
        if (current.version !== input.expectedVersion) {
          throw versionConflict('company_bank_account', current.id, 'bank_account.updated');
        }
        const active = input.active ?? current.active;
        // A deactivated account is never shown on invoices.
        const shownOnInvoices = active ? (input.shownOnInvoices ?? current.shownOnInvoices) : false;
        if (input.shownOnInvoices === true && !active) {
          throw new CommerceError(
            422,
            'account_inactive',
            'company_bank_account',
            current.id,
            'An inactive account cannot be shown on invoices.',
            'bank_account.updated',
          );
        }
        const fields = bankFields(current, input, shownOnInvoices);
        if (fields.length === 0) {
          return current;
        }
        if (shownOnInvoices && !current.shownOnInvoices) {
          await this.hideOtherAccounts(tx, ctx, meta, current.id);
        }
        const written = await tx.companyBankAccount.updateMany({
          where: { id: current.id, companyId: ctx.companyId, version: input.expectedVersion },
          data: {
            ...(fields.includes('bankName') ? { bankName: input.bankName } : {}),
            ...(fields.includes('accountHolder') ? { accountHolder: input.accountHolder } : {}),
            ...(fields.includes('iban') ? { iban: input.iban } : {}),
            ...(fields.includes('bic') ? { bic: input.bic } : {}),
            ...(fields.includes('active') ? { active } : {}),
            ...(fields.includes('shownOnInvoices') ? { shownOnInvoices } : {}),
            version: { increment: 1 },
          },
        });
        if (written.count !== 1) {
          throw versionConflict('company_bank_account', current.id, 'bank_account.updated');
        }
        const saved = await this.findBankAccount(tx, ctx.companyId, current.id);
        await this.audit(tx, ctx, meta, 'bank_account.updated', 'company_bank_account', saved.id, {
          fields,
        });
        return saved;
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  /** Clears "shown on invoices" from every other account, bumping and auditing each one. */
  private async hideOtherAccounts(
    tx: TenantTransaction,
    ctx: RequestContext,
    meta: RequestMeta,
    keepId: string | null,
  ): Promise<void> {
    const shown = await tx.companyBankAccount.findMany({
      where: {
        companyId: ctx.companyId,
        shownOnInvoices: true,
        ...(keepId ? { id: { not: keepId } } : {}),
      },
      select: { id: true },
    });
    for (const account of shown) {
      await tx.companyBankAccount.update({
        where: { id: account.id },
        data: { shownOnInvoices: false, version: { increment: 1 } },
      });
      await this.audit(tx, ctx, meta, 'bank_account.updated', 'company_bank_account', account.id, {
        fields: ['shownOnInvoices'],
      });
    }
  }

  private async lockTaxCode(
    tx: TenantTransaction,
    companyId: string,
    taxCodeId: string,
  ): Promise<TaxCodeRow> {
    const id = objectId(taxCodeId, 'tax_code', 'tax_code_not_found');
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM tax_code
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'tax_code_not_found', 'tax_code', id, 'Not found');
    }
    return tx.taxCode.findFirstOrThrow({ where: { id, companyId } });
  }

  private async lockSeries(
    tx: TenantTransaction,
    companyId: string,
    seriesId: string,
  ): Promise<SeriesRow> {
    const id = objectId(seriesId, 'invoice_series', 'series_not_found');
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM invoice_series
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    if (locked.length === 0) {
      throw new CommerceError(404, 'series_not_found', 'invoice_series', id, 'Not found');
    }
    return tx.invoiceSeries.findFirstOrThrow({ where: { id, companyId } });
  }

  private async findBankAccount(
    tx: TenantTransaction,
    companyId: string,
    accountId: string,
  ): Promise<BankRow> {
    const id = objectId(accountId, 'company_bank_account', 'bank_account_not_found');
    const row = await tx.companyBankAccount.findFirst({
      where: { id, companyId },
      select: bankSelect,
    });
    if (!row) {
      throw new CommerceError(
        404,
        'bank_account_not_found',
        'company_bank_account',
        id,
        'Not found',
      );
    }
    return row;
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  private async audit(
    tx: TenantTransaction,
    ctx: RequestContext,
    meta: RequestMeta,
    action: string,
    objectType: string,
    objectId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record(tx, {
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: requireActor(ctx),
      actorLabel: ctx.actorLabel,
      action,
      objectType,
      objectId,
      outcome: 'success',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details,
    });
  }

  private async fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.auditLog, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function objectId(value: string, objectType: string, reason: string): string {
  if (!isUuid(value)) {
    throw new CommerceError(404, reason, objectType, null, 'Not found');
  }
  return value.toLowerCase();
}

function versionConflict(objectType: string, id: string, action: string): CommerceError {
  return new CommerceError(409, 'version_conflict', objectType, id, 'version_conflict', action);
}

function codeTaken(objectType: string, id: string | null, action: string): CommerceError {
  return new CommerceError(409, 'code_taken', objectType, id, 'This code is already used.', action);
}

/** Serialises code checks per company and code, as brand names do. */
async function lockCode(
  tx: TenantTransaction,
  table: 'tax_code' | 'invoice_series',
  companyId: string,
  code: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${table} || ':' || ${companyId} || ':' || ${code}, 0::bigint))
  `;
}

/** Every bank-account write for a company runs one at a time, so at most one is shown on invoices. */
async function lockBankAccounts(tx: TenantTransaction, companyId: string): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended('company_bank_account:' || ${companyId}, 0::bigint))
  `;
}

async function lockCompanyForShare(
  tx: TenantTransaction,
  companyId: string,
): Promise<{
  defaultInvoiceSeriesId: string | null;
  defaultCreditNoteSeriesId: string | null;
  defaultQuoteSeriesId: string | null;
}> {
  const rows = await tx.$queryRaw<
    {
      default_invoice_series_id: string | null;
      default_credit_note_series_id: string | null;
      default_quote_series_id: string | null;
    }[]
  >`
    SELECT default_invoice_series_id::text, default_credit_note_series_id::text, default_quote_series_id::text
    FROM company WHERE id = ${companyId}::uuid
    FOR SHARE
  `;
  const row = rows[0];
  if (!row) {
    throw new CommerceError(404, 'company_not_found', 'company', companyId, 'Not found');
  }
  return {
    defaultInvoiceSeriesId: row.default_invoice_series_id,
    defaultCreditNoteSeriesId: row.default_credit_note_series_id,
    defaultQuoteSeriesId: row.default_quote_series_id,
  };
}

function isDefaultSeries(
  company: Awaited<ReturnType<typeof lockCompanyForShare>>,
  seriesId: string,
): boolean {
  return (
    company.defaultInvoiceSeriesId === seriesId ||
    company.defaultCreditNoteSeriesId === seriesId ||
    company.defaultQuoteSeriesId === seriesId
  );
}

async function taxCodeInUse(
  tx: TenantTransaction,
  companyId: string,
  taxCodeId: string,
): Promise<boolean> {
  const line = await tx.invoiceLine.findFirst({
    where: { companyId, taxCodeId },
    select: { id: true },
  });
  return line !== null;
}

async function seriesHasIssued(
  tx: TenantTransaction,
  companyId: string,
  seriesId: string,
): Promise<boolean> {
  const issued = await tx.invoice.findFirst({
    where: { companyId, seriesId, numberSeq: { not: null } },
    select: { id: true },
  });
  return issued !== null;
}

async function taxCodeTaken(
  tx: TenantTransaction,
  companyId: string,
  code: string,
  exceptId?: string,
): Promise<boolean> {
  const row = await tx.taxCode.findFirst({
    where: { companyId, code, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return row !== null;
}

async function seriesCodeTaken(
  tx: TenantTransaction,
  companyId: string,
  code: string,
  exceptId?: string,
): Promise<boolean> {
  const row = await tx.invoiceSeries.findFirst({
    where: { companyId, code, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return row !== null;
}

function taxCodeFields(current: TaxCodeRow, input: TaxCodePatch): string[] {
  const fields: string[] = [];
  if (input.code !== undefined && input.code !== current.code) {
    fields.push('code');
  }
  if (input.name !== undefined && input.name !== current.name) {
    fields.push('name');
  }
  if (input.ratePercent !== undefined && input.ratePercent !== fixed(current.ratePercent, 4)) {
    fields.push('ratePercent');
  }
  if (input.kind !== undefined && input.kind !== current.kind) {
    fields.push('kind');
  }
  if (input.noteEn !== undefined && input.noteEn !== current.noteEn) {
    fields.push('noteEn');
  }
  if (input.noteEl !== undefined && input.noteEl !== current.noteEl) {
    fields.push('noteEl');
  }
  if (input.deadlineRule !== undefined && input.deadlineRule !== current.deadlineRule) {
    fields.push('deadlineRule');
  }
  if (input.active !== undefined && input.active !== current.active) {
    fields.push('active');
  }
  return fields;
}

function seriesFields(current: SeriesRow, input: SeriesPatch): string[] {
  const fields: string[] = [];
  if (input.code !== undefined && input.code !== current.code) {
    fields.push('code');
  }
  if (input.prefix !== undefined && input.prefix !== current.prefix) {
    fields.push('prefix');
  }
  if (input.padding !== undefined && input.padding !== current.padding) {
    fields.push('padding');
  }
  if (input.nextNumber !== undefined && input.nextNumber !== current.nextNumber) {
    fields.push('nextNumber');
  }
  if (input.active !== undefined && input.active !== current.active) {
    fields.push('active');
  }
  return fields;
}

function bankFields(current: BankRow, input: BankAccountPatch, shownOnInvoices: boolean): string[] {
  const fields: string[] = [];
  if (input.bankName !== undefined && input.bankName !== current.bankName) {
    fields.push('bankName');
  }
  if (input.accountHolder !== undefined && input.accountHolder !== current.accountHolder) {
    fields.push('accountHolder');
  }
  if (input.iban !== undefined && input.iban !== current.iban) {
    fields.push('iban');
  }
  if (input.bic !== undefined && input.bic !== current.bic) {
    fields.push('bic');
  }
  if (input.active !== undefined && input.active !== current.active) {
    fields.push('active');
  }
  if (shownOnInvoices !== current.shownOnInvoices) {
    fields.push('shownOnInvoices');
  }
  return fields;
}

function toTaxCode(row: TaxCodeRow, inUse: boolean): TaxCodeView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    ratePercent: fixed(row.ratePercent, 4),
    kind: row.kind,
    noteEn: row.noteEn,
    noteEl: row.noteEl,
    deadlineRule: row.deadlineRule,
    isExample: row.isExample,
    active: row.active,
    inUse,
    version: row.version,
  };
}

function toSeries(row: SeriesRow, hasIssued: boolean): SeriesView {
  return {
    id: row.id,
    code: row.code,
    documentType: row.documentType,
    prefix: row.prefix,
    nextNumber: row.nextNumber,
    padding: row.padding,
    active: row.active,
    hasIssued,
    version: row.version,
  };
}
