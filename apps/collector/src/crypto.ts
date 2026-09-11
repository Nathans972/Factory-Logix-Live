/**
 * AES-256-GCM decryption of the stored FactoryLogix password.
 * Format (must match apps/api exactly): `enc:v1:<iv_hex>:<authtag_hex>:<ciphertext_hex>`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function decryptSecret(encoded: string, keyHex: string): string {
  if (!isEncrypted(encoded)) {
    throw new Error('encrypted value must start with enc:v1:');
  }
  const parts = encoded.split(':');
  if (parts.length !== 5) throw new Error('malformed encrypted value');
  const [, , ivHex, tagHex, dataHex] = parts as [string, string, string, string, string];
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  const iv = Buffer.from(ivHex, 'hex');
  if (iv.length !== 12) throw new Error('encrypted value must use a 12-byte IV');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const out = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return out.toString('utf8');
}

/** Only used by tests / tooling; the API owns writing this value. */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return `${PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}
