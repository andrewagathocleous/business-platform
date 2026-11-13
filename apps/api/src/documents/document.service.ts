import { Injectable, Inject } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { parseAmount } from '@bp/domain';
import {
  renderGiftMessage,
  renderPackingSlip,
  type DocumentLanguage,
  type GiftMessageTemplate as GiftCard,
} from '@bp/documents';
import type { StorageAdapter } from '@bp/integrations';
import { integrityFailed, isStorageMiss } from '../storage/file-errors';
import { FileIntegrityError, readVerifiedFile } from '../storage/verified-file';
import { AuditService } from '../audit/audit.service';
import type { RequestContext } from '../authz/request-context';
import { isUuid } from '../authz/company-path';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { fixed } from '../commerce/format';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';
import { STORAGE } from '../storage/storage.module';

export type TemplateView = {
  id: string;
  name: string;
  pageWidthMm: string;
  pageHeightMm: string;
  marginTopMm: string;
  marginRightMm: string;
  marginBottomMm: string;
  marginLeftMm: string;
  fontSizePt: string;
  minFontSizePt: string;
  lineHeight: string;
  align: 'left' | 'center';
  verticalAlign: 'top' | 'middle';
  isDefault: boolean;
};

export type TemplatePatch = {
  name?: string;
  pageWidthMm?: unknown;
  pageHeightMm?: unknown;
  marginTopMm?: unknown;
  marginRightMm?: unknown;
  marginBottomMm?: unknown;
  marginLeftMm?: unknown;
  fontSizePt?: unknown;
  minFontSizePt?: unknown;
  lineHeight?: unknown;
  align?: 'left' | 'center';
  verticalAlign?: 'top' | 'middle';
  isDefault?: boolean;
};

/** Test seam. Runs inside the company template lock, after clearing defaults and before the update. */
export type TemplateHooks = {
  beforeTemplateSave?: () => Promise<void>;
};

type TemplateRow = {
  id: string;
  name: string;
  pageWidthMm: { toFixed(digits: number): string };
  pageHeightMm: { toFixed(digits: number): string };
  marginTopMm: { toFixed(digits: number): string };
  marginRightMm: { toFixed(digits: number): string };
  marginBottomMm: { toFixed(digits: number): string };
  marginLeftMm: { toFixed(digits: number): string };
  fontSizePt: { toFixed(digits: number): string };
  minFontSizePt: { toFixed(digits: number): string };
  lineHeight: { toFixed(digits: number): string };
  align: 'left' | 'center';
  verticalAlign: 'top' | 'middle';
  isDefault: boolean;
};

@Injectable()
export class DocumentService {
  private readonly tenants: TenantDb;
  /** Test seam. Production leaves it null. */
  hooks: TemplateHooks | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: StorageAdapter,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async packingSlip(ctx: RequestContext, orderId: string, meta: RequestMeta): Promise<Buffer> {
    try {
      const loaded = await this.tenants.run(this.context(ctx), async (tx) => {
        const order = await this.loadOrder(tx, ctx, orderId);
        return order;
      });
      return await renderPackingSlip(
        {
          orderNumber: loaded.externalNumber,
          storeName: loaded.store.name,
          deliveryMethod: loaded.deliveryMethod,
          recipientName: loaded.recipientName,
          recipientLines: loaded.recipientLines,
          items: loaded.items,
          hasGiftMessage: loaded.giftMessage !== null,
        },
        { legalName: loaded.legalName, tradingName: loaded.tradingName },
        loaded.language,
      );
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async giftMessage(
    ctx: RequestContext,
    orderId: string,
    templateId: string | null,
    meta: RequestMeta,
  ): Promise<Buffer> {
    try {
      const loaded = await this.tenants.run(this.context(ctx), async (tx) => {
        const order = await this.loadOrder(tx, ctx, orderId);
        if (order.giftMessage === null) {
          throw new CommerceError(404, 'gift_message_missing', 'sales_order', orderId, 'Not found');
        }
        const template = await this.loadTemplate(tx, ctx, templateId);
        return { text: order.giftMessage, template };
      });
      const rendered = await renderGiftMessage(loaded.text, loaded.template);
      return rendered.pdf;
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  /**
   * Renders sample text with a saved template, for tuning the card before a real print.
   * The text is drawn as given (not trimmed) and is neither stored nor logged.
   */
  async previewTemplate(
    ctx: RequestContext,
    templateId: string,
    text: string,
    meta: RequestMeta,
  ): Promise<{ pdf: Buffer; fits: boolean; unsupportedChars: string[] }> {
    try {
      if (!isUuid(templateId)) {
        throw new CommerceError(404, 'not_found', 'gift_message_template', null, 'Not found');
      }
      const template = await this.tenants.run(this.context(ctx), (tx) =>
        this.loadTemplate(tx, ctx, templateId),
      );
      return await renderGiftMessage(text, template);
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async listTemplates(ctx: RequestContext): Promise<{ templates: TemplateView[] }> {
    const rows = await this.tenants.run(this.context(ctx), (tx) =>
      tx.giftMessageTemplate.findMany({
        where: { companyId: ctx.companyId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    );
    return { templates: rows.map(templateView) };
  }

  async updateTemplate(
    ctx: RequestContext,
    templateId: string,
    patch: TemplatePatch,
    meta: RequestMeta,
  ): Promise<{ template: TemplateView }> {
    try {
      if (!isUuid(templateId)) {
        throw new CommerceError(404, 'not_found', 'gift_message_template', null, 'Not found');
      }
      if (!hasPatch(patch)) {
        throw new CommerceError(
          400,
          'empty_patch',
          'gift_message_template',
          templateId,
          'No fields to update',
        );
      }
      const id = templateId.toLowerCase();
      const template = await this.tenants.run(this.context(ctx), async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gift_message_template:${ctx.companyId}`}, 0::bigint))`;
        const existing = await tx.giftMessageTemplate.findFirst({
          where: { id, companyId: ctx.companyId },
        });
        if (!existing) {
          throw new CommerceError(
            404,
            'template_not_found',
            'gift_message_template',
            id,
            'Not found',
          );
        }
        const next = mergedTemplate(existing, patch);
        if (patch.isDefault === true) {
          await tx.giftMessageTemplate.updateMany({
            where: { companyId: ctx.companyId, isDefault: true, NOT: { id } },
            data: { isDefault: false },
          });
        }
        await this.hooks?.beforeTemplateSave?.();
        const written = await tx.giftMessageTemplate.updateMany({
          where: { id, companyId: ctx.companyId },
          data: changedFields(patch, next),
        });
        if (written.count !== 1) {
          throw new CommerceError(
            404,
            'template_not_found',
            'gift_message_template',
            id,
            'Not found',
          );
        }
        const saved = await tx.giftMessageTemplate.findFirst({
          where: { id, companyId: ctx.companyId },
        });
        if (!saved) {
          throw new CommerceError(
            404,
            'template_not_found',
            'gift_message_template',
            id,
            'Not found',
          );
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: ctx.serviceIdentityId ? 'service' : 'user',
          actorId: ctx.serviceIdentityId ?? ctx.userId,
          actorLabel: ctx.actorLabel,
          action: 'gift_message_template.updated',
          objectType: 'gift_message_template',
          objectId: saved.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: { name: saved.name, isDefault: saved.isDefault },
        });
        return saved;
      });
      return { template: templateView(template) };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async readFile(
    ctx: RequestContext,
    fileId: string,
    meta: RequestMeta,
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    try {
      const file = await this.tenants.run(this.context(ctx), async (tx) => {
        if (!isUuid(fileId)) {
          throw new CommerceError(404, 'not_found', 'stored_file', null, 'Not found');
        }
        const row = await tx.storedFile.findFirst({
          where: { id: fileId.toLowerCase(), companyId: ctx.companyId },
        });
        if (!row) {
          throw new CommerceError(
            404,
            'not_found',
            'stored_file',
            fileId.toLowerCase(),
            'Not found',
          );
        }
        return row;
      });
      let bytes: Buffer;
      try {
        bytes = await readVerifiedFile(this.storage, file);
      } catch (error) {
        if (error instanceof FileIntegrityError) {
          throw integrityFailed(file.id, error);
        }
        if (isStorageMiss(error)) {
          throw new CommerceError(404, 'not_found', 'stored_file', file.id, 'Not found');
        }
        throw new Error('storage read failed');
      }
      return { bytes, contentType: file.contentType, filename: `${file.kind}.pdf` };
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private context(ctx: RequestContext) {
    return { companyId: ctx.companyId, actor: requireActor(ctx), correlationId: ctx.correlationId };
  }

  private async loadOrder(tx: TenantTransaction, ctx: RequestContext, orderId: string) {
    if (!isUuid(orderId)) {
      throw new CommerceError(404, 'not_found', 'sales_order', null, 'Not found');
    }
    const order = await tx.salesOrder.findFirst({
      where: { id: orderId.toLowerCase(), companyId: ctx.companyId },
      select: {
        id: true,
        externalNumber: true,
        deliveryMethod: true,
        giftMessage: true,
        recipient: true,
        store: { select: { name: true } },
        company: { select: { legalName: true, tradingName: true, documentLanguage: true } },
        lines: {
          orderBy: { id: 'asc' },
          select: { sku: true, title: true, variantTitle: true, quantity: true },
        },
      },
    });
    if (!order) {
      throw new CommerceError(404, 'not_found', 'sales_order', orderId.toLowerCase(), 'Not found');
    }
    const recipient = recipientOf(order.recipient);
    return {
      externalNumber: order.externalNumber,
      deliveryMethod: order.deliveryMethod,
      giftMessage: order.giftMessage,
      recipientName: recipient.name,
      recipientLines: recipient.lines,
      store: order.store,
      legalName: order.company.legalName,
      tradingName: order.company.tradingName,
      language: order.company.documentLanguage === 'el' ? 'el' : 'en',
      items: order.lines.map((line) => ({
        sku: line.sku,
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: fixed(line.quantity, 4),
      })),
    } satisfies {
      language: DocumentLanguage;
      externalNumber: string;
      deliveryMethod: string;
      giftMessage: string | null;
      recipientName: string;
      recipientLines: string[];
      store: { name: string };
      legalName: string;
      tradingName: string;
      items: { sku: string | null; title: string; variantTitle: string | null; quantity: string }[];
    };
  }

  private async loadTemplate(
    tx: TenantTransaction,
    ctx: RequestContext,
    templateId: string | null,
  ): Promise<GiftCard> {
    const row = templateId
      ? await tx.giftMessageTemplate.findFirst({
          where: { id: templateId.toLowerCase(), companyId: ctx.companyId },
        })
      : await tx.giftMessageTemplate.findFirst({
          where: { companyId: ctx.companyId, isDefault: true },
          orderBy: { id: 'asc' },
        });
    if (!row) {
      throw new CommerceError(
        404,
        'template_not_found',
        'gift_message_template',
        templateId,
        'Not found',
      );
    }
    return cardOf(row);
  }

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function hasPatch(patch: TemplatePatch): boolean {
  return Object.values(patch).some((value) => value !== undefined);
}

function mergedTemplate(existing: TemplateRow, patch: TemplatePatch): TemplateView {
  const next: TemplateView = {
    ...templateView(existing),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.align !== undefined ? { align: patch.align } : {}),
    ...(patch.verticalAlign !== undefined ? { verticalAlign: patch.verticalAlign } : {}),
    ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
  };
  if (patch.pageWidthMm !== undefined) {
    next.pageWidthMm = measurement(patch.pageWidthMm, 2, 'pageWidthMm', true);
  }
  if (patch.pageHeightMm !== undefined) {
    next.pageHeightMm = measurement(patch.pageHeightMm, 2, 'pageHeightMm', true);
  }
  if (patch.marginTopMm !== undefined) {
    next.marginTopMm = measurement(patch.marginTopMm, 2, 'marginTopMm', false);
  }
  if (patch.marginRightMm !== undefined) {
    next.marginRightMm = measurement(patch.marginRightMm, 2, 'marginRightMm', false);
  }
  if (patch.marginBottomMm !== undefined) {
    next.marginBottomMm = measurement(patch.marginBottomMm, 2, 'marginBottomMm', false);
  }
  if (patch.marginLeftMm !== undefined) {
    next.marginLeftMm = measurement(patch.marginLeftMm, 2, 'marginLeftMm', false);
  }
  if (patch.fontSizePt !== undefined) {
    next.fontSizePt = measurement(patch.fontSizePt, 2, 'fontSizePt', true);
  }
  if (patch.minFontSizePt !== undefined) {
    next.minFontSizePt = measurement(patch.minFontSizePt, 2, 'minFontSizePt', true);
  }
  if (patch.lineHeight !== undefined) {
    next.lineHeight = measurement(patch.lineHeight, 3, 'lineHeight', true);
  }
  assertTemplateBounds(next, existing.id);
  return next;
}

function changedFields(patch: TemplatePatch, next: TemplateView): TemplateWrite {
  const data: TemplateWrite = {};
  if (patch.name !== undefined) {
    data.name = next.name;
  }
  if (patch.pageWidthMm !== undefined) {
    data.pageWidthMm = next.pageWidthMm;
  }
  if (patch.pageHeightMm !== undefined) {
    data.pageHeightMm = next.pageHeightMm;
  }
  if (patch.marginTopMm !== undefined) {
    data.marginTopMm = next.marginTopMm;
  }
  if (patch.marginRightMm !== undefined) {
    data.marginRightMm = next.marginRightMm;
  }
  if (patch.marginBottomMm !== undefined) {
    data.marginBottomMm = next.marginBottomMm;
  }
  if (patch.marginLeftMm !== undefined) {
    data.marginLeftMm = next.marginLeftMm;
  }
  if (patch.fontSizePt !== undefined) {
    data.fontSizePt = next.fontSizePt;
  }
  if (patch.minFontSizePt !== undefined) {
    data.minFontSizePt = next.minFontSizePt;
  }
  if (patch.lineHeight !== undefined) {
    data.lineHeight = next.lineHeight;
  }
  if (patch.align !== undefined) {
    data.align = next.align;
  }
  if (patch.verticalAlign !== undefined) {
    data.verticalAlign = next.verticalAlign;
  }
  if (patch.isDefault !== undefined) {
    data.isDefault = next.isDefault;
  }
  return data;
}

type TemplateWrite = {
  name?: string;
  pageWidthMm?: string;
  pageHeightMm?: string;
  marginTopMm?: string;
  marginRightMm?: string;
  marginBottomMm?: string;
  marginLeftMm?: string;
  fontSizePt?: string;
  minFontSizePt?: string;
  lineHeight?: string;
  align?: 'left' | 'center';
  verticalAlign?: 'top' | 'middle';
  isDefault?: boolean;
};

function assertTemplateBounds(next: TemplateView, id: string): void {
  assertFitsColumn(next.pageWidthMm, 6, 2, 'pageWidthMm', id);
  assertFitsColumn(next.pageHeightMm, 6, 2, 'pageHeightMm', id);
  assertFitsColumn(next.marginTopMm, 6, 2, 'marginTopMm', id);
  assertFitsColumn(next.marginRightMm, 6, 2, 'marginRightMm', id);
  assertFitsColumn(next.marginBottomMm, 6, 2, 'marginBottomMm', id);
  assertFitsColumn(next.marginLeftMm, 6, 2, 'marginLeftMm', id);
  assertFitsColumn(next.fontSizePt, 6, 2, 'fontSizePt', id);
  assertFitsColumn(next.minFontSizePt, 6, 2, 'minFontSizePt', id);
  assertFitsColumn(next.lineHeight, 6, 3, 'lineHeight', id);
  const width = parseAmount(next.pageWidthMm, 2);
  const height = parseAmount(next.pageHeightMm, 2);
  assertInclusive(width, '20', '500', 'pageWidthMm', id);
  assertInclusive(height, '20', '500', 'pageHeightMm', id);
  assertMargin(next.marginTopMm, height, 'marginTopMm', id);
  assertMargin(next.marginRightMm, width, 'marginRightMm', id);
  assertMargin(next.marginBottomMm, height, 'marginBottomMm', id);
  assertMargin(next.marginLeftMm, width, 'marginLeftMm', id);
  const font = parseAmount(next.fontSizePt, 2);
  const minFont = parseAmount(next.minFontSizePt, 2);
  assertInclusive(font, '4', '72', 'fontSizePt', id);
  assertInclusive(minFont, '4', '72', 'minFontSizePt', id);
  if (minFont.gt(font)) {
    throw new CommerceError(
      400,
      'min_font_above_font',
      'gift_message_template',
      id,
      'minFontSizePt must be at most fontSizePt',
    );
  }
  assertInclusive(parseAmount(next.lineHeight, 3), '0.8', '3', 'lineHeight', id);
}

function assertFitsColumn(
  value: string,
  precision: number,
  scale: number,
  field: string,
  id: string,
): void {
  const amount = parseAmount(value, scale);
  const whole = amount.abs().toFixed(scale).split('.')[0] ?? '0';
  const digits = whole.replace(/^0+/, '');
  if (digits.length > precision - scale) {
    throw new CommerceError(
      400,
      'invalid_measurement',
      field,
      id,
      `${field} exceeds numeric(${String(precision)},${String(scale)})`,
    );
  }
}

function assertInclusive(
  amount: { lt(value: string): boolean; gt(value: string): boolean },
  min: string,
  max: string,
  field: string,
  id: string,
): void {
  if (amount.lt(min) || amount.gt(max)) {
    throw new CommerceError(
      400,
      'invalid_measurement',
      field,
      id,
      `${field} is outside the allowed range`,
    );
  }
}

function assertMargin(
  value: string,
  page: ReturnType<typeof parseAmount>,
  field: string,
  id: string,
): void {
  const margin = parseAmount(value, 2);
  if (margin.lt(0) || !margin.lt(page.div(2))) {
    throw new CommerceError(
      400,
      'invalid_measurement',
      field,
      id,
      `${field} must be zero or more and smaller than half the page`,
    );
  }
}

function measurement(value: unknown, scale: number, field: string, positive: boolean): string {
  let parsed: string;
  try {
    parsed = parseAmount(value, scale).toFixed(scale);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid measurement';
    throw new CommerceError(400, 'invalid_measurement', field, null, message);
  }
  const amount = parseAmount(parsed, scale);
  if (positive ? !amount.gt(0) : amount.lt(0)) {
    throw new CommerceError(
      400,
      'invalid_measurement',
      field,
      null,
      `${field} must be ${positive ? 'positive' : 'zero or positive'}`,
    );
  }
  return parsed;
}

function templateView(row: TemplateRow): TemplateView {
  return {
    id: row.id,
    name: row.name,
    pageWidthMm: fixed(row.pageWidthMm, 2),
    pageHeightMm: fixed(row.pageHeightMm, 2),
    marginTopMm: fixed(row.marginTopMm, 2),
    marginRightMm: fixed(row.marginRightMm, 2),
    marginBottomMm: fixed(row.marginBottomMm, 2),
    marginLeftMm: fixed(row.marginLeftMm, 2),
    fontSizePt: fixed(row.fontSizePt, 2),
    minFontSizePt: fixed(row.minFontSizePt, 2),
    lineHeight: fixed(row.lineHeight, 3),
    align: row.align,
    verticalAlign: row.verticalAlign,
    isDefault: row.isDefault,
  };
}

function cardOf(row: TemplateRow): GiftCard {
  const view = templateView(row);
  return {
    pageWidthMm: view.pageWidthMm,
    pageHeightMm: view.pageHeightMm,
    marginTopMm: view.marginTopMm,
    marginRightMm: view.marginRightMm,
    marginBottomMm: view.marginBottomMm,
    marginLeftMm: view.marginLeftMm,
    fontSizePt: view.fontSizePt,
    minFontSizePt: view.minFontSizePt,
    lineHeight: view.lineHeight,
    align: view.align,
    verticalAlign: view.verticalAlign,
  };
}

function recipientOf(value: unknown): { name: string; lines: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { name: '', lines: [] };
  }
  const record = value as Record<string, unknown>;
  const first = stringField(record, 'firstName');
  const last = stringField(record, 'lastName');
  const name = first.length > 0 && last.length > 0 ? `${first} ${last}` : `${first}${last}`;
  const lines: string[] = [];
  for (const key of ['address1', 'address2'] as const) {
    const line = stringField(record, key);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  const place = [stringField(record, 'zip'), stringField(record, 'city')]
    .filter((part) => part.length > 0)
    .join(' ');
  if (place.length > 0) {
    lines.push(place);
  }
  const country = stringField(record, 'countryCodeV2');
  if (country.length > 0) {
    lines.push(country);
  }
  const phone = stringField(record, 'phone');
  if (phone.length > 0) {
    lines.push(phone);
  }
  return { name, lines };
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}


