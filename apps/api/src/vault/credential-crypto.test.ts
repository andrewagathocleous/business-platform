import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CredentialCryptoError,
  credentialAad,
  credentialHint,
  openCredential,
  sealCredential,
} from './credential-crypto';

const key = randomBytes(32);
const plaintext = 'shopify-token-μυστικό-1234';
const aad = credentialAad(
  '00000000-0000-4000-8000-000000000001',
  'shopify',
  '00000000-0000-4000-8000-000000000002',
);

describe('credential seal', () => {
  it('round-trips plaintext', () => {
    const sealed = sealCredential(key, aad, plaintext);
    expect(openCredential(key, aad, sealed)).toBe(plaintext);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(plaintext);
  });

  it('rejects a tampered ciphertext, tag or AAD', () => {
    const sealed = sealCredential(key, aad, plaintext);
    const ciphertext = Buffer.from(sealed.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    expect(() => openCredential(key, aad, { ...sealed, ciphertext })).toThrow(
      CredentialCryptoError,
    );
    const authTag = Buffer.from(sealed.authTag);
    authTag[0] = (authTag[0] ?? 0) ^ 0xff;
    expect(() => openCredential(key, aad, { ...sealed, authTag })).toThrow(CredentialCryptoError);
    expect(() => openCredential(key, `${aad}|x`, sealed)).toThrow(CredentialCryptoError);
  });

  it('stores no hint when the secret is four characters or fewer', () => {
    expect(credentialHint('123')).toBeNull();
    expect(credentialHint('1234')).toBeNull();
    expect(credentialHint('12345')).toBe('2345');
  });

  it('rejects a truncated authentication tag', () => {
    const sealed = sealCredential(key, aad, plaintext);
    expect(sealed.authTag).toHaveLength(16);
    expect(() =>
      openCredential(key, aad, { ...sealed, authTag: sealed.authTag.subarray(0, 4) }),
    ).toThrow(CredentialCryptoError);
  });

  it('rejects another company in the AAD', () => {
    const sealed = sealCredential(key, aad, plaintext);
    const other = credentialAad(
      '00000000-0000-4000-8000-000000000099',
      'shopify',
      '00000000-0000-4000-8000-000000000002',
    );
    expect(() => openCredential(key, other, sealed)).toThrow(CredentialCryptoError);
  });
});
