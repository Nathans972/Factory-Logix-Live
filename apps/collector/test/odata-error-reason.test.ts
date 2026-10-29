import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ODataClient } from '../src/odata/client.js';

/**
 * The text a failed poll leaves in sync_log.error, collector_state.last_error and the Sync health
 * page. Node's fetch (undici) puts the real reason (ECONNREFUSED, ENOTFOUND,
 * DEPTH_ZERO_SELF_SIGNED_CERT, ECONNRESET ...) in `err.cause` and sets `err.message` to the bare
 * "fetch failed"; ODataClient only keeps `err.message`.
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"value":[]}');
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

function client(baseUrl: string): ODataClient {
  return new ODataClient({ baseUrl, username: 'u', password: 'p', timeoutSeconds: 5 });
}

async function failureMessage(c: ODataClient): Promise<string> {
  try {
    await c.fetchPage('UnitProcessHistory', { top: 10 });
  } catch (err) {
    return (err as Error).message;
  }
  return '';
}

describe('the poll error recorded when FactoryLogix cannot be reached', () => {
  it('says why when the connection is refused', async () => {
    const port = await freePort();
    expect(await failureMessage(client(`http://127.0.0.1:${port}/odata`))).toMatch(/ECONNREFUSED|refused/i);
  });

  it('says why when the server drops the connection', async () => {
    expect(await failureMessage(client(`http://127.0.0.1:${resetPort}/odata`))).toMatch(
      /ECONNRESET|reset|socket hang up|closed|terminated/i,
    );
  });

  it.skipIf(!HAS_OPENSSL)('says the certificate is not trusted for an https address with a self-signed certificate', async () => {
    expect(await failureMessage(client(`https://127.0.0.1:${tlsPort}/odata`))).toMatch(/self[- ]signed|certificate|SELF_SIGNED/i);
  });
});
