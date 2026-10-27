import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM for the OIDC code_verifier. The full credential vault is Step C7.
 * The stored form is `v1.<keyId>.<iv>.<ciphertext>.<tag>`, each binary part base64url.
 * Key ids must not contain `.`.
 */
export function seal(plaintext: string, keys: Readonly<Record<string, Buffer>>, keyId: string): string {
  if (keyId.includes('.')) {
    throw new Error('master key id must not contain a dot');
  }
  const key = keys[keyId];
  if (!key || key.length !== 32) {
    throw new Error('active master key is missing');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyId, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join(
    '.',
  );
}

export function openSecret(sealed: string, keys: Readonly<Record<string, Buffer>>): string {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) {
    throw new Error('ciphertext is not valid');
  }
  const keyId = parts[1] ?? '';
  const key = keys[keyId];
  if (!key || key.length !== 32) {
    throw new Error('ciphertext key is unavailable');
  }
  const iv = Buffer.from(parts[2] ?? '', 'base64url');
  const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
  const tag = Buffer.from(parts[4] ?? '', 'base64url');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('ciphertext is not valid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('ciphertext is not valid');
  }
}
