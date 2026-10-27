export function partyLines(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const lines: string[] = [];
  const name = partyName(value);
  if (name) {
    lines.push(name);
  }
  push(lines, value['email']);
  push(lines, value['phone']);
  push(lines, value['address1']);
  push(lines, value['address2']);
  push(lines, value['line1']);
  push(lines, value['line2']);
  const city = [text(value['city']), text(value['zip']) ?? text(value['postalCode']) ?? text(value['postcode'])]
    .filter((part): part is string => part !== null)
    .join(' ');
  if (city.length > 0) {
    lines.push(city);
  }
  const country = text(value['country']) ?? text(value['countryCode']) ?? text(value['countryCodeV2']);
  if (country) {
    lines.push(country);
  }
  return lines;
}

function partyName(value: Record<string, unknown>): string | null {
  const displayName = text(value['displayName']);
  if (displayName) {
    return displayName;
  }
  const name = text(value['name']);
  if (name) {
    return name;
  }
  const parts = [text(value['firstName']), text(value['lastName'])].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(' ') : null;
}

function push(lines: string[], value: unknown): void {
  const line = text(value);
  if (line) {
    lines.push(line);
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
