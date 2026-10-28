import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertDatabaseNameIsTest, assertTestDatabaseUrls } from '../../../tools/test-db-guard.mjs';
import { createPrismaClient, type PrismaClient } from './client';
import { RLS_EXEMPT_TABLES } from './rls-tables';
import { TenantDb, type TenantTransaction } from './tenant-db';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });
const testDatabaseRefusal = assertTestDatabaseUrls();
if (testDatabaseRefusal) {
  throw new Error(testDatabaseRefusal);
}

const RLS_TABLES = [
  'allocation',
  'audit_event',
  'brand',
  'client',
  'client_address',
  'client_contact',
  'company_bank_account',
  'gift_message_template',
  'integration_credential',
  'integration_inbox',
  'idempotency_record',
  'invoice',
  'invoice_delivery',
  'invoice_line',
  'invoice_series',
  'invoice_tax_summary',
  'location',
  'order_note',
  'payment',
  'print_job',
  'printer',
  'printer_mapping',
  'product',
  'refund',
  'sales_order',
  'sales_order_line',
  'store',
  'store_connection',
  'stored_file',
  'tax_code',
] as const;

type Graph = Record<(typeof RLS_TABLES)[number], string>;

describe('row level security', () => {
  let app: PrismaClient;
  let owner: PrismaClient;
  let appTenant: TenantDb;
  let ownerTenant: TenantDb;
  let companyA = '';
  let companyB = '';
  let userId = '';
  let graphA: Graph;

  /** A draft with one line and one tax-summary row, copied from the fixture graph. */
  async function draftOf(tx: TenantTransaction, documentType?: 'quote') {
    const source = await tx.invoice.findUniqueOrThrow({ where: { id: graphA.invoice } });
    const line = await tx.invoiceLine.findUniqueOrThrow({ where: { id: graphA.invoice_line } });
    const summary = await tx.invoiceTaxSummary.findUniqueOrThrow({
      where: { id: graphA.invoice_tax_summary },
    });
    const draft = await tx.invoice.create({
      data: {
        companyId: companyA,
        documentType: documentType ?? 'invoice',
        clientId: source.clientId,
        currency: source.currency,
        language: source.language,
        pricesIncludeTax: source.pricesIncludeTax,
        subtotal: source.subtotal,
        discountTotal: source.discountTotal,
        netTotal: source.netTotal,
        taxTotal: source.taxTotal,
        total: source.total,
        createdById: userId,
      },
    });
    await tx.invoiceLine.create({
      data: {
        companyId: companyA,
        invoiceId: draft.id,
        position: line.position,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        taxCodeId: line.taxCodeId,
        taxRatePercent: line.taxRatePercent,
        lineSubtotal: line.lineSubtotal,
        lineDiscount: line.lineDiscount,
        lineNet: line.lineNet,
        lineGross: line.lineGross,
      },
    });
    await tx.invoiceTaxSummary.create({
      data: {
        companyId: companyA,
        invoiceId: draft.id,
        taxCodeId: summary.taxCodeId,
        taxRatePercent: summary.taxRatePercent,
        net: summary.net,
        tax: summary.tax,
        gross: summary.gross,
      },
    });
    return draft;
  }

  async function creditOf(tx: TenantTransaction, originalId: string) {
    const original = await tx.invoice.findUniqueOrThrow({ where: { id: originalId } });
    const line = await tx.invoiceLine.findFirstOrThrow({ where: { invoiceId: originalId } });
    const summary = await tx.invoiceTaxSummary.findFirstOrThrow({
      where: { invoiceId: originalId },
    });
    const credit = await tx.invoice.create({
      data: {
        companyId: companyA,
        documentType: 'credit_note',
        clientId: original.clientId,
        currency: original.currency,
        language: original.language,
        pricesIncludeTax: original.pricesIncludeTax,
        subtotal: original.subtotal,
        discountTotal: original.discountTotal,
        netTotal: original.netTotal,
        taxTotal: original.taxTotal,
        total: original.total,
        createdById: userId,
        creditedInvoiceId: original.id,
        creditReason: 'Return (fictional)',
      },
    });
    await tx.invoiceLine.create({
      data: {
        ...line,
        id: randomUUID(),
        invoiceId: credit.id,
        creditedLineId: line.id,
        taxSnapshot: undefined,
      },
    });
    await tx.invoiceTaxSummary.create({
      data: { ...summary, id: randomUUID(), invoiceId: credit.id, taxSnapshot: undefined },
    });
    return credit;
  }

  let graphB: Graph;

  beforeAll(async () => {
    const appUrl = requiredEnv('DATABASE_URL');
    const ownerUrl = requiredEnv('DATABASE_URL_OWNER');
    expect(new URL(appUrl).username).toBe('bp_app');
    expect(new URL(ownerUrl).username).toBe('bp_owner');
    app = createPrismaClient(appUrl);
    owner = createPrismaClient(ownerUrl);
    await assertConnectedDatabase(app, 'DATABASE_URL');
    await assertConnectedDatabase(owner, 'DATABASE_URL_OWNER');
    appTenant = new TenantDb(app);
    ownerTenant = new TenantDb(owner);

    const user = await app.userAccount.create({
      data: {
        email: `rls-${randomUUID()}@example.test`,
        displayName: 'RLS Fixture (fictional)',
      },
    });
    userId = user.id;
    const createdA = await app.company.create({
      data: {
        legalName: `RLS Company A ${randomUUID()} (fictional)`,
        tradingName: 'RLS A',
        address: { line1: '1 Demo Street', city: 'Nicosia', countryCode: 'CY' },
        isFictional: true,
      },
    });
    const createdB = await app.company.create({
      data: {
        legalName: `RLS Company B ${randomUUID()} (fictional)`,
        tradingName: 'RLS B',
        address: { line1: '1 Demo Street', city: 'Larnaca', countryCode: 'CY' },
        isFictional: true,
      },
    });
    companyA = createdA.id;
    companyB = createdB.id;
    const correlationId = randomUUID();
    graphA = await appTenant.run({ companyId: companyA, actor: userId, correlationId }, (tx) =>
      insertGraph(tx, companyA, userId, 'a'),
    );
    graphB = await appTenant.run({ companyId: companyB, actor: userId, correlationId }, (tx) =>
      insertGraph(tx, companyB, userId, 'b'),
    );
  });

  afterAll(async () => {
    await app.$disconnect();
    await owner.$disconnect();
  });

  it('connects as bp_app without bypassrls', async () => {
    const rows = await app.$queryRaw<
      { db_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      SELECT current_user AS db_user, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `;
    expect(rows[0]).toMatchObject({ db_user: 'bp_app', rolsuper: false, rolbypassrls: false });
  });

  it.each([
    { isolation: 'repeatable_read' as const, expected: 'repeatable read' },
    { isolation: undefined, expected: 'read committed' },
  ])('uses $expected transaction isolation', async ({ isolation, expected }) => {
    const rows = await appTenant.run(
      { companyId: companyA, actor: userId, correlationId: randomUUID() },
      (tx) => tx.$queryRaw<{ transaction_isolation: string }[]>`SHOW transaction_isolation`,
      isolation ? { isolation } : undefined,
    );
    expect(rows).toEqual([{ transaction_isolation: expected }]);
  });

  it('returns no rows from RLS tables when no company context is set', async () => {
    for (const table of RLS_TABLES) {
      expect(await count(app, table)).toBe(0);
    }
  });

  it('shows only the current company, including to the table owner when context is set', async () => {
    const ownerWithoutContext = await count(owner, 'brand');
    expect(ownerWithoutContext).toBe(0);
    await appTenant.run(
      { companyId: companyA, actor: userId, correlationId: randomUUID() },
      async (tx) => {
        for (const table of RLS_TABLES) {
          expect(await countWhereId(tx, table, graphA[table]), `${table} A`).toBe(1);
          expect(await countWhereId(tx, table, graphB[table]), `${table} B`).toBe(0);
        }
      },
    );
  });

  it('rejects an insert that names the other company', async () => {
    await expect(
      appTenant.run({ companyId: companyA, actor: userId, correlationId: randomUUID() }, (tx) =>
        tx.brand.create({ data: { companyId: companyB, name: 'cross-tenant' } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('keeps delivery records append-only and paper deliveries with their kept copy', async () => {
    const grants = await app.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'bp_app' AND table_name = 'invoice_delivery'
    `;
    expect(grants.map((row) => row.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceDelivery.update({ where: { id: graphA.invoice_delivery }, data: { note: 'x' } }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceDelivery.delete({ where: { id: graphA.invoice_delivery } }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceDelivery.create({
          data: {
            companyId: companyA,
            invoiceId: graphA.invoice,
            method: 'handed_over',
            deliveredOn: new Date('2026-10-27T00:00:00Z'),
            paperCopyKept: false,
            recordedById: userId,
          },
        }),
      ),
    ).rejects.toThrow(/invoice_delivery_paper_copy_check/);
  });

  it('refuses any change to a sealed stored file, for every role', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    const marker = randomUUID();
    const file = await appTenant.run(ctx, (tx) =>
      tx.storedFile.create({
        data: {
          companyId: companyA,
          kind: 'invoice_pdf',
          storageKey: `companies/${companyA}/test/sealed-${marker}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: 4,
          sha256: '0'.repeat(64),
          createdById: userId,
        },
      }),
    );
    await appTenant.run(ctx, (tx) =>
      tx.storedFile.update({ where: { id: file.id }, data: { sealed: true } }),
    );
    for (const tenant of [appTenant, ownerTenant]) {
      await expect(
        tenant.run(ctx, (tx) =>
          tx.storedFile.update({ where: { id: file.id }, data: { sha256: '1'.repeat(64) } }),
        ),
      ).rejects.toThrow(/sealed stored file is immutable/);
      await expect(
        tenant.run(ctx, (tx) =>
          tx.storedFile.update({ where: { id: file.id }, data: { sealed: false } }),
        ),
      ).rejects.toThrow(/sealed stored file is immutable/);
      await expect(
        tenant.run(ctx, (tx) => tx.storedFile.delete({ where: { id: file.id } })),
      ).rejects.toThrow(/sealed stored file is immutable/);
    }
    // TRUNCATE skips row triggers, so it has its own guard, which CASCADE cannot get past.
    for (const statement of [
      'TRUNCATE stored_file CASCADE',
      'TRUNCATE invoice CASCADE',
      'TRUNCATE invoice_line',
      'TRUNCATE invoice_tax_summary',
      'TRUNCATE invoice_delivery',
    ]) {
      await expect(owner.$executeRawUnsafe(statement)).rejects.toThrow(/is never truncated/);
    }
    await expect(app.$executeRawUnsafe('TRUNCATE stored_file CASCADE')).rejects.toThrow();
    const still = await ownerTenant.run(ctx, (tx) =>
      tx.storedFile.findUnique({ where: { id: file.id }, select: { sealed: true } }),
    );
    expect(still?.sealed).toBe(true);
  });

  it('rejects update and delete of audit_event', async () => {
    const triggers = await app.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'audit_event'::regclass AND NOT tgisinternal
    `;
    expect(triggers.map((row) => row.tgname)).toContain('audit_event_no_update_delete');
    const grants = await app.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee = 'bp_app' AND table_name = 'audit_event'
    `;
    expect(grants.map((row) => row.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);

    await expect(
      appTenant.run({ companyId: companyA, actor: userId, correlationId: randomUUID() }, (tx) =>
        tx.auditEvent.update({ where: { id: graphA.audit_event }, data: { action: 'tamper' } }),
      ),
    ).rejects.toThrow();
    await expect(
      app.$executeRaw`DELETE FROM audit_event WHERE id = ${graphA.audit_event}::uuid`,
    ).rejects.toThrow();
  });

  it('issues a document only from a draft, complete, with its own sealed PDF', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    for (const tenant of [appTenant, ownerTenant]) {
      // The trigger runs before the CHECK, so a bare status change fails on the PDF first.
      await expect(
        tenant.run(ctx, async (tx) => {
          const draft = await draftOf(tx);
          await tx.invoice.update({ where: { id: draft.id }, data: { status: 'issued' } });
        }),
      ).rejects.toThrow(/needs its own sealed PDF/);
      for (const supplyDate of [null, '2026-10-29']) {
        await expect(
          tenant.run(ctx, async (tx) => {
            const draft = await draftOf(tx);
            await markIssued(tx, companyA, draft.id, userId, { supplyDate });
          }),
        ).rejects.toThrow(/invoice_issued_complete_check/);
      }
      // A snapshot must hold the particulars, not merely be present. Tabs and newlines are blank.
      for (const sellerSnapshot of [
        'null',
        '{}',
        '{"legalName":"Demo","vatNumber":" ","address":{}}',
        '{"legalName":"\\t\\n","vatNumber":"CY00000000X","address":{"line1":"1 Demo Street","city":"Nicosia"}}',
      ]) {
        await expect(
          tenant.run(ctx, async (tx) => {
            const draft = await draftOf(tx);
            await markIssued(tx, companyA, draft.id, userId, { sellerSnapshot });
          }),
        ).rejects.toThrow(/invoice_issued_complete_check/);
      }
      await expect(
        tenant.run(ctx, async (tx) => {
          const draft = await draftOf(tx);
          await markIssued(tx, companyA, draft.id, userId, { lineSnapshots: false });
        }),
      ).rejects.toThrow(/needs lines, each with a description and its tax snapshot/);
      await expect(
        tenant.run(ctx, async (tx) => {
          const draft = await draftOf(tx);
          await tx.invoiceLine.updateMany({
            where: { invoiceId: draft.id },
            data: { description: '\t\n' },
          });
          await markIssued(tx, companyA, draft.id, userId);
        }),
      ).rejects.toThrow(/needs lines, each with a description and its tax snapshot/);
      await expect(
        tenant.run(ctx, async (tx) => {
          const draft = await draftOf(tx);
          await markIssued(tx, companyA, draft.id, userId, { sealed: false });
        }),
      ).rejects.toThrow(/needs its own sealed PDF/);
      await expect(
        tenant.run(ctx, async (tx) => {
          const draft = await draftOf(tx);
          await markIssued(tx, companyA, draft.id, userId, { sourceId: graphA.invoice });
        }),
      ).rejects.toThrow(/needs its own sealed PDF/);
      await expect(
        tenant.run(ctx, async (tx) => {
          const quote = await draftOf(tx, 'quote');
          await markIssued(tx, companyA, quote.id, userId);
        }),
      ).rejects.toThrow(/invoice_issued_complete_check/);
      await expect(
        tenant.run(ctx, async (tx) => {
          const source = await tx.invoice.findUniqueOrThrow({ where: { id: graphA.invoice } });
          await tx.invoice.create({
            data: {
              companyId: companyA,
              documentType: 'invoice',
              status: 'issued',
              clientId: source.clientId,
              currency: source.currency,
              language: source.language,
              pricesIncludeTax: source.pricesIncludeTax,
              subtotal: source.subtotal,
              discountTotal: source.discountTotal,
              netTotal: source.netTotal,
              taxTotal: source.taxTotal,
              total: source.total,
              createdById: userId,
            },
          });
        }),
      ).rejects.toThrow(/never inserted as issued/);
    }
    // The same steps with a sealed PDF of its own succeed.
    const issued = await appTenant.run(ctx, async (tx) => {
      const draft = await draftOf(tx);
      expect(await markIssued(tx, companyA, draft.id, userId)).toBe(1);
      return tx.invoice.findUniqueOrThrow({ where: { id: draft.id }, select: { status: true } });
    });
    expect(issued.status).toBe('issued');
  });

  it('ties a credit note to an issued invoice and each credit line to one of its lines', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    const issued = await appTenant.run(ctx, async (tx) => {
      const draft = await draftOf(tx);
      expect(await markIssued(tx, companyA, draft.id, userId)).toBe(1);
      const line = await tx.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.id } });
      return { id: draft.id, lineId: line.id };
    });
    const headerOf = async (
      tx: TenantTransaction,
      fields: {
        documentType?: 'invoice' | 'quote' | 'credit_note';
        creditedInvoiceId?: string | null;
        creditReason?: string | null;
        sourceQuoteId?: string | null;
      },
    ) => {
      const source = await tx.invoice.findUniqueOrThrow({ where: { id: graphA.invoice } });
      return tx.invoice.create({
        data: {
          companyId: companyA,
          documentType: fields.documentType ?? 'credit_note',
          clientId: source.clientId,
          currency: source.currency,
          language: source.language,
          pricesIncludeTax: source.pricesIncludeTax,
          subtotal: source.subtotal,
          discountTotal: source.discountTotal,
          netTotal: source.netTotal,
          taxTotal: source.taxTotal,
          total: source.total,
          createdById: userId,
          creditedInvoiceId: fields.creditedInvoiceId ?? null,
          creditReason: fields.creditReason ?? null,
          sourceQuoteId: fields.sourceQuoteId ?? null,
        },
      });
    };
    const lineOf = async (
      tx: TenantTransaction,
      invoiceId: string,
      creditedLineId: string | null,
    ) => {
      const line = await tx.invoiceLine.findUniqueOrThrow({ where: { id: graphA.invoice_line } });
      return tx.invoiceLine.create({
        data: {
          companyId: companyA,
          invoiceId,
          position: 1,
          kind: line.kind,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent,
          taxCodeId: line.taxCodeId,
          taxRatePercent: line.taxRatePercent,
          lineSubtotal: line.lineSubtotal,
          lineDiscount: line.lineDiscount,
          lineNet: line.lineNet,
          lineGross: line.lineGross,
          creditedLineId,
        },
      });
    };
    const refuses = async (work: (tx: TenantTransaction) => Promise<unknown>, message: RegExp) => {
      await expect(appTenant.run(ctx, work)).rejects.toThrow(message);
    };

    await refuses((tx) => headerOf(tx, { creditReason: 'Damaged' }), /invoice_credit_note_check/);
    await refuses(
      (tx) => headerOf(tx, { creditedInvoiceId: issued.id, creditReason: '\t\n' }),
      /invoice_credit_note_check/,
    );
    await refuses(
      (tx) => headerOf(tx, { documentType: 'invoice', creditReason: 'Not a credit note' }),
      /invoice_credit_note_check/,
    );
    await refuses(
      async (tx) =>
        headerOf(tx, { creditedInvoiceId: (await draftOf(tx)).id, creditReason: 'Draft' }),
      /a credit note credits an issued invoice/,
    );
    const credit = await appTenant.run(ctx, async (tx) => {
      const note = await headerOf(tx, { creditedInvoiceId: issued.id, creditReason: 'Damaged' });
      await lineOf(tx, note.id, issued.lineId);
      return note;
    });
    await refuses((tx) => lineOf(tx, credit.id, null), /credits a line of the credited invoice/);
    await refuses(
      (tx) => lineOf(tx, credit.id, graphA.invoice_line),
      /credits a line of the credited invoice/,
    );
    await refuses(
      async (tx) => lineOf(tx, (await draftOf(tx)).id, issued.lineId),
      /only a credit note line credits another line/,
    );
    await refuses(
      async (tx) =>
        tx.invoice.update({
          where: { id: credit.id },
          data: { creditedInvoiceId: (await draftOf(tx)).id },
        }),
      /never change/,
    );
    await refuses(
      (tx) => tx.invoice.update({ where: { id: issued.id }, data: { documentType: 'quote' } }),
      /never change|immutable/,
    );
    await refuses(
      async (tx) =>
        tx.invoice.update({
          where: { id: (await draftOf(tx, 'quote')).id },
          data: { documentType: 'invoice' },
        }),
      /never change/,
    );
    // A credit line keeps its original line, and carries that line's prices and rates.
    const creditLine = await appTenant.run(ctx, (tx) =>
      tx.invoiceLine.findFirstOrThrow({ where: { invoiceId: credit.id } }),
    );
    const secondLine = await appTenant.run(ctx, async (tx) => {
      const other = await draftOf(tx);
      expect(await markIssued(tx, companyA, other.id, userId)).toBe(1);
      return tx.invoiceLine.findFirstOrThrow({ where: { invoiceId: other.id } });
    });
    await refuses(
      (tx) =>
        tx.invoiceLine.update({
          where: { id: creditLine.id },
          data: { creditedLineId: secondLine.id },
        }),
      /keeps the line it credits/,
    );
    await refuses(
      (tx) =>
        tx.invoiceLine.update({ where: { id: creditLine.id }, data: { unitPrice: '0.0001' } }),
      /at its prices and rates/,
    );
    await refuses(
      (tx) => headerOf(tx, { documentType: 'invoice', sourceQuoteId: issued.id }),
      /converted from a quote/,
    );
    await refuses(
      async (tx) =>
        headerOf(tx, { documentType: 'quote', sourceQuoteId: (await draftOf(tx, 'quote')).id }),
      /invoice_source_quote_check/,
    );
  });

  it('issues credit notes within the invoice they credit, with its frozen tax treatment', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    /** An issued invoice of one line: 1 × 1.00 at 19 %, net 1.00, tax 0.19, gross 1.19. */
    const issuedOriginal = () =>
      appTenant.run(ctx, async (tx) => {
        const draft = await draftOf(tx);
        expect(await markIssued(tx, companyA, draft.id, userId)).toBe(1);
        const line = await tx.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.id } });
        return { id: draft.id, line };
      });
    /** A draft credit note of `quantity` of the line, whose summary claims `net`. */
    const draftCredit = (
      original: { id: string; line: { id: string; taxCodeId: string } },
      quantity: string,
      net: string,
    ) =>
      appTenant.run(ctx, async (tx) => {
        const source = await tx.invoiceLine.findUniqueOrThrow({ where: { id: original.line.id } });
        const note = await tx.invoice.create({
          data: {
            companyId: companyA,
            documentType: 'credit_note',
            clientId: (await tx.invoice.findUniqueOrThrow({ where: { id: original.id } })).clientId,
            currency: 'EUR',
            language: 'en',
            pricesIncludeTax: false,
            subtotal: net,
            discountTotal: '0.00',
            netTotal: net,
            taxTotal: '0.00',
            total: net,
            createdById: userId,
            creditedInvoiceId: original.id,
            creditReason: 'Returned (fictional)',
          },
        });
        await tx.invoiceLine.create({
          data: {
            companyId: companyA,
            invoiceId: note.id,
            position: 1,
            kind: source.kind,
            description: source.description,
            quantity,
            unit: source.unit,
            unitPrice: source.unitPrice,
            discountPercent: source.discountPercent,
            taxCodeId: source.taxCodeId,
            taxRatePercent: source.taxRatePercent,
            lineSubtotal: net,
            lineDiscount: '0.00',
            lineNet: net,
            lineGross: net,
            creditedLineId: source.id,
          },
        });
        await tx.invoiceTaxSummary.create({
          data: {
            companyId: companyA,
            invoiceId: note.id,
            taxCodeId: source.taxCodeId,
            taxRatePercent: source.taxRatePercent,
            net,
            tax: '0.00',
            gross: net,
          },
        });
        return note.id;
      });
    const issue = (id: string, options: { taxName?: string } = {}) =>
      appTenant.run(ctx, (tx) => markIssued(tx, companyA, id, userId, options));
    const exceeds = async (id: string) => {
      const [row] = await appTenant.run(
        ctx,
        (tx) =>
          tx.$queryRaw<{ exceeds: boolean }[]>`
          SELECT credit_note_exceeds_original(${companyA}::uuid, ${id}::uuid) AS exceeds
        `,
      );
      return row?.exceeds;
    };

    // Quantities: draft credit notes count only once issued, then together.
    const first = await issuedOriginal();
    const whole = await draftCredit(first, '1.0000', '1.00');
    const half = await draftCredit(first, '0.5000', '0.50');
    expect(await exceeds(half)).toBe(false);
    expect(await issue(whole)).toBe(1);
    expect(await exceeds(half)).toBe(true);
    await expect(issue(half)).rejects.toThrow(/never credit more than the invoice/);

    // A credit of nothing, or a negative one that would give room back, is refused.
    for (const [quantity, net] of [
      ['0.0000', '0.00'],
      ['-1.0000', '-1.00'],
    ] as const) {
      const negative = await draftCredit(await issuedOriginal(), quantity, net);
      await expect(issue(negative)).rejects.toThrow(/positive quantities and amounts/);
    }

    // Tax groups: two halves of the line that each claim the whole net are refused second.
    const second = await issuedOriginal();
    const claimsAll = await draftCredit(second, '0.5000', '1.00');
    const claimsAllAgain = await draftCredit(second, '0.5000', '1.00');
    expect(await issue(claimsAll)).toBe(1);
    await expect(issue(claimsAllAgain)).rejects.toThrow(/never credit more than the invoice/);

    // The tax treatment is the one frozen on the invoice, never another.
    const third = await issuedOriginal();
    const renamed = await draftCredit(third, '1.0000', '1.00');
    await expect(issue(renamed, { taxName: 'Renamed since' })).rejects.toThrow(
      /tax treatment frozen on the invoice/,
    );
    expect(await issue(renamed)).toBe(1);
  });

  it('rejects changes to an issued invoice, its lines and its tax summary', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    const other = await appTenant.run(ctx, async (tx) => {
      await tx.invoice.update({ where: { id: graphA.invoice }, data: { notes: 'still a draft' } });
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: graphA.invoice } });
      const sourceLine = await tx.invoiceLine.findUniqueOrThrow({
        where: { id: graphA.invoice_line },
      });
      const sourceSummary = await tx.invoiceTaxSummary.findUniqueOrThrow({
        where: { id: graphA.invoice_tax_summary },
      });
      const draft = await tx.invoice.create({
        data: {
          companyId: companyA,
          documentType: invoice.documentType,
          clientId: invoice.clientId,
          currency: invoice.currency,
          language: invoice.language,
          pricesIncludeTax: invoice.pricesIncludeTax,
          subtotal: invoice.subtotal,
          discountTotal: invoice.discountTotal,
          netTotal: invoice.netTotal,
          taxTotal: invoice.taxTotal,
          total: invoice.total,
          notes: 'second draft',
          createdById: userId,
        },
      });
      const draftLine = await tx.invoiceLine.create({
        data: {
          companyId: companyA,
          invoiceId: draft.id,
          position: sourceLine.position,
          kind: sourceLine.kind,
          description: sourceLine.description,
          quantity: sourceLine.quantity,
          unit: sourceLine.unit,
          unitPrice: sourceLine.unitPrice,
          discountPercent: sourceLine.discountPercent,
          taxCodeId: sourceLine.taxCodeId,
          taxRatePercent: sourceLine.taxRatePercent,
          lineSubtotal: sourceLine.lineSubtotal,
          lineDiscount: sourceLine.lineDiscount,
          lineNet: sourceLine.lineNet,
          lineGross: sourceLine.lineGross,
        },
      });
      const draftSummary = await tx.invoiceTaxSummary.create({
        data: {
          companyId: companyA,
          invoiceId: draft.id,
          taxCodeId: sourceSummary.taxCodeId,
          taxRatePercent: sourceSummary.taxRatePercent,
          net: sourceSummary.net,
          tax: sourceSummary.tax,
          gross: sourceSummary.gross,
        },
      });
      return {
        invoiceId: draft.id,
        lineId: draftLine.id,
        summaryId: draftSummary.id,
        taxCodeId: sourceSummary.taxCodeId,
      };
    });

    await ownerTenant.run(ctx, (tx) => markIssued(tx, companyA, graphA.invoice, userId));

    const immutable = /immutable/i;
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoice.update({ where: { id: graphA.invoice }, data: { notes: 'tamper' } }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) => tx.invoice.delete({ where: { id: graphA.invoice } })),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceLine.update({
          where: { id: graphA.invoice_line },
          data: { description: 'tamper' },
        }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) => tx.invoiceLine.delete({ where: { id: graphA.invoice_line } })),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceLine.create({
          data: {
            companyId: companyA,
            invoiceId: graphA.invoice,
            position: 2,
            kind: 'item',
            description: 'extra',
            quantity: '1.0000',
            unit: 'piece',
            unitPrice: '1.0000',
            discountPercent: '0.00',
            taxCodeId: other.taxCodeId,
            taxRatePercent: '19.0000',
            lineSubtotal: '1.00',
            lineDiscount: '0.00',
            lineNet: '1.00',
            lineGross: '1.00',
          },
        }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceLine.update({
          where: { id: graphA.invoice_line },
          data: { invoiceId: other.invoiceId },
        }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceLine.update({ where: { id: other.lineId }, data: { invoiceId: graphA.invoice } }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceTaxSummary.update({
          where: { id: graphA.invoice_tax_summary },
          data: { tax: '9.99' },
        }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceTaxSummary.delete({ where: { id: graphA.invoice_tax_summary } }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceTaxSummary.create({
          data: {
            companyId: companyA,
            invoiceId: graphA.invoice,
            taxCodeId: other.taxCodeId,
            taxRatePercent: '19.0000',
            net: '1.00',
            tax: '0.19',
            gross: '1.19',
          },
        }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceTaxSummary.update({
          where: { id: graphA.invoice_tax_summary },
          data: { invoiceId: other.invoiceId },
        }),
      ),
    ).rejects.toThrow(immutable);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceTaxSummary.update({
          where: { id: other.summaryId },
          data: { invoiceId: graphA.invoice },
        }),
      ),
    ).rejects.toThrow(immutable);
  });

  it('blocks a line update until an in-flight issue commits, then rejects it', async () => {
    // draft → issued is allowed for bp_app. The trigger only rejects a row that is already
    // issued, so both sessions here are bp_app. bp_owner is not required for this race.
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    const draft = await appTenant.run(ctx, async (tx) => {
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: graphA.invoice } });
      const sourceLine = await tx.invoiceLine.findUniqueOrThrow({
        where: { id: graphA.invoice_line },
      });
      const created = await tx.invoice.create({
        data: {
          companyId: companyA,
          documentType: invoice.documentType,
          clientId: invoice.clientId,
          currency: invoice.currency,
          language: invoice.language,
          pricesIncludeTax: invoice.pricesIncludeTax,
          subtotal: invoice.subtotal,
          discountTotal: invoice.discountTotal,
          netTotal: invoice.netTotal,
          taxTotal: invoice.taxTotal,
          total: invoice.total,
          notes: 'race draft',
          createdById: userId,
        },
      });
      const line = await tx.invoiceLine.create({
        data: {
          companyId: companyA,
          invoiceId: created.id,
          position: sourceLine.position,
          kind: sourceLine.kind,
          description: sourceLine.description,
          quantity: sourceLine.quantity,
          unit: sourceLine.unit,
          unitPrice: sourceLine.unitPrice,
          discountPercent: sourceLine.discountPercent,
          taxCodeId: sourceLine.taxCodeId,
          taxRatePercent: sourceLine.taxRatePercent,
          lineSubtotal: sourceLine.lineSubtotal,
          lineDiscount: sourceLine.lineDiscount,
          lineNet: sourceLine.lineNet,
          lineGross: sourceLine.lineGross,
        },
      });
      const sourceSummary = await tx.invoiceTaxSummary.findUniqueOrThrow({
        where: { id: graphA.invoice_tax_summary },
      });
      await tx.invoiceTaxSummary.create({
        data: {
          companyId: companyA,
          invoiceId: created.id,
          taxCodeId: sourceSummary.taxCodeId,
          taxRatePercent: sourceSummary.taxRatePercent,
          net: sourceSummary.net,
          tax: sourceSummary.tax,
          gross: sourceSummary.gross,
        },
      });
      return { invoiceId: created.id, lineId: line.id };
    });

    const appUrl = requiredEnv('DATABASE_URL');
    const issuer = createPrismaClient(appUrl);
    const editor = createPrismaClient(appUrl);
    const watcher = createPrismaClient(postgresAdminUrl(appUrl));
    let releaseEditor = (): void => undefined;
    const editorStarted = new Promise<void>((resolve) => {
      releaseEditor = resolve;
    });
    const editorPromise = (async () => {
      await editorStarted;
      return editor.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
          await tx.$executeRaw`
            UPDATE invoice_line
            SET description = 'race'
            WHERE id = ${draft.lineId}::uuid
            /* bp-issued-race */
          `;
        },
        { timeout: 20_000, maxWait: 5_000 },
      );
    })();

    try {
      await issuer.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.company_id', ${companyA}, true)`;
          const updated = await markIssued(tx, companyA, draft.invoiceId, userId);
          if (updated !== 1) {
            throw new Error(`expected to lock one draft invoice, updated ${String(updated)}`);
          }
          releaseEditor();
          await waitForIssuedRaceLock(watcher);
        },
        { timeout: 20_000, maxWait: 5_000 },
      );
      await expect(editorPromise).rejects.toThrow(/immutable/i);
    } finally {
      releaseEditor();
      await editorPromise.catch(() => undefined);
      await issuer.$disconnect();
      await editor.$disconnect();
      await watcher.$disconnect();
    }
  });

  it('rejects a child row that points at another company parent', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    const hiddenParent = /missing or not visible/i;
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceLine.create({
          data: {
            companyId: companyA,
            invoiceId: graphB.invoice,
            position: 2,
            kind: 'item',
            description: 'cross company',
            quantity: '1.0000',
            unit: 'piece',
            unitPrice: '1.0000',
            discountPercent: '0.00',
            taxCodeId: graphA.tax_code,
            taxRatePercent: '19.0000',
            lineSubtotal: '1.00',
            lineDiscount: '0.00',
            lineNet: '1.00',
            lineGross: '1.00',
          },
        }),
      ),
    ).rejects.toThrow(hiddenParent);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.invoiceTaxSummary.create({
          data: {
            companyId: companyA,
            invoiceId: graphB.invoice,
            taxCodeId: graphA.tax_code,
            taxRatePercent: '19.0000',
            net: '1.00',
            tax: '0.19',
            gross: '1.19',
          },
        }),
      ),
    ).rejects.toThrow(hiddenParent);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.salesOrderLine.create({
          data: {
            companyId: companyA,
            orderId: graphB.sales_order,
            title: 'cross company',
            quantity: '1.0000',
            unitPrice: '1.0000',
            total: '1.00',
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('rejects a print job that points at another company queue job', async () => {
    const jobA = await app.job.create({
      data: {
        companyId: companyA,
        type: 'print',
        payload: { marker: 'a' },
        correlationId: randomUUID(),
        idempotencyKey: `queue-a-${randomUUID()}`,
      },
    });
    await app.job.create({
      data: {
        companyId: companyB,
        type: 'print',
        payload: { marker: 'b' },
        correlationId: randomUUID(),
        idempotencyKey: `queue-b-${randomUUID()}`,
      },
    });

    await expect(
      appTenant.run(
        { companyId: companyA, actor: userId, correlationId: randomUUID() },
        (tx) =>
          tx.$executeRaw`
          UPDATE print_job
          SET queue_job_id = (
            SELECT id FROM job WHERE company_id <> app_current_company() LIMIT 1
          )
        `,
      ),
    ).rejects.toThrow(/foreign key/i);

    await appTenant.run({ companyId: companyA, actor: userId, correlationId: randomUUID() }, (tx) =>
      tx.printJob.update({
        where: { id: graphA.print_job },
        data: { queueJobId: jobA.id },
      }),
    );
  });

  it('guards payments, allocations, refunds and retry records for bp_app and the owner', async () => {
    const ctx = { companyId: companyA, actor: userId, correlationId: randomUUID() };
    const on = new Date('2026-10-28');
    const later = new Date('2026-10-29');
    const pay = (
      tx: TenantTransaction,
      amount = '100.00',
      fields: {
        currency?: string;
        clientId?: string;
        receivedOn?: Date;
        voidedOn?: Date;
        voidReason?: string;
        voidedById?: string;
      } = {},
    ) =>
      tx.payment.create({
        data: {
          companyId: companyA,
          clientId: graphA.client,
          receivedOn: on,
          amount,
          currency: 'EUR',
          method: 'bank_transfer',
          createdById: userId,
          ...fields,
        },
      });
    const allocate = (
      tx: TenantTransaction,
      paymentId: string | null,
      invoiceId: string,
      amount = '1.00',
      fields: { creditNoteId?: string | null; effectiveOn?: Date; reversedById?: string } = {},
    ) =>
      tx.allocation.create({
        data: {
          companyId: companyA,
          paymentId,
          invoiceId,
          amount,
          effectiveOn: on,
          createdById: userId,
          ...fields,
        },
      });
    const refundOf = (
      tx: TenantTransaction,
      paymentId: string | null,
      amount = '1.00',
      fields: {
        creditNoteId?: string | null;
        refundedOn?: Date;
        voidedOn?: Date;
        voidReason?: string;
        voidedById?: string;
      } = {},
    ) =>
      tx.refund.create({
        data: {
          companyId: companyA,
          paymentId,
          amount,
          refundedOn: on,
          method: 'cash',
          createdById: userId,
          ...fields,
        },
      });
    const voidPayment = (tx: TenantTransaction, id: string) =>
      tx.payment.update({
        where: { id },
        data: {
          status: 'voided',
          voidedOn: later,
          voidReason: 'Correction (fictional)',
          voidedById: userId,
          version: { increment: 1 },
        },
      });
    const issuedOf = async (tx: TenantTransaction, fields: { clientId?: string } = {}) => {
      const draft = await draftOf(tx);
      if (fields.clientId) await tx.invoice.update({ where: { id: draft.id }, data: fields });
      await markIssued(tx, companyA, draft.id, userId);
      return draft.id;
    };

    // Existing document guards allow a NaN header total on a draft to survive issuance.
    // Keep those guards enabled: settlement must refuse such documents independently.
    const nanDocuments = await ownerTenant.run(ctx, async (tx) => {
      const target = await draftOf(tx);
      await tx.$executeRaw`UPDATE invoice SET total = 'NaN' WHERE id = ${target.id}::uuid`;
      await markIssued(tx, companyA, target.id, userId);
      const original = await issuedOf(tx);
      const credit = await creditOf(tx, original);
      await tx.$executeRaw`UPDATE invoice SET total = 'NaN' WHERE id = ${credit.id}::uuid`;
      await markIssued(tx, companyA, credit.id, userId);
      return { target: target.id, credit: credit.id };
    });

    for (const tenant of [appTenant, ownerTenant]) {
      const run = <T>(work: (tx: TenantTransaction) => Promise<T>) => tenant.run(ctx, work);
      const refuses = async (
        work: (tx: TenantTransaction) => Promise<unknown>,
        message: RegExp,
      ) => {
        await expect(run(work)).rejects.toThrow(message);
      };
      const fixtures = await run(async (tx) => {
        const target = await issuedOf(tx);
        const secondTarget = await issuedOf(tx);
        const draft = await draftOf(tx);
        const quote = await draftOf(tx, 'quote');
        const otherClient = await tx.client.create({
          data: {
            companyId: companyA,
            kind: 'individual',
            displayName: 'Other client (fictional)',
            email: `settlement-${randomUUID()}@example.test`,
            createdById: userId,
          },
        });
        const otherTarget = await issuedOf(tx, { clientId: otherClient.id });
        const credit = await creditOf(tx, target);
        const draftCredit = await creditOf(tx, secondTarget);
        await markIssued(tx, companyA, credit.id, userId);
        const payment = await pay(tx);
        const voided = await pay(tx);
        await voidPayment(tx, voided.id);
        return {
          target,
          secondTarget,
          draft: draft.id,
          quote: quote.id,
          otherTarget,
          credit: credit.id,
          draftCredit: draftCredit.id,
          payment: payment.id,
          voided: voided.id,
        };
      });
      const { target, secondTarget, payment, credit } = fixtures;

      // All three amount CHECKs run after their insert guards, for either role.
      for (const amount of ['0.00', '-100.00']) {
        await refuses((tx) => pay(tx, amount), /payment_amount_check/);
        await refuses((tx) => allocate(tx, payment, target, amount), /allocation_amount_check/);
        await refuses((tx) => refundOf(tx, payment, amount), /refund_amount_check/);
      }
      // Active allocations have null reversal dates/reasons and cannot carry a reversal actor.
      await refuses(
        (tx) => allocate(tx, payment, target, '1.00', { reversedById: userId }),
        /allocation_reversal_check/,
      );
      // Raw SQL reaches Postgres with literal NaN, independently of Prisma decimal parsing.
      await refuses(
        (tx) => tx.$executeRaw`
          INSERT INTO payment
            (id, company_id, client_id, received_on, amount, currency, method, created_by, updated_at)
          VALUES (${randomUUID()}::uuid, ${companyA}::uuid, ${graphA.client}::uuid,
                  ${on}::date, 'NaN', 'EUR', 'cash', ${userId}::uuid, now())
        `,
        /payment_amount_check/,
      );
      await refuses(
        (tx) => tx.$executeRaw`
          INSERT INTO allocation
            (id, company_id, payment_id, invoice_id, amount, effective_on, created_by)
          VALUES (${randomUUID()}::uuid, ${companyA}::uuid, ${payment}::uuid, ${target}::uuid,
                  'NaN', ${on}::date, ${userId}::uuid)
        `,
        /exceed the source amount/,
      );
      await refuses(
        (tx) => tx.$executeRaw`
          INSERT INTO refund (id, company_id, payment_id, amount, refunded_on, method, created_by)
          VALUES (${randomUUID()}::uuid, ${companyA}::uuid, ${payment}::uuid,
                  'NaN', ${on}::date, 'cash', ${userId}::uuid)
        `,
        /exceed the source amount/,
      );
      await refuses(
        (tx) => allocate(tx, payment, nanDocuments.target),
        /source amount and target total must not be NaN/,
      );
      await refuses(
        (tx) => allocate(tx, null, target, '1.00', { creditNoteId: nanDocuments.credit }),
        /source amount and target total must not be NaN/,
      );
      await refuses(
        (tx) => refundOf(tx, null, '1.00', { creditNoteId: nanDocuments.credit }),
        /source amount must not be NaN/,
      );
      await refuses((tx) => pay(tx, '1.00', { currency: 'eur' }), /payment_currency_check/);
      await refuses((tx) => pay(tx, '1.00', { clientId: graphB.client }), /foreign key/i);
      await refuses(
        (tx) => allocate(tx, payment, target, '0.01', { creditNoteId: credit }),
        /allocation_source_check/,
      );
      await refuses((tx) => allocate(tx, null, target), /source must be an issued credit note/);
      await refuses(
        (tx) => refundOf(tx, payment, '0.01', { creditNoteId: credit }),
        /refund_source_check/,
      );
      await refuses((tx) => refundOf(tx, null), /source must be an issued credit note/);
      for (const invalidTarget of [fixtures.draft, fixtures.quote, credit, graphB.invoice]) {
        await refuses(
          (tx) => allocate(tx, payment, invalidTarget),
          /target must be an issued invoice/,
        );
      }
      await refuses((tx) => allocate(tx, payment, fixtures.otherTarget), /same client/);
      const usd = await run((tx) => pay(tx, '100.00', { currency: 'USD' }));
      await refuses((tx) => allocate(tx, usd.id, target), /same currency/);
      await refuses(
        (tx) => allocate(tx, fixtures.voided, target),
        /source must be a recorded payment/,
      );
      await refuses((tx) => refundOf(tx, fixtures.voided), /source must be a recorded payment/);
      for (const invalidSource of [target, fixtures.quote, fixtures.draftCredit, graphB.invoice]) {
        await refuses(
          (tx) => allocate(tx, null, secondTarget, '0.01', { creditNoteId: invalidSource }),
          /source must be an issued credit note/,
        );
        await refuses(
          (tx) => refundOf(tx, null, '0.01', { creditNoteId: invalidSource }),
          /source must be an issued credit note/,
        );
      }
      const latePayment = await run((tx) => pay(tx, '100.00', { receivedOn: later }));
      await refuses((tx) => allocate(tx, latePayment.id, target), /effective date cannot precede/);
      await refuses(
        (tx) => allocate(tx, payment, target, '1.00', { effectiveOn: new Date('2026-10-27') }),
        /effective date cannot precede/,
      );
      await refuses((tx) => refundOf(tx, latePayment.id), /refund date cannot precede/);
      await refuses(
        (tx) =>
          refundOf(tx, null, '0.01', { creditNoteId: credit, refundedOn: new Date('2026-10-27') }),
        /refund date cannot precede/,
      );

      // Source limit and invoice limit are independent; exact equality is accepted.
      const small = await run((tx) => pay(tx, '1.00'));
      await refuses((tx) => allocate(tx, small.id, target, '1.01'), /exceed the source amount/);
      const allocation = await run((tx) => allocate(tx, small.id, target, '1.00'));
      await refuses(
        (tx) => allocate(tx, small.id, secondTarget, '0.01'),
        /exceed the source amount/,
      );
      await refuses((tx) => refundOf(tx, small.id, '0.01'), /exceed the source amount/);
      await run((tx) => allocate(tx, payment, target, '0.19'));
      await refuses((tx) => allocate(tx, payment, target, '0.01'), /exceed the invoice total/);
      const refunded = await run((tx) => pay(tx, '1.00'));
      const refund = await run((tx) => refundOf(tx, refunded.id, '1.00'));
      await refuses((tx) => refundOf(tx, refunded.id, '0.01'), /exceed the source amount/);
      await refuses(
        (tx) => allocate(tx, refunded.id, secondTarget, '0.01'),
        /exceed the source amount/,
      );
      const creditAllocation = await run((tx) =>
        allocate(tx, null, secondTarget, '0.19', { creditNoteId: credit }),
      );
      const creditRefund = await run((tx) => refundOf(tx, null, '1.00', { creditNoteId: credit }));
      await refuses(
        (tx) => refundOf(tx, null, '0.01', { creditNoteId: credit }),
        /exceed the source amount/,
      );
      await refuses(
        (tx) => allocate(tx, null, secondTarget, '0.01', { creditNoteId: credit }),
        /exceed the source amount/,
      );

      // Particulars stay immutable, including for the owner, and reversals happen once.
      await refuses(
        (tx) => tx.payment.update({ where: { id: payment }, data: { amount: '99.00' } }),
        /keeps its financial particulars/,
      );
      await refuses(
        (tx) =>
          tx.payment.update({
            where: { id: fixtures.voided },
            data: { status: 'recorded', voidedOn: null },
          }),
        /never recorded again/,
      );
      for (const data of [
        { voidedOn: new Date('2026-10-30') },
        { voidedOn: null },
        { voidReason: 'Changed correction (fictional)' },
        { voidReason: null },
        { voidedById: null },
      ])
        await refuses(
          (tx) => tx.payment.update({ where: { id: fixtures.voided }, data }),
          /keeps its void date, reason and actor/,
        );
      await refuses(
        (tx) => tx.allocation.update({ where: { id: allocation.id }, data: { amount: '0.99' } }),
        /immutable except for its reversal/,
      );
      await refuses(
        (tx) =>
          tx.allocation.update({ where: { id: allocation.id }, data: { invoiceId: secondTarget } }),
        /immutable except for its reversal/,
      );
      await refuses(
        (tx) =>
          tx.allocation.update({
            where: { id: allocation.id },
            data: { reversalReason: 'Missing date' },
          }),
        /reversed only once/,
      );
      for (const data of [
        { reversedOn: new Date('2026-10-27'), reversalReason: 'Too early' },
        { reversedOn: later, reversalReason: ' \t\n' },
        { reversedOn: later },
      ])
        await refuses(
          (tx) => tx.allocation.update({ where: { id: allocation.id }, data }),
          /allocation_reversal_check/,
        );
      await refuses(
        (tx) => tx.refund.update({ where: { id: refund.id }, data: { amount: '0.99' } }),
        /immutable except for its void/,
      );
      await refuses(
        (tx) => tx.refund.update({ where: { id: refund.id }, data: { reference: 'Edited' } }),
        /immutable except for its void/,
      );
      for (const data of [
        { status: 'voided' as const, voidedOn: new Date('2026-10-27'), voidReason: 'Too early' },
        { status: 'voided' as const, voidedOn: later, voidReason: '\t\n' },
        { status: 'voided' as const, voidedOn: later },
      ]) {
        await refuses(
          (tx) => tx.payment.update({ where: { id: refunded.id }, data }),
          /active refund/,
        );
        await refuses(
          (tx) => tx.refund.update({ where: { id: refund.id }, data }),
          /refund_void_check/,
        );
      }
      const unused = await run((tx) => pay(tx));
      for (const fields of [
        { voidedOn: later },
        { voidReason: 'Premature correction (fictional)' },
        { voidedById: userId },
      ]) {
        await refuses((tx) => pay(tx, '1.00', fields), /payment_void_check/);
        await refuses((tx) => refundOf(tx, unused.id, '1.00', fields), /refund_void_check/);
        await refuses(
          (tx) => tx.payment.update({ where: { id: unused.id }, data: fields }),
          /payment_void_check/,
        );
      }
      for (const data of [
        { status: 'voided' as const, voidedOn: new Date('2026-10-27'), voidReason: 'Too early' },
        { status: 'voided' as const, voidedOn: later, voidReason: '\t\n' },
        { status: 'voided' as const, voidedOn: later },
        { voidedOn: later },
      ])
        await refuses(
          (tx) => tx.payment.update({ where: { id: unused.id }, data }),
          /payment_void_check/,
        );

      // Voiding fails with either active kind of usage, then succeeds in the same transaction
      // that reverses its allocation and voids its refund.
      const used = await run(async (tx) => {
        const p = await pay(tx, '1.00');
        const a = await allocate(tx, p.id, secondTarget, '0.40');
        const r = await refundOf(tx, p.id, '0.60');
        return { p, a, r };
      });
      await refuses((tx) => voidPayment(tx, used.p.id), /active allocation/);
      await refuses((tx) => voidPayment(tx, refunded.id), /active refund/);
      await run(async (tx) => {
        await tx.allocation.update({
          where: { id: used.a.id },
          data: {
            reversedOn: later,
            reversalReason: 'Correction (fictional)',
            reversedById: userId,
          },
        });
        await tx.refund.update({
          where: { id: used.r.id },
          data: {
            status: 'voided',
            voidedOn: later,
            voidReason: 'Correction (fictional)',
            voidedById: userId,
            version: { increment: 1 },
          },
        });
        expect((await voidPayment(tx, used.p.id)).status).toBe('voided');
      });
      await refuses(
        (tx) =>
          tx.allocation.update({
            where: { id: used.a.id },
            data: {
              reversedOn: null,
              reversalReason: null,
              reversedById: null,
            },
          }),
        /never un-reversed/,
      );
      await refuses(
        (tx) =>
          tx.allocation.update({
            where: { id: used.a.id },
            data: {
              reversedOn: new Date('2026-10-30'),
              reversalReason: 'Again',
            },
          }),
        /reversed only once/,
      );
      await refuses(
        (tx) =>
          tx.refund.update({
            where: { id: used.r.id },
            data: {
              status: 'recorded',
              voidedOn: null,
              voidReason: null,
            },
          }),
        /never recorded again/,
      );
      await refuses(
        (tx) =>
          tx.refund.update({
            where: { id: used.r.id },
            data: {
              status: 'voided',
              voidedOn: new Date('2026-10-30'),
              voidReason: 'Again',
            },
          }),
        /only voided once/,
      );
      // A complete reversal may omit its actor.
      await run((tx) =>
        tx.allocation.update({
          where: { id: allocation.id },
          data: {
            reversedOn: later,
            reversalReason: 'Correction (fictional)',
            reversedById: null,
          },
        }),
      );
      expect((await run((tx) => voidPayment(tx, small.id))).status).toBe('voided');

      for (const [table, id] of [
        ['payment', payment],
        ['allocation', creditAllocation.id],
        ['refund', creditRefund.id],
      ] as const) {
        await refuses(
          (tx) => tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE id = $1::uuid`, id),
          tenant === appTenant ? /permission denied/ : /never deleted/,
        );
        await refuses(
          (tx) => tx.$executeRawUnsafe(`TRUNCATE TABLE ${table} CASCADE`),
          /permission denied|is never truncated/,
        );
      }

      // Real concurrent transactions must serialize their usage checks after the row lock.
      const race = await run(async (tx) => ({
        payment: (await pay(tx, '1.00')).id,
        targetA: await issuedOf(tx),
        targetB: await issuedOf(tx),
      }));
      const allocations = await Promise.allSettled([
        run((tx) => allocate(tx, race.payment, race.targetA, '0.80')),
        run((tx) => allocate(tx, race.payment, race.targetB, '0.80')),
      ]);
      expect(allocations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(allocations.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const raceRefund = await run((tx) => pay(tx, '1.00'));
      const refunds = await Promise.allSettled([
        run((tx) => refundOf(tx, raceRefund.id, '0.80')),
        run((tx) => refundOf(tx, raceRefund.id, '0.80')),
      ]);
      expect(refunds.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(refunds.filter((result) => result.status === 'rejected')).toHaveLength(1);
    }

    // bp_app cannot overwrite a recorded retry result, nor reuse its operation/key.
    const retry = {
      companyId: companyA,
      operation: 'payment.record',
      key: randomUUID(),
      requestHash: 'fictional-hash',
      statusCode: 201,
      response: {},
      createdById: userId,
    };
    const record = await appTenant.run(ctx, (tx) => tx.idempotencyRecord.create({ data: retry }));
    await expect(
      appTenant.run(ctx, (tx) => tx.idempotencyRecord.create({ data: retry })),
    ).rejects.toThrow(/unique constraint/i);
    for (const fields of [{ key: '' }, { key: 'x'.repeat(201) }, { operation: '\t\n' }]) {
      await expect(
        appTenant.run(ctx, (tx) =>
          tx.idempotencyRecord.create({
            data: { ...retry, key: randomUUID(), ...fields },
          }),
        ),
      ).rejects.toThrow(/idempotency_record_(key|operation)_check/);
    }
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.idempotencyRecord.update({
          where: { id: record.id },
          data: { statusCode: 200 },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appTenant.run(ctx, (tx) =>
        tx.idempotencyRecord.delete({
          where: { id: record.id },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('keeps company-scoped parent references inside the same company', async () => {
    const rows = await app.$queryRaw<{ table_name: string; definition: string }[]>`
      SELECT conrelid::regclass::text AS table_name,
             pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE contype = 'f'
        AND connamespace = 'public'::regnamespace
    `;
    const definitions = rows.map((row) => `${bareTable(row.table_name)} ${row.definition}`);
    for (const [table, fragment] of COMPOSITE_FOREIGN_KEYS) {
      expect(
        definitions.some(
          (definition) => definition.startsWith(`${table} `) && definition.includes(fragment),
        ),
      ).toBe(true);
    }
    const indexes = await app.$queryRaw<{ table_name: string }[]>`
      SELECT tablename AS table_name
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef LIKE '%UNIQUE%'
        AND indexdef LIKE '%(company_id, id)%'
    `;
    expect(new Set(indexes.map((row) => row.table_name))).toEqual(new Set(COMPANY_SCOPED_PARENTS));
  });

  it('requires a browser binding and keeps attention reasons non-null', async () => {
    const rows = await app.$queryRaw<
      {
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    >`
      SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE (table_name = 'auth_flow' AND column_name = 'browser_binding_hash')
         OR (table_name = 'sales_order' AND column_name = 'attention_reasons')
    `;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: 'auth_flow',
          column_name: 'browser_binding_hash',
          is_nullable: 'NO',
        }),
        expect.objectContaining({
          table_name: 'sales_order',
          column_name: 'attention_reasons',
          is_nullable: 'NO',
        }),
      ]),
    );
    const attention = rows.find((row) => row.column_name === 'attention_reasons');
    expect(attention?.column_default ?? '').toMatch(/\{\}|ARRAY\[\]/i);
  });

  it('does not let n8n connect to the application database', async () => {
    const rows = await app.$queryRaw<{ can_connect: boolean }[]>`
      SELECT has_database_privilege('n8n', current_database(), 'CONNECT') AS can_connect
    `;
    expect(rows[0]?.can_connect).toBe(false);
  });

  it('forces RLS on every company_id table except the documented exemptions', async () => {
    const rows = await app.$queryRaw<
      { table_name: string; rls_enabled: boolean; rls_forced: boolean }[]
    >`
      SELECT c.relname AS table_name,
             c.relrowsecurity AS rls_enabled,
             c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1
          FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'company_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
        )
      ORDER BY c.relname
    `;
    const seen = new Set(rows.map((row) => row.table_name));
    expect(seen).toEqual(new Set([...RLS_TABLES, ...RLS_EXEMPT_TABLES]));
    for (const row of rows) {
      if ((RLS_EXEMPT_TABLES as readonly string[]).includes(row.table_name)) {
        expect(row.rls_enabled, row.table_name).toBe(false);
        expect(row.rls_forced, row.table_name).toBe(false);
      } else {
        expect(row.rls_enabled, row.table_name).toBe(true);
        expect(row.rls_forced, row.table_name).toBe(true);
      }
    }
  });
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function assertConnectedDatabase(
  client: PrismaClient,
  label: 'DATABASE_URL' | 'DATABASE_URL_OWNER',
): Promise<void> {
  const rows = await client.$queryRaw<{ current_database: string }[]>`
    SELECT current_database() AS current_database
  `;
  assertDatabaseNameIsTest(rows[0]?.current_database, label);
}

function postgresAdminUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const user = process.env['POSTGRES_USER'];
  const password = process.env['POSTGRES_PASSWORD'];
  if (!user || password === undefined || password.length === 0) {
    throw new Error('POSTGRES_USER and POSTGRES_PASSWORD are required to observe locks');
  }
  url.username = user;
  url.password = password;
  return url.toString();
}

async function waitForIssuedRaceLock(watcher: PrismaClient): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await watcher.$queryRaw<{ wait_event_type: string | null }[]>`
      SELECT wait_event_type
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND query LIKE '%bp-issued-race%'
    `;
    if (rows.some((row) => row.wait_event_type === 'Lock')) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
  }
  throw new Error('line update did not block on the invoice row lock');
}

function bareTable(name: string): string {
  const unquoted = name.replaceAll('"', '');
  const dot = unquoted.lastIndexOf('.');
  return dot === -1 ? unquoted : unquoted.slice(dot + 1);
}

/**
 * Marks a draft issued the way the issue action leaves it: a number in a fresh series, every
 * particular present, and its own sealed PDF row. The UPDATE locks the invoice row.
 */
async function markIssued(
  tx: TenantTransaction,
  companyId: string,
  invoiceId: string,
  userId: string,
  options: {
    sealed?: boolean;
    sourceId?: string;
    supplyDate?: string | null;
    sellerSnapshot?: string;
    lineSnapshots?: boolean;
    /** The tax code name frozen on the lines and summary rows. */
    taxName?: string;
  } = {},
): Promise<number> {
  const tag = randomUUID().slice(0, 8);
  if (options.lineSnapshots ?? true) {
    const snapshot = JSON.stringify({
      code: 'STD19',
      kind: 'standard',
      ratePercent: '19.0000',
      ...(options.taxName ? { name: options.taxName } : {}),
    });
    await tx.$executeRaw`
      UPDATE invoice_line SET tax_snapshot = ${snapshot}::jsonb WHERE invoice_id = ${invoiceId}::uuid
    `;
    await tx.$executeRaw`
      UPDATE invoice_tax_summary SET tax_snapshot = ${snapshot}::jsonb
      WHERE invoice_id = ${invoiceId}::uuid
    `;
  }
  const address = { line1: '1 Demo Street', city: 'Nicosia', countryCode: 'CY' };
  const seller =
    options.sellerSnapshot ??
    JSON.stringify({
      legalName: 'Demo Company A Ltd (fictional)',
      vatNumber: 'CY00000000X',
      address,
    });
  const buyer = JSON.stringify({ displayName: 'Demo client (fictional)', address });
  const series = await tx.invoiceSeries.create({
    data: {
      companyId,
      documentType: 'invoice',
      code: `RLS${tag}`,
      prefix: `RLS${tag}-`,
      nextNumber: 2,
    },
  });
  const file = await tx.storedFile.create({
    data: {
      companyId,
      kind: 'invoice_pdf',
      storageKey: `companies/${companyId}/test/issued-${tag}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 4,
      sha256: '0'.repeat(64),
      sourceType: 'invoice',
      sourceId: options.sourceId ?? invoiceId,
      createdById: userId,
      sealed: options.sealed ?? true,
    },
  });
  return tx.$executeRaw`
    UPDATE invoice
    SET status = 'issued',
        series_id = ${series.id}::uuid,
        number = ${`RLS${tag}-1`},
        number_seq = 1,
        issue_date = DATE '2026-10-28',
        due_date = DATE '2026-11-27',
        supply_date = ${options.supplyDate === undefined ? '2026-10-28' : options.supplyDate}::date,
        delivery_deadline = DATE '2026-11-27',
        seller_snapshot = ${seller}::jsonb,
        buyer_snapshot = ${buyer}::jsonb,
        render_version = 1,
        pdf_file_id = ${file.id}::uuid,
        issued_at = now(),
        issued_by = ${userId}::uuid
    WHERE id = ${invoiceId}::uuid
  `;
}

const COMPANY_SCOPED_PARENTS = [
  'brand',
  'client',
  'integration_credential',
  'invoice',
  'invoice_line',
  'invoice_series',
  'job',
  'location',
  'payment',
  'printer',
  'print_job',
  'product',
  'sales_order',
  'store',
  'store_connection',
  'stored_file',
  'tax_code',
] as const;

const COMPOSITE_FOREIGN_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['payment', 'FOREIGN KEY (company_id, client_id) REFERENCES client(company_id, id)'],
  ['allocation', 'FOREIGN KEY (company_id, payment_id) REFERENCES payment(company_id, id)'],
  ['allocation', 'FOREIGN KEY (company_id, credit_note_id) REFERENCES invoice(company_id, id)'],
  ['allocation', 'FOREIGN KEY (company_id, invoice_id) REFERENCES invoice(company_id, id)'],
  ['refund', 'FOREIGN KEY (company_id, payment_id) REFERENCES payment(company_id, id)'],
  ['refund', 'FOREIGN KEY (company_id, credit_note_id) REFERENCES invoice(company_id, id)'],
  ['client_contact', 'FOREIGN KEY (company_id, client_id) REFERENCES client(company_id, id)'],
  ['client_address', 'FOREIGN KEY (company_id, client_id) REFERENCES client(company_id, id)'],
  ['invoice', 'FOREIGN KEY (company_id, client_id) REFERENCES client(company_id, id)'],
  ['invoice', 'FOREIGN KEY (company_id, series_id) REFERENCES invoice_series(company_id, id)'],
  ['invoice', 'FOREIGN KEY (company_id, source_order_id) REFERENCES sales_order(company_id, id)'],
  ['invoice', 'FOREIGN KEY (company_id, pdf_file_id) REFERENCES stored_file(company_id, id)'],
  ['invoice', 'FOREIGN KEY (company_id, credited_invoice_id) REFERENCES invoice(company_id, id)'],
  ['invoice', 'FOREIGN KEY (company_id, source_quote_id) REFERENCES invoice(company_id, id)'],
  ['invoice_delivery', 'FOREIGN KEY (company_id, invoice_id) REFERENCES invoice(company_id, id)'],
  ['invoice_line', 'FOREIGN KEY (company_id, invoice_id) REFERENCES invoice(company_id, id)'],
  ['invoice_line', 'FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_code(company_id, id)'],
  ['invoice_line', 'FOREIGN KEY (company_id, product_id) REFERENCES product(company_id, id)'],
  [
    'invoice_line',
    'FOREIGN KEY (company_id, credited_line_id) REFERENCES invoice_line(company_id, id)',
  ],
  [
    'invoice_tax_summary',
    'FOREIGN KEY (company_id, invoice_id) REFERENCES invoice(company_id, id)',
  ],
  [
    'invoice_tax_summary',
    'FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_code(company_id, id)',
  ],
  ['product', 'FOREIGN KEY (company_id, tax_code_id) REFERENCES tax_code(company_id, id)'],
  ['store', 'FOREIGN KEY (company_id, brand_id) REFERENCES brand(company_id, id)'],
  ['store', 'FOREIGN KEY (company_id, location_id) REFERENCES location(company_id, id)'],
  ['store_connection', 'FOREIGN KEY (company_id, store_id) REFERENCES store(company_id, id)'],
  [
    'store_connection',
    'FOREIGN KEY (company_id, credential_id) REFERENCES integration_credential(company_id, id)',
  ],
  [
    'integration_inbox',
    'FOREIGN KEY (company_id, connection_id) REFERENCES store_connection(company_id, id)',
  ],
  ['sales_order', 'FOREIGN KEY (company_id, store_id) REFERENCES store(company_id, id)'],
  [
    'sales_order',
    'FOREIGN KEY (company_id, connection_id) REFERENCES store_connection(company_id, id)',
  ],
  ['sales_order_line', 'FOREIGN KEY (company_id, order_id) REFERENCES sales_order(company_id, id)'],
  ['order_note', 'FOREIGN KEY (company_id, order_id) REFERENCES sales_order(company_id, id)'],
  ['printer', 'FOREIGN KEY (company_id, location_id) REFERENCES location(company_id, id)'],
  ['printer_mapping', 'FOREIGN KEY (company_id, printer_id) REFERENCES printer(company_id, id)'],
  ['printer_mapping', 'FOREIGN KEY (company_id, location_id) REFERENCES location(company_id, id)'],
  ['print_job', 'FOREIGN KEY (company_id, printer_id) REFERENCES printer(company_id, id)'],
  ['print_job', 'FOREIGN KEY (company_id, file_id) REFERENCES stored_file(company_id, id)'],
  ['print_job', 'FOREIGN KEY (company_id, reprint_of_id) REFERENCES print_job(company_id, id)'],
  ['print_job', 'FOREIGN KEY (company_id, queue_job_id) REFERENCES job(company_id, id)'],
];

async function count(client: PrismaClient, table: string): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${checkedTable(table)}`,
  );
  return rows[0]?.n ?? 0;
}

async function countWhereId(
  client: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] },
  table: string,
  id: string,
): Promise<number> {
  const rows = await client.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${checkedTable(table)} WHERE id = $1::uuid`,
    id,
  );
  return rows[0]?.n ?? 0;
}

function checkedTable(table: string): string {
  if (!(RLS_TABLES as readonly string[]).includes(table)) {
    throw new Error(`unexpected table ${table}`);
  }
  return table;
}

async function insertGraph(
  tx: TenantTransaction,
  companyId: string,
  userId: string,
  marker: string,
): Promise<Graph> {
  const brand = await tx.brand.create({ data: { companyId, name: `Brand ${marker}` } });
  const location = await tx.location.create({
    data: { companyId, name: `Location ${marker}`, address: { city: 'Nicosia' } },
  });
  const store = await tx.store.create({
    data: {
      companyId,
      brandId: brand.id,
      locationId: location.id,
      platform: 'manual',
      name: `Store ${marker}`,
      deliveryMethodMap: {},
    },
  });
  const credential = await tx.integrationCredential.create({
    data: {
      companyId,
      provider: 'mock',
      label: `Credential ${marker}`,
      keyId: 'k1',
      nonce: Buffer.from('0123456789ab'),
      ciphertext: Buffer.from('cipher'),
      authTag: Buffer.from('0123456789abcdef'),
      createdById: userId,
    },
  });
  const connection = await tx.storeConnection.create({
    data: {
      companyId,
      storeId: store.id,
      credentialId: credential.id,
      mode: 'mock',
      status: 'active',
    },
  });
  const inbox = await tx.integrationInbox.create({
    data: {
      companyId,
      connectionId: connection.id,
      provider: 'mock',
      externalEventId: `event-${marker}`,
      topic: 'orders/create',
      payload: { marker },
    },
  });
  const client = await tx.client.create({
    data: { companyId, kind: 'individual', displayName: `Client ${marker}`, createdById: userId },
  });
  const contact = await tx.clientContact.create({
    data: { companyId, clientId: client.id, name: `Contact ${marker}` },
  });
  const address = await tx.clientAddress.create({
    data: {
      companyId,
      clientId: client.id,
      kind: 'billing',
      line1: '1 Demo Street',
      city: 'Nicosia',
      countryCode: 'CY',
    },
  });
  const tax = await tx.taxCode.create({
    data: {
      companyId,
      code: `T${marker}`,
      name: `Tax ${marker}`,
      ratePercent: '19.0000',
      kind: 'standard',
    },
  });
  const product = await tx.product.create({
    data: {
      companyId,
      sku: `SKU-${marker}`,
      name: `Product ${marker}`,
      kind: 'product',
      unit: 'piece',
      unitPrice: '1.0000',
      pricesIncludeTax: false,
      taxCodeId: tax.id,
    },
  });
  const series = await tx.invoiceSeries.create({
    data: { companyId, documentType: 'invoice', code: `INV-${marker}`, prefix: `${marker}-` },
  });
  const invoice = await tx.invoice.create({
    data: {
      companyId,
      documentType: 'invoice',
      clientId: client.id,
      currency: 'EUR',
      language: 'en',
      pricesIncludeTax: false,
      subtotal: '1.00',
      discountTotal: '0.00',
      netTotal: '1.00',
      taxTotal: '0.19',
      total: '1.19',
      notes: 'draft',
      createdById: userId,
    },
  });
  const delivery = await tx.invoiceDelivery.create({
    data: {
      companyId,
      invoiceId: invoice.id,
      method: 'other',
      deliveredOn: new Date('2026-10-27T00:00:00Z'),
      recordedById: userId,
    },
  });
  const line = await tx.invoiceLine.create({
    data: {
      companyId,
      invoiceId: invoice.id,
      position: 1,
      kind: 'item',
      productId: product.id,
      description: 'Line',
      quantity: '1.0000',
      unit: 'piece',
      unitPrice: '1.0000',
      discountPercent: '0.00',
      taxCodeId: tax.id,
      taxRatePercent: '19.0000',
      lineSubtotal: '1.00',
      lineDiscount: '0.00',
      lineNet: '1.00',
      lineGross: '1.00',
    },
  });
  const summary = await tx.invoiceTaxSummary.create({
    data: {
      companyId,
      invoiceId: invoice.id,
      taxCodeId: tax.id,
      taxRatePercent: '19.0000',
      net: '1.00',
      tax: '0.19',
      gross: '1.19',
    },
  });
  // A separate issued target leaves the graph's invoice as a draft for the mutation tests.
  const settlementInvoice = await tx.invoice.create({
    data: {
      companyId,
      clientId: client.id,
      documentType: 'invoice',
      currency: 'EUR',
      language: 'en',
      pricesIncludeTax: false,
      subtotal: '1.00',
      discountTotal: '0.00',
      netTotal: '1.00',
      taxTotal: '0.19',
      total: '1.19',
      createdById: userId,
    },
  });
  await tx.invoiceLine.create({
    data: { ...line, id: randomUUID(), invoiceId: settlementInvoice.id, taxSnapshot: undefined },
  });
  await tx.invoiceTaxSummary.create({
    data: { ...summary, id: randomUUID(), invoiceId: settlementInvoice.id, taxSnapshot: undefined },
  });
  await markIssued(tx, companyId, settlementInvoice.id, userId);
  const payment = await tx.payment.create({
    data: {
      companyId,
      clientId: client.id,
      receivedOn: new Date('2026-10-28'),
      amount: '2.00',
      currency: 'EUR',
      method: 'bank_transfer',
      createdById: userId,
    },
  });
  const allocation = await tx.allocation.create({
    data: {
      companyId,
      paymentId: payment.id,
      invoiceId: settlementInvoice.id,
      amount: '0.50',
      effectiveOn: new Date('2026-10-28'),
      createdById: userId,
    },
  });
  const refund = await tx.refund.create({
    data: {
      companyId,
      paymentId: payment.id,
      amount: '0.20',
      refundedOn: new Date('2026-10-28'),
      method: 'bank_transfer',
      createdById: userId,
    },
  });
  const idempotency = await tx.idempotencyRecord.create({
    data: {
      companyId,
      operation: 'payment.record',
      key: randomUUID(),
      requestHash: 'fictional-hash',
      statusCode: 201,
      response: { id: payment.id },
      createdById: userId,
    },
  });
  const order = await tx.salesOrder.create({
    data: {
      companyId,
      storeId: store.id,
      connectionId: connection.id,
      externalId: `order-${marker}`,
      externalNumber: `#${marker}`,
      sourcePlatform: 'manual',
      sourceStatus: {},
      paymentStatus: 'paid',
      fulfilmentStatus: 'new',
      integrationStatus: 'synced',
      deliveryMethod: 'courier_cy',
      currency: 'EUR',
      subtotal: '1.00',
      shippingTotal: '0.00',
      taxTotal: '0.00',
      total: '1.00',
    },
  });
  const orderLine = await tx.salesOrderLine.create({
    data: {
      companyId,
      orderId: order.id,
      title: 'Line',
      quantity: '1.0000',
      unitPrice: '1.0000',
      total: '1.00',
    },
  });
  const note = await tx.orderNote.create({
    data: { companyId, orderId: order.id, authorUserId: userId, body: 'Note' },
  });
  const file = await tx.storedFile.create({
    data: {
      companyId,
      kind: 'test_print',
      storageKey: `companies/${companyId}/test/${marker}.pdf`,
      contentType: 'application/pdf',
      sizeBytes: 4,
      sha256: marker.padEnd(64, '0'),
      createdById: userId,
    },
  });
  const template = await tx.giftMessageTemplate.create({
    data: {
      companyId,
      name: `Template ${marker}`,
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
    },
  });
  const printer = await tx.printer.create({
    data: {
      companyId,
      locationId: location.id,
      provider: 'mock',
      externalPrinterId: `printer-${marker}`,
      name: `Printer ${marker}`,
      paperSizes: ['A4'],
      status: 'online',
    },
  });
  const mapping = await tx.printerMapping.create({
    data: {
      companyId,
      locationId: location.id,
      documentType: 'packing_slip',
      printerId: printer.id,
      paperSize: 'A4',
    },
  });
  const printJob = await tx.printJob.create({
    data: {
      companyId,
      printerId: printer.id,
      documentType: 'packing_slip',
      sourceType: 'order',
      sourceId: order.id,
      sourceVersion: 0,
      fileId: file.id,
      paperSize: 'A4',
      idempotencyKey: `print-${marker}`,
      requestedById: userId,
      correlationId: randomUUID(),
    },
  });
  const bank = await tx.companyBankAccount.create({
    data: {
      companyId,
      bankName: 'Demo Bank',
      iban: `CY00DEMO${marker}`,
      accountHolder: 'Demo Company (fictional)',
    },
  });
  const audit = await tx.auditEvent.create({
    data: {
      companyId,
      actorType: 'user',
      actorId: userId,
      action: 'test.seed',
      objectType: 'company',
      objectId: companyId,
      outcome: 'success',
      correlationId: randomUUID(),
    },
  });

  return {
    allocation: allocation.id,
    payment: payment.id,
    refund: refund.id,
    idempotency_record: idempotency.id,
    audit_event: audit.id,
    brand: brand.id,
    client: client.id,
    client_address: address.id,
    client_contact: contact.id,
    company_bank_account: bank.id,
    gift_message_template: template.id,
    integration_credential: credential.id,
    integration_inbox: inbox.id,
    invoice: invoice.id,
    invoice_delivery: delivery.id,
    invoice_line: line.id,
    invoice_series: series.id,
    invoice_tax_summary: summary.id,
    location: location.id,
    order_note: note.id,
    print_job: printJob.id,
    printer: printer.id,
    printer_mapping: mapping.id,
    product: product.id,
    sales_order: order.id,
    sales_order_line: orderLine.id,
    store: store.id,
    store_connection: connection.id,
    stored_file: file.id,
    tax_code: tax.id,
  };
}
