export type Locale = 'en' | 'el';

export type MeUser = {
  id: string;
  email: string;
  displayName: string;
  locale: Locale;
  isPlatformOwner: boolean;
};

export type CompanySummary = {
  id: string;
  legalName: string;
  tradingName: string;
  status: string;
};

export type MeResponse = {
  user: MeUser;
  companies: CompanySummary[];
  session: {
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  };
};

export type AuthProviders = {
  devLogin: boolean;
  oidc: boolean;
};

export type DevUser = {
  email: string;
  displayName: string;
  isPlatformOwner: boolean;
  memberships: {
    companyId: string;
    tradingName: string;
    status: string;
    roles: string[];
  }[];
};

export type Grant = {
  permission: string;
  scopeType: string;
  scopeId: string | null;
};

export type CompanyContext = {
  company: {
    id: string;
    legalName: string;
    tradingName: string;
    status: string;
    timezone: string;
    defaultCurrency: string;
    countryCode: string;
    documentLanguage: Locale;
  };
  grants: Grant[];
  switches: { key: string; enabled: boolean }[];
  mfaStepUpRequired: boolean;
  withheldPermissions: string[];
};

export function isLocale(value: string): value is Locale {
  return value === 'en' || value === 'el';
}
