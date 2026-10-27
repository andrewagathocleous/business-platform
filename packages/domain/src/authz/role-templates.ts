import { PERMISSIONS, ROLE_KEYS, type RoleKey } from './permissions';

export type TemplateKey = RoleKey | 'BASE';

export type RoleTemplate = {
  key: TemplateKey;
  name: string;
  description: string;
  permissions: readonly string[];
};

const DETAILS: Record<RoleKey, { name: string; description: string }> = {
  CA: {
    name: 'Company administrator',
    description: 'Company administrator',
  },
  OM: {
    name: 'Operations manager',
    description: 'Operations manager',
  },
  FS: {
    name: 'Fulfilment staff',
    description: 'Fulfilment staff',
  },
  FIN: {
    name: 'Finance/accountant',
    description: 'Finance/accountant',
  },
  MKT: {
    name: 'Marketing',
    description: 'Marketing',
  },
  CS: {
    name: 'Customer support',
    description: 'Customer support',
  },
  AUD: {
    name: 'Read-only auditor',
    description: 'Read-only auditor',
  },
};

export const ROLE_TEMPLATES: readonly (RoleTemplate & { key: RoleKey })[] = ROLE_KEYS.map((key) => {
  const details = DETAILS[key];
  return {
    key,
    name: details.name,
    description: details.description,
    permissions: PERMISSIONS.filter((permission) => permission.grants[key] !== undefined).map(
      (permission) => permission.key,
    ),
  };
});

/** Staff baseline. Scoped operational roles also get this company-wide. */
export const BASE_TEMPLATE: RoleTemplate = {
  key: 'BASE',
  name: 'Staff baseline',
  description: 'Staff baseline: company.view and catalog.view',
  permissions: ['company.view', 'catalog.view'],
};

export const ALL_ROLE_TEMPLATES: readonly RoleTemplate[] = [...ROLE_TEMPLATES, BASE_TEMPLATE];

export function roleTemplate(key: TemplateKey): RoleTemplate {
  const template = ALL_ROLE_TEMPLATES.find((item) => item.key === key);
  if (!template) {
    throw new Error(`unknown role template ${key}`);
  }
  return template;
}
