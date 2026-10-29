import { describe, expect, it } from 'vitest';
import { checkExtraCaFile } from '../src/extra-ca.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUBase64Body\n-----END CERTIFICATE-----\n';

function fsError(code: string, path: string): () => never {
  return () => {
    throw Object.assign(new Error(`${code}: open '${path}'`), { code });
  };
}

describe('checkExtraCaFile', () => {
  it('says nothing without FACTORYLOGIX_CA_CERT, when NODE_EXTRA_CA_CERTS is empty or unset', () => {
    const read = (): string => {
      throw new Error('must not be read');
    };
    expect(checkExtraCaFile(undefined, read)).toBeNull();
    expect(checkExtraCaFile('', read)).toBeNull();
  });

  it('confirms a PEM file and counts its certificates', () => {
    expect(checkExtraCaFile('/app/certs/plant-ca.pem', () => PEM)).toEqual({
      ok: true,
      message: 'FACTORYLOGIX_CA_CERT: /app/certs/plant-ca.pem holds 1 certificate, trusted for https:// FactoryLogix',
    });
    // A root and an intermediate, saved on Windows.
    const chain = `${PEM}${PEM}`.replace(/\n/g, '\r\n');
    expect(checkExtraCaFile('/app/certs/plant-chain.pem', () => chain)?.message).toContain('holds 2 certificates');
  });

  it('says why a file cannot be read and where it has to go', () => {
    const missing = checkExtraCaFile('/app/certs/certs/plant-ca.pem', fsError('ENOENT', '/app/certs/certs/plant-ca.pem'));
    expect(missing?.ok).toBe(false);
    expect(missing?.message).toContain('cannot read /app/certs/certs/plant-ca.pem (ENOENT)');
    expect(missing?.message).toContain('set FACTORYLOGIX_CA_CERT in .env to its file name alone');
    const unreadable = checkExtraCaFile('/app/certs/plant-ca.pem', fsError('EACCES', '/app/certs/plant-ca.pem'));
    expect(unreadable?.message).toContain('(EACCES)');
    expect(unreadable?.message).toContain('chmod 644');
  });

  it('flags a file Node would skip without a word: DER, a key, an empty file', () => {
    // The first bytes of a DER certificate (SEQUENCE, long length), as read with latin1.
    const der = '\x30\x82\x03\x5a\x30\x82\x02\x42\xa0\x03\x02\x01\x02';
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
    for (const text of [der, key, '']) {
      const result = checkExtraCaFile('/app/certs/plant-ca.cer', () => text);
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('/app/certs/plant-ca.cer holds no PEM certificate');
      expect(result?.message).toContain('openssl x509 -inform der -in plant-ca.cer -out plant-ca.pem');
    }
  });
});
