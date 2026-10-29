import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('loadEnv', () => {
  it('takes a generated ENCRYPTION_KEY', () => {
    expect(loadEnv({ ENCRYPTION_KEY: ` ${KEY} ` }).encryptionKey).toBe(KEY);
  });

  it('refuses a missing or malformed ENCRYPTION_KEY', () => {
    expect(() => loadEnv({})).toThrow(/64 hex characters/);
    expect(() => loadEnv({ ENCRYPTION_KEY: 'too-short' })).toThrow(/64 hex characters/);
  });

  it('refuses the public all-zero key from .env.example and any other one-character key', () => {
    for (const key of ['0'.repeat(64), 'f'.repeat(64), 'aA'.repeat(32)]) {
      expect(() => loadEnv({ ENCRYPTION_KEY: key }), key).toThrow(/placeholder/);
    }
  });
});
