export type CompanyAddress = {
  line1: string;
  line2?: string;
  city: string;
  postcode?: string;
  countryCode: string;
};

export type CompanyDetails = {
  id: string;
  version: number;
  legalName: string;
  tradingName: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  taxOffice: string | null;
  address: unknown;
  timezone: string;
  defaultCurrency: string;
  defaultLocale: 'en' | 'el';
  documentLanguage: 'en' | 'el';
  paymentTermsDays: number;
  countryCode: string;
  status: string;
};

export function companyDetails(company: {
  id: string;
  version: number;
  legalName: string;
  tradingName: string;
  registrationNumber: string | null;
  vatNumber: string | null;
  taxOffice: string | null;
  address: unknown;
  timezone: string;
  defaultCurrency: string;
  defaultLocale: 'en' | 'el';
  documentLanguage: 'en' | 'el';
  paymentTermsDays: number;
  countryCode: string;
  status: string;
}): CompanyDetails {
  return {
    id: company.id,
    version: company.version,
    legalName: company.legalName,
    tradingName: company.tradingName,
    registrationNumber: company.registrationNumber,
    vatNumber: company.vatNumber,
    taxOffice: company.taxOffice,
    address: company.address,
    timezone: company.timezone,
    defaultCurrency: company.defaultCurrency,
    defaultLocale: company.defaultLocale,
    documentLanguage: company.documentLanguage,
    paymentTermsDays: company.paymentTermsDays,
    countryCode: company.countryCode,
    status: company.status,
  };
}
