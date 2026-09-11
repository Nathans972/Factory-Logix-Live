/**
 * AES-256-GCM encryption for the FactoryLogix password at rest.
 *
 * Wire format (must match the collector exactly):
 *   enc:v1:<iv_hex>:<authtag_hex>:<ciphertext_hex>
 * Key: `Buffer.from(process.env.ENCRYPTION_KEY, 'hex')` (32 bytes), IV: 12 random bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENC_PREFIX = 'enc:v1:';
const IV_BYTES = 12;

export function getEncryptionKey(keyHex: string | undefined = process.env.ENCRYPTION_KEY): Buffer {
  if (!keyHex) throw new Error('ENCRYPTION_KEY is not set');
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex.trim())) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(keyHex.trim(), 'hex');
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function encrypt(plaintext: string, keyHex?: string): string {
  const key = getEncryptionKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decrypt(value: string, keyHex?: string): string {
  if (!isEncrypted(value)) throw new Error('value is not an enc:v1 payload');
  const parts = value.split(':');
  // ['enc','v1',iv,tag,ct]
  if (parts.length !== 5) throw new Error('malformed enc:v1 payload');
  const iv = Buffer.from(parts[2], 'hex');
  const tag = Buffer.from(parts[3], 'hex');
  const ct = Buffer.from(parts[4], 'hex');
  if (iv.length !== IV_BYTES) throw new Error('malformed enc:v1 payload (iv)');
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Decrypt when encrypted, otherwise return the value unchanged (tolerates legacy plaintext rows). */
export function decryptIfNeeded(value: string | null | undefined, keyHex?: string): string | null {
  if (!value) return null;
  return isEncrypted(value) ? decrypt(value, keyHex) : value;
}
