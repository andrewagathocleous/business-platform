const SENSITIVE_KEY = /token|secret|password|iban|ciphertext|authorization|cookie/i;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Replaces sensitive keys before an audit `details` document is stored. */
export function redactDetails(value: unknown): { [key: string]: JsonValue } {
  const redacted = redact(value);
  if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return {};
  }
  return redacted;
}

function redact(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[Redacted]' : redact(child);
    }
    return output;
  }
  return null;
}
