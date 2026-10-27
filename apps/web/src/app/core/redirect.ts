/** A same-app path. Rejects open redirects and the login screen itself. */
export function safeAppPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return null;
  }
  if (value.includes('://') || value.startsWith('/login')) {
    return null;
  }
  return value;
}
