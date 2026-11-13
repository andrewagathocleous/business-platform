export type ClientKind = 'organisation' | 'individual';
export type AddressKind = 'billing' | 'shipping';

export type ContactDraft = {
  key: string;
  id: string;
  name: string;
  email: string;
  phone: string;
  position: string;
  isPrimary: boolean;
};

export type AddressDraft = {
  key: string;
  id: string;
  kind: AddressKind;
  label: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  isDefault: boolean;
};

export type ClientDraft = {
  kind: ClientKind;
  displayName: string;
  legalName: string;
  vatNumber: string;
  taxId: string;
  email: string;
  phone: string;
  website: string;
  notes: string;
  defaultCurrency: string;
  defaultLanguage: 'en' | 'el';
  paymentTermsDays: string;
  acceptsEInvoices: boolean;
  contacts: ContactDraft[];
  addresses: AddressDraft[];
};

export type ClientWrite = {
  kind: ClientKind;
  displayName: string;
  legalName: string | null;
  vatNumber: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  defaultCurrency: string | null;
  defaultLanguage: 'en' | 'el';
  paymentTermsDays: number | null;
  acceptsEInvoices: boolean;
  contacts: {
    id?: string;
    name: string;
    email: string | null;
    phone: string | null;
    position: string | null;
    isPrimary: boolean;
  }[];
  addresses: {
    id?: string;
    kind: AddressKind;
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

export function emptyClientDraft(): ClientDraft {
  return {
    kind: 'organisation',
    displayName: '',
    legalName: '',
    vatNumber: '',
    taxId: '',
    email: '',
    phone: '',
    website: '',
    notes: '',
    defaultCurrency: 'EUR',
    defaultLanguage: 'en',
    paymentTermsDays: '',
    acceptsEInvoices: false,
    contacts: [],
    addresses: [],
  };
}

export function setPrimary(
  contacts: readonly ContactDraft[],
  index: number,
  checked: boolean,
): ContactDraft[] {
  return contacts.map((contact, item) => {
    if (!checked) {
      return item === index ? { ...contact, isPrimary: false } : contact;
    }
    return { ...contact, isPrimary: item === index };
  });
}

export function setDefaultAddress(
  addresses: readonly AddressDraft[],
  index: number,
  checked: boolean,
): AddressDraft[] {
  const selected = addresses[index];
  if (!selected) {
    return [...addresses];
  }
  return addresses.map((address, item) => {
    if (item === index) {
      return { ...address, isDefault: checked };
    }
    if (checked && address.kind === selected.kind) {
      return { ...address, isDefault: false };
    }
    return address;
  });
}

export function changeAddressKind(
  addresses: readonly AddressDraft[],
  index: number,
  kind: AddressKind,
): AddressDraft[] {
  const selected = addresses[index];
  if (!selected) {
    return [...addresses];
  }
  const kindTaken = addresses.some(
    (address, item) => item !== index && address.kind === kind && address.isDefault,
  );
  return addresses.map((address, item) =>
    item === index ? { ...address, kind, isDefault: address.isDefault && !kindTaken } : address,
  );
}

/** Fields actually sent to duplicate-check. VAT counts only for an organisation. */
export function duplicateCheckPayload(draft: ClientDraft): {
  displayName?: string;
  email?: string;
  vatNumber?: string;
} {
  const payload: { displayName?: string; email?: string; vatNumber?: string } = {};
  if (draft.displayName.length > 0) {
    payload.displayName = draft.displayName;
  }
  if (draft.email.length > 0) {
    payload.email = draft.email;
  }
  if (draft.kind === 'organisation' && draft.vatNumber.length > 0) {
    payload.vatNumber = draft.vatNumber;
  }
  return payload;
}

export function duplicateFieldsChanged(previous: ClientDraft, next: ClientDraft): boolean {
  const left = duplicateCheckPayload(previous);
  const right = duplicateCheckPayload(next);
  return (
    left.displayName !== right.displayName ||
    left.email !== right.email ||
    left.vatNumber !== right.vatNumber
  );
}

/** Field-rule failures. Keys are `clients.rules.*`. */
export function clientErrors(draft: ClientDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  lengthBetween(errors, 'displayName', draft.displayName, 1, 500, true);
  if (draft.kind === 'organisation') {
    lengthBetween(errors, 'legalName', draft.legalName, 1, 500, false);
    lengthBetween(errors, 'vatNumber', draft.vatNumber, 1, 40, false);
  }
  lengthBetween(errors, 'taxId', draft.taxId, 1, 40, false);
  lengthBetween(errors, 'email', draft.email, 3, 320, false);
  lengthBetween(errors, 'phone', draft.phone, 1, 80, false);
  lengthBetween(errors, 'website', draft.website, 1, 300, false);
  if (draft.notes.length > 20_000) {
    errors['notes'] = 'clients.rules.tooLong';
  }
  const currency = draft.defaultCurrency.trim();
  if (currency.length > 0 && !/^[A-Za-z]{3}$/.test(currency)) {
    errors['defaultCurrency'] = 'clients.rules.currency';
  }
  if (
    draft.paymentTermsDays.trim().length > 0 &&
    termsValue(draft.paymentTermsDays) === undefined
  ) {
    errors['paymentTermsDays'] = 'clients.rules.terms';
  }
  draft.contacts.forEach((contact, index) => {
    lengthBetween(errors, `contacts.${String(index)}.name`, contact.name, 1, 300, true);
    lengthBetween(errors, `contacts.${String(index)}.email`, contact.email, 1, 320, false);
    lengthBetween(errors, `contacts.${String(index)}.phone`, contact.phone, 1, 80, false);
    lengthBetween(errors, `contacts.${String(index)}.position`, contact.position, 1, 160, false);
  });
  const defaults = new Map<string, number>();
  for (const address of draft.addresses) {
    if (!address.isDefault) {
      continue;
    }
    defaults.set(address.kind, (defaults.get(address.kind) ?? 0) + 1);
  }
  if ([...defaults.values()].some((count) => count > 1)) {
    errors['addresses'] = 'clients.rules.multipleDefaults';
  }
  draft.addresses.forEach((address, index) => {
    const prefix = `addresses.${String(index)}`;
    lengthBetween(errors, `${prefix}.label`, address.label, 1, 160, false);
    lengthBetween(errors, `${prefix}.line1`, address.line1, 1, 300, true);
    lengthBetween(errors, `${prefix}.line2`, address.line2, 1, 300, false);
    lengthBetween(errors, `${prefix}.city`, address.city, 1, 160, true);
    lengthBetween(errors, `${prefix}.region`, address.region, 1, 160, false);
    lengthBetween(errors, `${prefix}.postalCode`, address.postalCode, 1, 40, false);
    if (!/^[A-Za-z]{2}$/.test(address.countryCode.trim())) {
      errors[`${prefix}.countryCode`] = 'clients.rules.country';
    }
  });
  return errors;
}

export function clientWrite(draft: ClientDraft): ClientWrite | null {
  if (Object.keys(clientErrors(draft)).length > 0) {
    return null;
  }
  const currency = draft.defaultCurrency.trim();
  return {
    kind: draft.kind,
    displayName: draft.displayName,
    legalName: draft.kind === 'organisation' ? emptyToNull(draft.legalName) : null,
    vatNumber: draft.kind === 'organisation' ? emptyToNull(draft.vatNumber) : null,
    taxId: emptyToNull(draft.taxId),
    email: emptyToNull(draft.email),
    phone: emptyToNull(draft.phone),
    website: emptyToNull(draft.website),
    notes: draft.notes.length > 0 ? draft.notes : null,
    defaultCurrency: currency.length > 0 ? currency.toUpperCase() : null,
    defaultLanguage: draft.defaultLanguage,
    paymentTermsDays: termsValue(draft.paymentTermsDays) ?? null,
    acceptsEInvoices: draft.acceptsEInvoices,
    contacts: draft.contacts.map((contact) => ({
      ...(contact.id.length > 0 ? { id: contact.id } : {}),
      name: contact.name,
      email: emptyToNull(contact.email),
      phone: emptyToNull(contact.phone),
      position: emptyToNull(contact.position),
      isPrimary: contact.isPrimary,
    })),
    addresses: draft.addresses.map((address) => ({
      ...(address.id.length > 0 ? { id: address.id } : {}),
      kind: address.kind,
      label: emptyToNull(address.label),
      line1: address.line1,
      line2: emptyToNull(address.line2),
      city: address.city,
      region: emptyToNull(address.region),
      postalCode: emptyToNull(address.postalCode),
      countryCode: address.countryCode.trim().toUpperCase(),
      isDefault: address.isDefault,
    })),
  };
}

function lengthBetween(
  errors: Record<string, string>,
  field: string,
  value: string,
  min: number,
  max: number,
  required: boolean,
): void {
  if (value.length === 0) {
    if (required) {
      errors[field] = 'clients.rules.required';
    }
    return;
  }
  if (value.length < min || value.length > max) {
    errors[field] = 'clients.rules.length';
  }
}

function emptyToNull(value: string): string | null {
  return value.length > 0 ? value : null;
}

function termsValue(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  let value = 0;
  for (const char of trimmed) {
    value = value * 10 + (char.charCodeAt(0) - 48);
    if (value > 3650) {
      return undefined;
    }
  }
  return value;
}
