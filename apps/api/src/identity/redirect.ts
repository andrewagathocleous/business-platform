const MAX_REDIRECT_LENGTH = 2048;

/**
 * A same-origin path. Rejects absolute URLs, protocol-relative URLs and backslashes.
 * Returns the original string when it is safe to store and redirect to.
 */
export function relativeRedirect(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_REDIRECT_LENGTH) {
    return undefined;
  }
  if (!isRelativePath(value)) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (decoded !== value && !isRelativePath(decoded)) {
    return undefined;
  }
  return value;
}

function isRelativePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return false;
  }
  if (value.includes('\\') || value.includes('://') || containsControlOrSpace(value)) {
    return false;
  }
  return true;
}

export function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function containsControlOrSpace(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
