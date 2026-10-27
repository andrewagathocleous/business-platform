import { Inject, Injectable } from '@nestjs/common';
import { ALL_ROLE_TEMPLATES } from '@bp/domain';
import { AuditService } from '../audit/audit.service';
import { COMPANY_SWITCH_KEYS } from '../automation/company-switches';
import { PrismaService } from '../database/prisma.service';
import type { RequestMeta } from '../identity/request-meta';

const EXAMPLE_TAX_CODES = [
  { code: 'STD19', name: 'Standard 19% (example — verify with accountant)', rate: '19.0000', kind: 'standard' },
  { code: 'RED9', name: 'Reduced 9% (example — verify with accountant)', rate: '9.0000', kind: 'reduced' },
  { code: 'RED5', name: 'Reduced 5% (example — verify with accountant)', rate: '5.0000', kind: 'reduced' },
  { code: 'ZERO', name: 'Zero 0% (example — verify with accountant)', rate: '0.0000', kind: 'zero' },
  { code: 'EXEMPT', name: 'Exempt 0% (example — verify with accountant)', rate: '0.0000', kind: 'exempt' },
] as const;

export type CompanyInput = {
  legalName: string;
  tradingName: string;
  countryCode: string;
  timezone: string;
  defaultCurrency: string;
  isFictional: boolean;
};

export type CompanyView = {
  id: string;
  legalName: string;
  tradingName: string;
  status: string;
  countryCode: string;
  timezone: string;
  defaultCurrency: string;
  isFictional: boolean;
};

@Injectable()
export class PlatformService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async listCompanies(): Promise<CompanyView[]> {
    const companies = await this.prisma.client.company.findMany({
      orderBy: [{ tradingName: 'asc' }, { id: 'asc' }],
    });
    return companies.map(toCompanyView);
  }

  async createCompany(userId: string, actorLabel: string, input: CompanyInput, meta: RequestMeta): Promise<CompanyView> {
    const created = await this.prisma.client.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          legalName: input.legalName,
          tradingName: input.tradingName,
          countryCode: input.countryCode,
          timezone: input.timezone,
          defaultCurrency: input.defaultCurrency,
          isFictional: input.isFictional,
          status: 'active',
          address: { countryCode: input.countryCode },
        },
      });
      await tx.$queryRaw`SELECT set_config('app.company_id', ${company.id}, true)`;
      for (const template of ALL_ROLE_TEMPLATES) {
        const role = await tx.role.create({
          data: {
            companyId: company.id,
            key: template.key,
            name: template.name,
            description: template.description,
            templateKey: template.key,
          },
        });
        await tx.rolePermission.createMany({
          data: template.permissions.map((permission) => ({ roleId: role.id, permission })),
        });
      }
      await tx.taxCode.createMany({
        data: EXAMPLE_TAX_CODES.map((taxCode) => ({
          companyId: company.id,
          code: taxCode.code,
          name: taxCode.name,
          ratePercent: taxCode.rate,
          kind: taxCode.kind,
          isExample: true,
          active: true,
        })),
      });
      await tx.automationSwitch.createMany({
        data: COMPANY_SWITCH_KEYS.map((key) => ({
          companyId: company.id,
          key,
          enabled: false,
          reason: 'company created',
          updatedById: userId,
        })),
      });
      await this.audit.record(tx, {
        companyId: company.id,
        actorType: 'user',
        actorId: userId,
        actorLabel,
        action: 'company.created',
        objectType: 'company',
        objectId: company.id,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { legalName: input.legalName, tradingName: input.tradingName },
      });
      return company;
    });
    return toCompanyView(created);
  }

  async setOutboundAll(
    userId: string,
    actorLabel: string,
    enabled: boolean,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ key: 'outbound.all'; enabled: boolean; reason: string }> {
    await this.prisma.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.platform_scope', 'on', true)`;
      const existing = await tx.automationSwitch.findFirst({ where: { companyId: null, key: 'outbound.all' } });
      const saved = existing
        ? await tx.automationSwitch.update({
            where: { id: existing.id },
            data: { enabled, reason, updatedById: userId },
          })
        : await tx.automationSwitch.create({
            data: { companyId: null, key: 'outbound.all', enabled, reason, updatedById: userId },
          });
      await this.audit.record(tx, {
        companyId: null,
        actorType: 'user',
        actorId: userId,
        actorLabel,
        action: 'automation_switch.updated',
        objectType: 'automation_switch',
        objectId: saved.id,
        outcome: 'success',
        ip: meta.ip,
        userAgent: meta.userAgent,
        details: { key: 'outbound.all', enabled, reason },
      });
    });
    return { key: 'outbound.all', enabled, reason };
  }
}

function toCompanyView(company: {
  id: string;
  legalName: string;
  tradingName: string;
  status: string;
  countryCode: string;
  timezone: string;
  defaultCurrency: string;
  isFictional: boolean;
}): CompanyView {
  return {
    id: company.id,
    legalName: company.legalName,
    tradingName: company.tradingName,
    status: company.status,
    countryCode: company.countryCode,
    timezone: company.timezone,
    defaultCurrency: company.defaultCurrency,
    isFictional: company.isFictional,
  };
}
