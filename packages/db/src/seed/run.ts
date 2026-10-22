import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { ALL_ROLE_TEMPLATES, normalizeForDuplicateCheck, type TemplateKey } from '@bp/domain';
import { createPrismaClient } from '../client';
import { TenantDb, type TenantTransaction } from '../tenant-db';

loadEnv({ path: resolve(process.cwd(), '.env') });
loadEnv({ path: resolve(process.cwd(), '../../.env') });

const DEV_ISSUER = 'https://dev-login.invalid';
const SWITCH_REASON = 'dev seed: mock provider only';
const GIFT_TEMPLATE_NAME = 'A6 landscape card (placeholder until card stock confirmed)';

const DELIVERY_METHOD_MAP = {
  local: 'courier_cy',
  international: 'post_international',
  collection: 'collection',
};

const SWITCH_KEYS = [
  'printing',
  'email.send',
  'store.write',
  'marketing.send',
  'social.publish',
  'shipment.book',
  'invoice.issue_real',
] as const;

const TAX_CODES = [
  { code: 'STD19', name: 'Standard 19% (example — verify with accountant)', rate: '19.0000', kind: 'standard' },
  { code: 'RED9', name: 'Reduced 9% (example — verify with accountant)', rate: '9.0000', kind: 'reduced' },
  { code: 'RED5', name: 'Reduced 5% (example — verify with accountant)', rate: '5.0000', kind: 'reduced' },
  { code: 'ZERO', name: 'Zero 0% (example — verify with accountant)', rate: '0.0000', kind: 'zero' },
  { code: 'EXEMPT', name: 'Exempt 0% (example — verify with accountant)', rate: '0.0000', kind: 'exempt' },
] as const;

type CompanyKey = 'A' | 'B';

type CompanySeed = {
  key: CompanyKey;
  legalName: string;
  tradingName: string;
  city: string;
  seriesPrefix: string;
  brandName: string;
  locationName: string;
  stores: { name: string; platform: 'shopify' | 'prestashop'; domain: string }[];
  printers: 'shop' | 'online-only';
};

const COMPANIES: CompanySeed[] = [
  {
    key: 'A',
    legalName: 'Demo Company A Ltd (fictional)',
    tradingName: 'Nutbox (demo data)',
    city: 'Nicosia',
    seriesPrefix: 'DEMO-A',
    brandName: 'Nutbox (demo)',
    locationName: 'Demo Shop – Nicosia',
    stores: [
      { name: 'Nutbox Demo Shopify', platform: 'shopify', domain: 'nutbox-demo.shopify.test' },
      { name: 'Nutbox Demo PrestaShop', platform: 'prestashop', domain: 'nutbox-demo.prestashop.test' },
    ],
    printers: 'shop',
  },
  {
    key: 'B',
    legalName: 'Demo Company B Ltd (fictional)',
    tradingName: 'Olive Grove (demo data)',
    city: 'Larnaca',
    seriesPrefix: 'DEMO-B',
    brandName: 'Olive Grove (demo)',
    locationName: 'Demo Shop – Larnaca',
    stores: [
      {
        name: 'Olive Grove Demo Shopify',
        platform: 'shopify',
        domain: 'olive-grove-demo.shopify.test',
      },
    ],
    printers: 'online-only',
  },
];

type MembershipSeed = {
  email: string;
  displayName: string;
  platformOwner?: boolean;
  memberships: {
    company: CompanyKey;
    role: TemplateKey;
    status?: 'active' | 'suspended';
    scope?: { type: 'company' } | { type: 'store'; storeName: string };
  }[];
};

const USERS: MembershipSeed[] = [
  { email: 'owner@example.test', displayName: 'Platform Owner (fictional)', platformOwner: true, memberships: [] },
  {
    email: 'admin.a@example.test',
    displayName: 'Admin A (fictional)',
    memberships: [{ company: 'A', role: 'CA' }],
  },
  {
    email: 'ops.a@example.test',
    displayName: 'Ops A (fictional)',
    memberships: [{ company: 'A', role: 'OM' }],
  },
  {
    email: 'fulfil.a@example.test',
    displayName: 'Fulfilment A (fictional)',
    memberships: [
      { company: 'A', role: 'FS', scope: { type: 'store', storeName: 'Nutbox Demo Shopify' } },
      { company: 'A', role: 'BASE' },
    ],
  },
  {
    email: 'finance.a@example.test',
    displayName: 'Finance A (fictional)',
    memberships: [{ company: 'A', role: 'FIN' }],
  },
  {
    email: 'marketing.a@example.test',
    displayName: 'Marketing A (fictional)',
    memberships: [{ company: 'A', role: 'MKT' }],
  },
  {
    email: 'support.a@example.test',
    displayName: 'Support A (fictional)',
    memberships: [{ company: 'A', role: 'CS' }],
  },
  {
    email: 'multi@example.test',
    displayName: 'Multi Company (fictional)',
    memberships: [
      { company: 'B', role: 'FIN' },
      { company: 'A', role: 'AUD' },
    ],
  },
  {
    email: 'admin.b@example.test',
    displayName: 'Admin B (fictional)',
    memberships: [{ company: 'B', role: 'CA' }],
  },
  {
    email: 'fulfil.b@example.test',
    displayName: 'Fulfilment B (fictional)',
    memberships: [{ company: 'B', role: 'FS' }],
  },
  {
    email: 'suspended.a@example.test',
    displayName: 'Suspended A (fictional)',
    memberships: [{ company: 'A', role: 'FS', status: 'suspended' }],
  },
];

async function main(): Promise<void> {
  const ownerUrl = process.env['DATABASE_URL_OWNER'];
  if (!ownerUrl) {
    throw new Error('DATABASE_URL_OWNER is required');
  }
  if (process.env['BP_SEED_TARGET'] === 'test') {
    const name = new URL(ownerUrl).pathname.replace(/^\//, '');
    if (name !== 'business_platform_test') {
      throw new Error('BP_SEED_TARGET=test requires the business_platform_test database');
    }
  }
  const username = new URL(ownerUrl).username;
  if (username !== 'bp_owner') {
    throw new Error('seed must connect as bp_owner');
  }

  const prisma = createPrismaClient(ownerUrl);
  const tenant = new TenantDb(prisma);
  const correlationId = randomUUID();

  try {
    const users = new Map<string, string>();
    for (const user of USERS) {
      const saved = await prisma.userAccount.upsert({
        where: { email: user.email },
        create: {
          email: user.email,
          displayName: user.displayName,
          locale: 'en',
          isPlatformOwner: user.platformOwner ?? false,
          status: 'active',
        },
        update: {
          displayName: user.displayName,
          isPlatformOwner: user.platformOwner ?? false,
          status: 'active',
        },
      });
      await prisma.userIdentity.upsert({
        where: {
          provider_issuer_subject: { provider: 'dev', issuer: DEV_ISSUER, subject: user.email },
        },
        create: {
          userId: saved.id,
          provider: 'dev',
          issuer: DEV_ISSUER,
          subject: user.email,
          emailAtLink: user.email,
        },
        update: { userId: saved.id, emailAtLink: user.email },
      });
      users.set(user.email, saved.id);
    }

    const ownerId = users.get('owner@example.test');
    if (!ownerId) {
      throw new Error('platform owner was not seeded');
    }

    const companies = new Map<CompanyKey, string>();
    const stores = new Map<string, string>();

    for (const company of COMPANIES) {
      const existing = await prisma.company.findFirst({ where: { legalName: company.legalName } });
      const address = {
        line1: '1 Demo Street',
        city: company.city,
        countryCode: 'CY',
        note: 'fictional address',
      };
      const saved = existing
        ? await prisma.company.update({
            where: { id: existing.id },
            data: {
              tradingName: company.tradingName,
              address,
              isFictional: true,
              status: 'active',
              timezone: 'Asia/Nicosia',
              defaultCurrency: 'EUR',
              defaultLocale: 'en',
              documentLanguage: 'en',
              countryCode: 'CY',
              vatNumber: null,
            },
          })
        : await prisma.company.create({
            data: {
              legalName: company.legalName,
              tradingName: company.tradingName,
              address,
              isFictional: true,
              status: 'active',
              timezone: 'Asia/Nicosia',
              defaultCurrency: 'EUR',
              defaultLocale: 'en',
              documentLanguage: 'en',
              countryCode: 'CY',
            },
          });
      companies.set(company.key, saved.id);

      for (const template of ALL_ROLE_TEMPLATES) {
        const role = await prisma.role.upsert({
          where: { companyId_key: { companyId: saved.id, key: template.key } },
          create: {
            companyId: saved.id,
            key: template.key,
            name: template.name,
            description: template.description,
            templateKey: template.key,
          },
          update: {
            name: template.name,
            description: template.description,
            templateKey: template.key,
          },
        });
        for (const permission of template.permissions) {
          await prisma.rolePermission.upsert({
            where: { roleId_permission: { roleId: role.id, permission } },
            create: { roleId: role.id, permission },
            update: {},
          });
        }
      }

      const storeIds = await tenant.run(
        { companyId: saved.id, actor: ownerId, correlationId },
        (tx) => seedCompanyData(tx, company, saved.id, ownerId),
        { timeoutMs: 30_000 },
      );
      for (const [name, id] of storeIds) {
        stores.set(name, id);
      }
    }

    for (const user of USERS) {
      const userId = users.get(user.email);
      if (!userId) {
        throw new Error(`missing user ${user.email}`);
      }
      for (const membership of user.memberships) {
        const companyId = companies.get(membership.company);
        if (!companyId) {
          throw new Error(`missing company ${membership.company}`);
        }
        const status = membership.status ?? 'active';
        const savedMembership = await prisma.membership.upsert({
          where: { userId_companyId: { userId, companyId } },
          create: {
            userId,
            companyId,
            status,
            suspendedAt: status === 'suspended' ? new Date() : null,
            removedAt: null,
          },
          update: {
            status,
            suspendedAt: status === 'suspended' ? new Date() : null,
            removedAt: null,
          },
        });
        const role = await prisma.role.findUniqueOrThrow({
          where: { companyId_key: { companyId, key: membership.role } },
        });
        const scope = membership.scope ?? { type: 'company' as const };
        const scopeId = scope.type === 'store' ? stores.get(scope.storeName) : null;
        if (scope.type === 'store' && !scopeId) {
          throw new Error(`missing store ${scope.storeName}`);
        }
        const existingRole = await prisma.membershipRole.findFirst({
          where: {
            membershipId: savedMembership.id,
            roleId: role.id,
            scopeType: scope.type,
            scopeId,
          },
        });
        if (!existingRole) {
          await prisma.membershipRole.create({
            data: {
              membershipId: savedMembership.id,
              roleId: role.id,
              scopeType: scope.type,
              scopeId,
              grantedById: ownerId,
            },
          });
        }
      }
    }

    await upsertSwitch(prisma, null, 'outbound.all', true, ownerId);
    for (const company of COMPANIES) {
      const companyId = companies.get(company.key);
      if (!companyId) {
        throw new Error(`missing company ${company.key}`);
      }
      for (const key of SWITCH_KEYS) {
        const enabled = key === 'printing' && company.key === 'A';
        await upsertSwitch(prisma, companyId, key, enabled, ownerId);
      }
    }

    console.log('Seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

async function seedCompanyData(
  tx: TenantTransaction,
  company: CompanySeed,
  companyId: string,
  ownerId: string,
): Promise<Map<string, string>> {
  const brand = await upsertByName(tx.brand, companyId, company.brandName, {
    companyId,
    name: company.brandName,
  });
  const location = await upsertLocation(tx, companyId, company);
  const storeIds = new Map<string, string>();
  for (const store of company.stores) {
    const saved = await upsertStore(tx, companyId, brand.id, location.id, store);
    storeIds.set(store.name, saved);
    await upsertConnection(tx, companyId, saved);
  }

  const taxIds = new Map<string, string>();
  for (const taxCode of TAX_CODES) {
    const saved = await tx.taxCode.upsert({
      where: { companyId_code: { companyId, code: taxCode.code } },
      create: {
        companyId,
        code: taxCode.code,
        name: taxCode.name,
        ratePercent: taxCode.rate,
        kind: taxCode.kind,
        isExample: true,
        active: true,
      },
      update: {
        name: taxCode.name,
        ratePercent: taxCode.rate,
        kind: taxCode.kind,
        isExample: true,
        active: true,
      },
    });
    taxIds.set(taxCode.code, saved.id);
  }

  const standardTaxId = taxIds.get('STD19');
  if (!standardTaxId) {
    throw new Error('STD19 was not seeded');
  }
  await seedProducts(tx, companyId, standardTaxId);
  await seedClients(tx, companyId, company.key, ownerId);
  await seedSeries(tx, companyId, company.seriesPrefix);
  await seedGiftTemplate(tx, companyId);
  await seedPrinters(tx, companyId, location.id, company.printers);
  return storeIds;
}

async function upsertByName(
  delegate: {
    findFirst: (args: { where: { companyId: string; name: string } }) => Promise<{ id: string } | null>;
    update: (args: { where: { id: string }; data: { name: string } }) => Promise<{ id: string }>;
    create: (args: { data: { companyId: string; name: string } }) => Promise<{ id: string }>;
  },
  companyId: string,
  name: string,
  data: { companyId: string; name: string },
): Promise<{ id: string }> {
  const existing = await delegate.findFirst({ where: { companyId, name } });
  if (existing) {
    return delegate.update({ where: { id: existing.id }, data: { name } });
  }
  return delegate.create({ data });
}

async function upsertLocation(
  tx: TenantTransaction,
  companyId: string,
  company: CompanySeed,
): Promise<{ id: string }> {
  const address = { line1: '1 Demo Street', city: company.city, countryCode: 'CY' };
  const existing = await tx.location.findFirst({ where: { companyId, name: company.locationName } });
  if (existing) {
    return tx.location.update({
      where: { id: existing.id },
      data: { address, timezone: 'Asia/Nicosia' },
    });
  }
  return tx.location.create({
    data: { companyId, name: company.locationName, address, timezone: 'Asia/Nicosia' },
  });
}

async function upsertStore(
  tx: TenantTransaction,
  companyId: string,
  brandId: string,
  locationId: string,
  store: CompanySeed['stores'][number],
): Promise<string> {
  const data = {
    brandId,
    locationId,
    platform: store.platform,
    domain: store.domain,
    invoiceAuthority: 'undecided' as const,
    deliveryMethodMap: DELIVERY_METHOD_MAP,
    status: 'active',
  };
  const existing = await tx.store.findFirst({ where: { companyId, name: store.name } });
  if (existing) {
    const updated = await tx.store.update({ where: { id: existing.id }, data });
    return updated.id;
  }
  const created = await tx.store.create({ data: { companyId, name: store.name, ...data } });
  return created.id;
}

async function upsertConnection(tx: TenantTransaction, companyId: string, storeId: string): Promise<void> {
  const existing = await tx.storeConnection.findFirst({ where: { companyId, storeId } });
  const data = {
    mode: 'mock' as const,
    status: 'active',
    readOnly: true,
    writeBackEnabled: false,
  };
  if (existing) {
    await tx.storeConnection.update({ where: { id: existing.id }, data });
    return;
  }
  await tx.storeConnection.create({ data: { companyId, storeId, ...data } });
}

async function seedProducts(tx: TenantTransaction, companyId: string, taxCodeId: string): Promise<void> {
  const products = [
    { sku: 'NUTS', name: 'Mixed nuts (demo)', kind: 'product' as const, unit: 'kg', unitPrice: '12.5000' },
    { sku: 'GIFTBOX', name: 'Gift box (demo)', kind: 'product' as const, unit: 'box', unitPrice: '18.0000' },
    { sku: 'WRAP', name: 'Gift wrapping (demo)', kind: 'service' as const, unit: 'job', unitPrice: '3.0000' },
    { sku: 'SHIP', name: 'Local delivery (demo)', kind: 'shipping' as const, unit: 'shipment', unitPrice: '5.0000' },
  ];
  for (const product of products) {
    const existing = await tx.product.findFirst({ where: { companyId, sku: product.sku } });
    const data = {
      name: product.name,
      kind: product.kind,
      unit: product.unit,
      unitPrice: product.unitPrice,
      pricesIncludeTax: true,
      taxCodeId,
      active: true,
    };
    if (existing) {
      await tx.product.update({ where: { id: existing.id }, data });
    } else {
      await tx.product.create({ data: { companyId, sku: product.sku, ...data } });
    }
  }
}

async function seedClients(
  tx: TenantTransaction,
  companyId: string,
  companyKey: CompanyKey,
  ownerId: string,
): Promise<void> {
  const suffix = companyKey.toLowerCase();
  const organisationEmail = `gifts.${suffix}@example.test`;
  const organisation = await upsertClient(tx, companyId, ownerId, {
    kind: 'organisation',
    displayName: 'Demo Gifts Ltd (fictional)',
    legalName: 'Demo Gifts Ltd (fictional)',
    email: organisationEmail,
    defaultLanguage: 'en',
    paymentTermsDays: 30,
  });
  await upsertAddress(tx, companyId, organisation, 'billing', 'Billing', '1 Demo Street');
  await upsertAddress(tx, companyId, organisation, 'shipping', 'Shipping', '2 Demo Warehouse');
  const contact = await tx.clientContact.findFirst({
    where: { companyId, clientId: organisation, email: `reception.${suffix}@example.test` },
  });
  const contactData = {
    name: 'Demo Reception (fictional)',
    phone: '+35700000000',
    position: 'Reception',
    isPrimary: true,
  };
  if (contact) {
    await tx.clientContact.update({ where: { id: contact.id }, data: contactData });
  } else {
    await tx.clientContact.create({
      data: {
        companyId,
        clientId: organisation,
        email: `reception.${suffix}@example.test`,
        ...contactData,
      },
    });
  }

  await upsertClient(tx, companyId, ownerId, {
    kind: 'individual',
    displayName: 'Μαρία Παπαδοπούλου',
    email: `maria.papadopoulou.${suffix}@example.test`,
    defaultLanguage: 'el',
  });
  await upsertClient(tx, companyId, ownerId, {
    kind: 'individual',
    displayName: 'Γιώργος Νικολάου',
    email: `giorgos.nikolaou.${suffix}@example.test`,
    defaultLanguage: 'el',
  });
}

async function upsertClient(
  tx: TenantTransaction,
  companyId: string,
  ownerId: string,
  input: {
    kind: 'organisation' | 'individual';
    displayName: string;
    legalName?: string;
    email: string;
    defaultLanguage: string;
    paymentTermsDays?: number;
  },
): Promise<string> {
  const data = {
    kind: input.kind,
    displayName: input.displayName,
    legalName: input.legalName ?? null,
    email: input.email,
    defaultCurrency: 'EUR',
    defaultLanguage: input.defaultLanguage,
    paymentTermsDays: input.paymentTermsDays ?? null,
    nameNormalized: normalizeForDuplicateCheck(input.displayName),
    emailNormalized: normalizeForDuplicateCheck(input.email),
    createdById: ownerId,
  };
  const existing = await tx.client.findFirst({ where: { companyId, email: input.email } });
  if (existing) {
    const updated = await tx.client.update({ where: { id: existing.id }, data });
    return updated.id;
  }
  const created = await tx.client.create({ data: { companyId, ...data } });
  return created.id;
}

async function upsertAddress(
  tx: TenantTransaction,
  companyId: string,
  clientId: string,
  kind: 'billing' | 'shipping',
  label: string,
  line1: string,
): Promise<void> {
  const existing = await tx.clientAddress.findFirst({ where: { companyId, clientId, kind } });
  const data = {
    label,
    line1,
    city: 'Nicosia',
    countryCode: 'CY',
    isDefault: true,
  };
  if (existing) {
    await tx.clientAddress.update({ where: { id: existing.id }, data });
    return;
  }
  await tx.clientAddress.create({ data: { companyId, clientId, kind, ...data } });
}

async function seedSeries(tx: TenantTransaction, companyId: string, seriesPrefix: string): Promise<void> {
  const series = [
    { code: 'INV', documentType: 'invoice' as const, prefix: `${seriesPrefix}-INV-` },
    { code: 'CN', documentType: 'credit_note' as const, prefix: `${seriesPrefix}-CN-` },
    { code: 'QUO', documentType: 'quote' as const, prefix: `${seriesPrefix}-QUO-` },
  ];
  for (const item of series) {
    await tx.invoiceSeries.upsert({
      where: { companyId_code: { companyId, code: item.code } },
      create: {
        companyId,
        code: item.code,
        documentType: item.documentType,
        prefix: item.prefix,
        nextNumber: 1,
        padding: 4,
        active: true,
      },
      update: { documentType: item.documentType, prefix: item.prefix, active: true },
    });
  }
}

async function seedGiftTemplate(tx: TenantTransaction, companyId: string): Promise<void> {
  const data = {
    pageWidthMm: '148.00',
    pageHeightMm: '105.00',
    marginTopMm: '12.00',
    marginRightMm: '12.00',
    marginBottomMm: '12.00',
    marginLeftMm: '12.00',
    fontSizePt: '16.00',
    minFontSizePt: '10.00',
    lineHeight: '1.200',
    align: 'center' as const,
    verticalAlign: 'middle' as const,
    isDefault: true,
  };
  const existing = await tx.giftMessageTemplate.findFirst({
    where: { companyId, name: GIFT_TEMPLATE_NAME },
  });
  if (existing) {
    await tx.giftMessageTemplate.update({ where: { id: existing.id }, data });
    return;
  }
  await tx.giftMessageTemplate.create({ data: { companyId, name: GIFT_TEMPLATE_NAME, ...data } });
}

async function seedPrinters(
  tx: TenantTransaction,
  companyId: string,
  locationId: string,
  kind: CompanySeed['printers'],
): Promise<void> {
  const onlineId = await upsertPrinter(tx, companyId, locationId, {
    externalPrinterId: 'mock-laserjet-online',
    name: 'Mock LaserJet (online)',
    description: 'Simulated — no physical printing. Submits succeed.',
    paperSizes: ['A4', 'A6'],
    status: 'online',
  });
  if (kind === 'shop') {
    await upsertPrinter(tx, companyId, locationId, {
      externalPrinterId: 'mock-offline',
      name: 'Mock Offline Printer',
      description: 'Simulated — no physical printing. Submits fail with printer_offline.',
      paperSizes: ['A4'],
      status: 'offline',
    });
    await upsertPrinter(tx, companyId, locationId, {
      externalPrinterId: 'mock-flaky',
      name: 'Mock Flaky Printer',
      description: 'Simulated — no physical printing. Submits time out and yield uncertain.',
      paperSizes: ['A4'],
      status: 'unknown',
    });
    await upsertMapping(tx, companyId, locationId, onlineId, 'packing_slip', 'A4');
    await upsertMapping(tx, companyId, locationId, onlineId, 'gift_message', 'A6');
  }
}

async function upsertPrinter(
  tx: TenantTransaction,
  companyId: string,
  locationId: string,
  input: {
    externalPrinterId: string;
    name: string;
    description: string;
    paperSizes: string[];
    status: 'online' | 'offline' | 'unknown';
  },
): Promise<string> {
  const saved = await tx.printer.upsert({
    where: {
      companyId_provider_externalPrinterId: {
        companyId,
        provider: 'mock',
        externalPrinterId: input.externalPrinterId,
      },
    },
    create: {
      companyId,
      locationId,
      provider: 'mock',
      externalPrinterId: input.externalPrinterId,
      name: input.name,
      description: input.description,
      paperSizes: input.paperSizes,
      status: input.status,
    },
    update: {
      locationId,
      name: input.name,
      description: input.description,
      paperSizes: input.paperSizes,
      status: input.status,
    },
  });
  return saved.id;
}

async function upsertMapping(
  tx: TenantTransaction,
  companyId: string,
  locationId: string,
  printerId: string,
  documentType: 'packing_slip' | 'gift_message',
  paperSize: string,
): Promise<void> {
  await tx.printerMapping.upsert({
    where: {
      companyId_locationId_documentType: { companyId, locationId, documentType },
    },
    create: { companyId, locationId, documentType, printerId, paperSize, copies: 1 },
    update: { printerId, paperSize, copies: 1 },
  });
}

async function upsertSwitch(
  prisma: ReturnType<typeof createPrismaClient>,
  companyId: string | null,
  key: string,
  enabled: boolean,
  updatedById: string,
): Promise<void> {
  const existing = await prisma.automationSwitch.findFirst({ where: { companyId, key } });
  const data = {
    enabled,
    reason: enabled ? SWITCH_REASON : null,
    updatedById,
  };
  if (existing) {
    await prisma.automationSwitch.update({ where: { id: existing.id }, data });
    return;
  }
  await prisma.automationSwitch.create({ data: { companyId, key, ...data } });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
