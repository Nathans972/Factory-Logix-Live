import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchMetadata } from '../src/odata.js';

/**
 * What the admin reads under "Could not connect" when FactoryLogix cannot be reached. Node's fetch
 * (undici) puts the real reason (ECONNREFUSED, ENOTFOUND, DEPTH_ZERO_SELF_SIGNED_CERT, ECONNRESET ...)
 * in `err.cause` and sets `err.message` to the bare "fetch failed", so showing `err.message` alone
 * leaves the admin with no way to tell a typo from a firewall from an untrusted certificate.
 */
function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_OPENSSL = opensslAvailable();
const EDMX = '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices></edmx:DataServices></edmx:Edmx>';

let certDir = '';
let tlsServer: https.Server | null = null;
let resetServer: http.Server;
let tlsPort = 0;
let resetPort = 0;

beforeAll(async () => {
  resetServer = http.createServer((req) => req.socket.destroy());
  await new Promise<void>((resolve) => resetServer.listen(0, '127.0.0.1', resolve));
  resetPort = (resetServer.address() as AddressInfo).port;

  if (HAS_OPENSSL) {
    certDir = mkdtempSync(join(tmpdir(), 'fl-selfsigned-'));
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
        '-days', '2', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    tlsServer = https.createServer(
      { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(EDMX);
      },
    );
    await new Promise<void>((resolve) => (tlsServer as https.Server).listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  }
});

afterAll(() => {
  resetServer.close();
  tlsServer?.close();
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('the error shown for an unreachable FactoryLogix', () => {
  it('says why when the connection is refused', async () => {
    const port = await freePort();
    const res = await fetchMetadata({ base_url: `http://127.0.0.1:${port}/odata`, username: 'u', password: 'p' }, 5_000);
    expect(res.metadata).toBeNull();
    expect(res.error).toMatch(/ECONNREFUSED|refused/i);
  });

  it('says why when the server drops the connection', async () => {
    const res = await fetchMetadata({ base_url: `http://127.0.0.1:${resetPort}/odata`, username: 'u', password: 'p' }, 5_000);
    expect(res.metadata).toBeNull();
    expect(res.error).toMatch(/ECONNRESET|reset|socket hang up|closed|terminated/i);
  });

  it.skipIf(!HAS_OPENSSL)('says the certificate is not trusted for an https address with a self-signed certificate', async () => {
    const res = await fetchMetadata({ base_url: `https://127.0.0.1:${tlsPort}/odata`, username: 'u', password: 'p' }, 5_000);
    expect(res.metadata).toBeNull();
    expect(res.error).toMatch(/self[- ]signed|certificate|SELF_SIGNED/i);
  });
});
