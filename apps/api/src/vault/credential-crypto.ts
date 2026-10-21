import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class CredentialCryptoError extends Error {
  override readonly name = 'CredentialCryptoError';

  constructor(message = 'credential could not be opened') {
    super(message);
  }
}

export type SealedCredential = {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
};

export function credentialAad(companyId: string, provider: string, credentialId: string): string {
  return `${companyId}|${provider}|${credentialId}`;
}

/**
 * Last four characters, and only when that is not the whole secret.
 * A secret of four characters or fewer stores no hint.
 */
export function credentialHint(plaintext: string): string | null {
  const chars = Array.from(plaintext);
  if (chars.length <= 4) {
    return null;
  }
  return chars.slice(-4).join('');
}

export function sealCredential(key: Buffer, aad: string, plaintext: string): SealedCredential {
  if (key.length !== 32) {
    throw new CredentialCryptoError('master key is not loaded');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

export function openCredential(key: Buffer, aad: string, sealed: SealedCredential): string {
  if (key.length !== 32) {
    throw new CredentialCryptoError('master key is not loaded');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof CredentialCryptoError) {
      throw error;
    }
    throw new CredentialCryptoError();
  }
}
