import { Inject, Injectable } from '@nestjs/common';
import { TenantDb, type TenantTransaction } from '@bp/db';
import { normalizeForDuplicateCheck } from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { isUuid } from '../authz/company-path';
import type { RequestContext } from '../authz/request-context';
import { CommerceError, settleCommerceError } from '../commerce/errors';
import { requireActor } from '../commerce/http';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';

export type ContactInput = {
  id?: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  position?: string | null;
  isPrimary?: boolean;
};

export type AddressInput = {
  id?: string;
  kind: 'billing' | 'shipping';
  label?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  countryCode: string;
  isDefault?: boolean;
};

export type ClientWrite = {
  kind: 'organisation' | 'individual';
  displayName: string;
  legalName?: string | null;
  vatNumber?: string | null;
  taxId?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  notes?: string | null;
  defaultCurrency?: string | null;
  defaultLanguage?: string | null;
  paymentTermsDays?: number | null;
  acceptsEInvoices?: boolean;
  contacts?: ContactInput[];
  addresses?: AddressInput[];
};

export type ClientPatch = Partial<ClientWrite> & {
  expectedVersion: number;
  archived?: boolean;
};

export type ClientListQuery = {
  q?: string;
  includeArchived: boolean;
};

export type DuplicateCheck = {
  displayName?: string;
  email?: string;
  vatNumber?: string;
  excludeClientId?: string;
};

export type ContactView = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  position: string | null;
  isPrimary: boolean;
};

export type AddressView = {
  id: string;
  kind: 'billing' | 'shipping';
  label: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  isDefault: boolean;
};

export type ClientView = {
  id: string;
  kind: 'organisation' | 'individual';
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  defaultCurrency: string | null;
  defaultLanguage: string | null;
  paymentTermsDays: number | null;
  acceptsEInvoices: boolean;
  archivedAt: string | null;
  version: number;
  contacts: ContactView[];
  addresses: AddressView[];
  createdAt: string;
  updatedAt: string;
};

const clientInclude = {
  contacts: {
    orderBy: [{ isPrimary: 'desc' as const }, { name: 'asc' as const }, { id: 'asc' as const }],
  },
  addresses: {
    orderBy: [{ kind: 'asc' as const }, { isDefault: 'desc' as const }, { id: 'asc' as const }],
  },
};

type ClientRow = {
  id: string;
  kind: 'organisation' | 'individual';
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  defaultCurrency: string | null;
  defaultLanguage: string | null;
  paymentTermsDays: number | null;
  acceptsEInvoices: boolean;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  contacts: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    position: string | null;
    isPrimary: boolean;
  }[];
  addresses: {
    id: string;
    kind: 'billing' | 'shipping';
    label: string | null;
    line1: string;
    line2: string | null;
    city: string;
    region: string | null;
    postalCode: string | null;
    countryCode: string;
    isDefault: boolean;
  }[];
};

@Injectable()
export class ClientService {
  private readonly tenants: TenantDb;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    this.tenants = new TenantDb(prisma.client);
  }

  async list(ctx: RequestContext, query: ClientListQuery): Promise<ClientView[]> {
    const actor = requireActor(ctx);
    const rows = await this.tenants.run(this.context(ctx, actor), (tx) =>
      tx.client.findMany({
        where: {
          companyId: ctx.companyId,
          ...(query.includeArchived ? {} : { archivedAt: null }),
          ...(query.q ? { OR: textFilter(query.q) } : {}),
        },
        include: clientInclude,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map((row) => toClient(row));
  }

  async get(ctx: RequestContext, clientId: string, meta: RequestMeta): Promise<ClientView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const row = await this.load(tx, ctx.companyId, clientId);
        return toClient(row);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async create(ctx: RequestContext, input: ClientWrite, meta: RequestMeta): Promise<ClientView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const data = clientData(input);
        assertChildren(input.contacts ?? [], input.addresses ?? []);
        const created = await tx.client.create({
          data: {
            companyId: ctx.companyId,
            ...data,
            createdById: actor,
          },
        });
        await this.replaceContacts(tx, ctx.companyId, created.id, input.contacts ?? [], []);
        await this.replaceAddresses(tx, ctx.companyId, created.id, input.addresses ?? [], []);
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'client.created',
          objectType: 'client',
          objectId: created.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          // Agreement to electronic invoices is consent evidence (reg. 11A(1)(γ)), so it is recorded.
          details: { version: created.version, acceptsEInvoices: created.acceptsEInvoices },
        });
        return toClient(await this.load(tx, ctx.companyId, created.id));
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async update(
    ctx: RequestContext,
    clientId: string,
    patch: ClientPatch,
    meta: RequestMeta,
  ): Promise<ClientView> {
    const actor = requireActor(ctx);
    try {
      return await this.tenants.run(this.context(ctx, actor), async (tx) => {
        const current = await this.load(tx, ctx.companyId, clientId);
        if (current.version !== patch.expectedVersion) {
          throw new CommerceError(
            409,
            'version_conflict',
            'client',
            current.id,
            'version conflict',
          );
        }
        const next = merged(current, patch);
        assertChildren(patch.contacts ?? current.contacts, patch.addresses ?? current.addresses);
        const written = await tx.client.updateMany({
          where: { id: current.id, companyId: ctx.companyId, version: patch.expectedVersion },
          data: {
            ...clientData(next),
            archivedAt:
              patch.archived === undefined
                ? current.archivedAt
                : patch.archived
                  ? new Date()
                  : null,
            version: { increment: 1 },
          },
        });
        if (written.count !== 1) {
          throw new CommerceError(
            409,
            'version_conflict',
            'client',
            current.id,
            'version conflict',
          );
        }
        if (patch.contacts) {
          await this.replaceContacts(
            tx,
            ctx.companyId,
            current.id,
            patch.contacts,
            current.contacts,
          );
        }
        if (patch.addresses) {
          await this.replaceAddresses(
            tx,
            ctx.companyId,
            current.id,
            patch.addresses,
            current.addresses,
          );
        }
        const saved = await this.load(tx, ctx.companyId, current.id);
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          actorType: 'user',
          actorId: actor,
          actorLabel: ctx.actorLabel,
          action: 'client.updated',
          objectType: 'client',
          objectId: saved.id,
          outcome: 'success',
          ip: meta.ip,
          userAgent: meta.userAgent,
          details: {
            version: saved.version,
            archived: saved.archivedAt !== null,
            ...(saved.acceptsEInvoices !== current.acceptsEInvoices
              ? { acceptsEInvoices: saved.acceptsEInvoices }
              : {}),
          },
        });
        return toClient(saved);
      });
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  async duplicateCheck(
    ctx: RequestContext,
    input: DuplicateCheck,
    meta: RequestMeta,
  ): Promise<
    { id: string; displayName: string; archivedAt: string | null; matchedOn: string[] }[]
  > {
    const actor = requireActor(ctx);
    try {
      const name = input.displayName === undefined ? null : duplicateKey(input.displayName);
      const email = input.email === undefined ? null : duplicateKey(input.email);
      const vat = input.vatNumber === undefined ? null : duplicateKey(input.vatNumber);
      if (!name && !email && !vat) {
        throw new CommerceError(400, 'empty_duplicate_check', 'client', null, 'nothing to check');
      }
      if (input.excludeClientId !== undefined && !isUuid(input.excludeClientId)) {
        throw new CommerceError(400, 'invalid_id', 'client', null, 'excludeClientId is invalid');
      }
      const rows = await this.tenants.run(this.context(ctx, actor), (tx) =>
        tx.client.findMany({
          where: {
            companyId: ctx.companyId,
            ...(input.excludeClientId ? { id: { not: input.excludeClientId.toLowerCase() } } : {}),
            OR: [
              ...(name ? [{ nameNormalized: name }] : []),
              ...(email ? [{ emailNormalized: email }] : []),
              ...(vat ? [{ vatNormalized: vat }] : []),
            ],
          },
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
          take: 20,
        }),
      );
      return rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        matchedOn: [
          ...(name && row.nameNormalized === name ? ['name'] : []),
          ...(email && row.emailNormalized === email ? ['email'] : []),
          ...(vat && row.vatNormalized === vat ? ['vat'] : []),
        ],
      }));
    } catch (error) {
      return this.fail(ctx, meta, error);
    }
  }

  private context(ctx: RequestContext, actor: string) {
    return { companyId: ctx.companyId, actor, correlationId: ctx.correlationId };
  }

  private async load(
    tx: TenantTransaction,
    companyId: string,
    clientId: string,
  ): Promise<ClientRow> {
    if (!isUuid(clientId)) {
      throw new CommerceError(404, 'client_not_found', 'client', null, 'Not found');
    }
    const row = await tx.client.findFirst({
      where: { id: clientId.toLowerCase(), companyId },
      include: clientInclude,
    });
    if (!row) {
      throw new CommerceError(
        404,
        'client_not_found',
        'client',
        clientId.toLowerCase(),
        'Not found',
      );
    }
    return row;
  }

  private async replaceContacts(
    tx: TenantTransaction,
    companyId: string,
    clientId: string,
    contacts: ContactInput[],
    existing: { id: string }[],
  ): Promise<void> {
    const known = new Set(existing.map((contact) => contact.id));
    const keep: string[] = [];
    for (const contact of contacts) {
      const data = {
        name: contact.name,
        email: contact.email ?? null,
        phone: contact.phone ?? null,
        position: contact.position ?? null,
        isPrimary: contact.isPrimary ?? false,
      };
      if (contact.id) {
        const id = contact.id.toLowerCase();
        if (!isUuid(id)) {
          throw new CommerceError(
            400,
            'contact_not_found',
            'client_contact',
            null,
            'contact was not found',
          );
        }
        if (!known.has(id)) {
          throw new CommerceError(404, 'contact_not_found', 'client_contact', id, 'Not found');
        }
        keep.push(id);
        await tx.clientContact.update({ where: { id }, data });
      } else {
        const created = await tx.clientContact.create({ data: { companyId, clientId, ...data } });
        keep.push(created.id);
      }
    }
    await tx.clientContact.deleteMany({
      where: { companyId, clientId, ...(keep.length > 0 ? { id: { notIn: keep } } : {}) },
    });
  }

  private async replaceAddresses(
    tx: TenantTransaction,
    companyId: string,
    clientId: string,
    addresses: AddressInput[],
    existing: { id: string }[],
  ): Promise<void> {
    const known = new Set(existing.map((address) => address.id));
    const keep: string[] = [];
    for (const address of addresses) {
      const data = {
        kind: address.kind,
        label: address.label ?? null,
        line1: address.line1,
        line2: address.line2 ?? null,
        city: address.city,
        region: address.region ?? null,
        postalCode: address.postalCode ?? null,
        countryCode: address.countryCode,
        isDefault: address.isDefault ?? false,
      };
      if (address.id) {
        const id = address.id.toLowerCase();
        if (!isUuid(id)) {
          throw new CommerceError(
            400,
            'address_not_found',
            'client_address',
            null,
            'address was not found',
          );
        }
        if (!known.has(id)) {
          throw new CommerceError(404, 'address_not_found', 'client_address', id, 'Not found');
        }
        keep.push(id);
        await tx.clientAddress.update({ where: { id }, data });
      } else {
        const created = await tx.clientAddress.create({ data: { companyId, clientId, ...data } });
        keep.push(created.id);
      }
    }
    await tx.clientAddress.deleteMany({
      where: { companyId, clientId, ...(keep.length > 0 ? { id: { notIn: keep } } : {}) },
    });
  }

  private fail(ctx: RequestContext, meta: RequestMeta, error: unknown): Promise<never> {
    if (error instanceof CommerceError) {
      return settleCommerceError(this.audit, this.prisma, ctx, meta, error);
    }
    throw error;
  }
}

function clientData(input: ClientWrite) {
  const displayName = input.displayName;
  const nameKey = duplicateKey(displayName);
  if (!nameKey) {
    throw new CommerceError(400, 'empty_name', 'client', null, 'displayName is empty');
  }
  const email = input.email ?? null;
  const vatNumber = input.vatNumber ?? null;
  return {
    kind: input.kind,
    displayName,
    legalName: input.legalName ?? null,
    vatNumber,
    taxId: input.taxId ?? null,
    email,
    phone: input.phone ?? null,
    website: input.website ?? null,
    notes: input.notes ?? null,
    defaultCurrency: input.defaultCurrency ?? null,
    defaultLanguage: input.defaultLanguage ?? null,
    paymentTermsDays: input.paymentTermsDays ?? null,
    acceptsEInvoices: input.acceptsEInvoices ?? false,
    nameNormalized: nameKey,
    emailNormalized: duplicateKey(email),
    vatNormalized: duplicateKey(vatNumber),
  };
}

function merged(current: ClientRow, patch: ClientPatch): ClientWrite {
  return {
    kind: patch.kind ?? current.kind,
    displayName: patch.displayName ?? current.displayName,
    legalName: patch.legalName === undefined ? current.legalName : patch.legalName,
    vatNumber: patch.vatNumber === undefined ? current.vatNumber : patch.vatNumber,
    taxId: patch.taxId === undefined ? current.taxId : patch.taxId,
    email: patch.email === undefined ? current.email : patch.email,
    phone: patch.phone === undefined ? current.phone : patch.phone,
    website: patch.website === undefined ? current.website : patch.website,
    notes: patch.notes === undefined ? current.notes : patch.notes,
    defaultCurrency:
      patch.defaultCurrency === undefined ? current.defaultCurrency : patch.defaultCurrency,
    defaultLanguage:
      patch.defaultLanguage === undefined ? current.defaultLanguage : patch.defaultLanguage,
    paymentTermsDays:
      patch.paymentTermsDays === undefined ? current.paymentTermsDays : patch.paymentTermsDays,
    acceptsEInvoices: patch.acceptsEInvoices ?? current.acceptsEInvoices,
  };
}

function assertChildren(
  contacts: { isPrimary?: boolean }[],
  addresses: { kind: string; isDefault?: boolean }[],
): void {
  if (contacts.filter((contact) => contact.isPrimary).length > 1) {
    throw new CommerceError(
      400,
      'multiple_primary_contacts',
      'client',
      null,
      'only one contact can be primary',
    );
  }
  for (const kind of ['billing', 'shipping']) {
    if (addresses.filter((address) => address.kind === kind && address.isDefault).length > 1) {
      throw new CommerceError(
        400,
        'multiple_default_addresses',
        'client',
        null,
        `only one default ${kind} address`,
      );
    }
  }
}

function duplicateKey(value: string | null): string | null {
  if (value == null || value.length === 0) {
    return null;
  }
  const key = normalizeForDuplicateCheck(value);
  return key.length === 0 ? null : key;
}

function textFilter(q: string) {
  const contains = { contains: q, mode: 'insensitive' as const };
  return [
    { displayName: contains },
    { legalName: contains },
    { email: contains },
    { vatNumber: contains },
    { phone: contains },
  ];
}

function toClient(row: ClientRow): ClientView {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    legalName: row.legalName,
    vatNumber: row.vatNumber,
    taxId: row.taxId,
    email: row.email,
    phone: row.phone,
    website: row.website,
    notes: row.notes,
    defaultCurrency: row.defaultCurrency,
    defaultLanguage: row.defaultLanguage,
    paymentTermsDays: row.paymentTermsDays,
    acceptsEInvoices: row.acceptsEInvoices,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
    contacts: row.contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      position: contact.position,
      isPrimary: contact.isPrimary,
    })),
    addresses: row.addresses.map((address) => ({
      id: address.id,
      kind: address.kind,
      label: address.label,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      region: address.region,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
      isDefault: address.isDefault,
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
