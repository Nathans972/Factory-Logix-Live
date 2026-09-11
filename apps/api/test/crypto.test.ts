import { describe, expect, it } from 'vitest';
import { ENC_PREFIX, decrypt, decryptIfNeeded, encrypt, getEncryptionKey, isEncrypted } from '../src/crypto.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

describe('crypto (fl password at rest)', () => {
  it('round-trips a password', () => {
    const secret = 'p@ssw0rd with spaces and üñïçôdé';
    const enc = encrypt(secret, KEY);
    expect(decrypt(enc, KEY)).toBe(secret);
  });

  it('uses the enc:v1:<iv>:<tag>:<ct> wire format with a 12 byte iv and 16 byte tag', () => {
    const enc = encrypt('hello', KEY);
    expect(enc.startsWith(ENC_PREFIX)).toBe(true);
    const parts = enc.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('enc');
    expect(parts[1]).toBe('v1');
    expect(parts[2]).toHaveLength(24); // 12 bytes hex
    expect(parts[3]).toHaveLength(32); // 16 byte GCM tag hex
    expect(parts[4]).toMatch(/^[0-9a-f]*$/);
  });

  it('produces a different ciphertext each time (random iv)', () => {
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('fails to decrypt with the wrong key', () => {
    const enc = encrypt('secret', KEY);
    expect(() => decrypt(enc, OTHER_KEY)).toThrow();
  });

  it('fails on a tampered ciphertext', () => {
    const enc = encrypt('secret', KEY);
    const parts = enc.split(':');
    const flipped = parts[4].startsWith('0') ? `1${parts[4].slice(1)}` : `0${parts[4].slice(1)}`;
    expect(() => decrypt(`enc:v1:${parts[2]}:${parts[3]}:${flipped}`, KEY)).toThrow();
  });

  it('rejects malformed payloads', () => {
    expect(() => decrypt('plaintext', KEY)).toThrow();
    expect(() => decrypt('enc:v1:aa:bb', KEY)).toThrow();
    expect(isEncrypted('plaintext')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('validates the key length', () => {
    expect(() => getEncryptionKey('abc')).toThrow(/64 hex/);
    expect(() => getEncryptionKey(undefined)).toThrow(/not set/);
    expect(getEncryptionKey(KEY)).toHaveLength(32);
  });

  it('decryptIfNeeded passes plaintext through', () => {
    expect(decryptIfNeeded('legacy-plaintext', KEY)).toBe('legacy-plaintext');
    expect(decryptIfNeeded(null, KEY)).toBeNull();
    expect(decryptIfNeeded(encrypt('x', KEY), KEY)).toBe('x');
  });
});
