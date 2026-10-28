import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fetchMetadata, runPreview } from '../src/odata.js';

/**
 * Node's fetch will not connect to a port on the Fetch standard's "bad port" list: it says "fetch failed"
 * (cause "bad port") without trying. Test connection, the $metadata refresh and the preview must still
 * reach a FactoryLogix served on one. These are the listed ports a test may listen on (above 1023).
 */
const BLOCKED_PORTS = [10080, 6666, 6667, 6668, 6669, 6665, 6679, 6697, 6566, 6000, 5061, 5060, 4190, 4045, 3659, 2049, 1723, 1720, 1719];

const AUTH = `Basic ${Buffer.from('u:p').toString('base64')}`;
const EDMX =
  '<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices>' +
  '<Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="FL">' +
  '<EntityType Name="WorkOrder"><Property Name="WorkOrderNumber" Type="Edm.String" Nullable="false"/></EntityType>' +
  '<EntityContainer Name="Container"><EntitySet Name="WorkOrders" EntityType="FL.WorkOrder"/></EntityContainer>' +
  '</Schema></edmx:DataServices></edmx:Edmx>';

let seen: http.IncomingHttpHeaders = {};
function factoryLogix(req: http.IncomingMessage, res: http.ServerResponse): void {
  seen = req.headers;
  if (req.headers.authorization !== AUTH) {
    res.writeHead(401, 'Unauthorized', { 'Content-Type': 'text/plain' });
    res.end('bad credentials');
  } else if (req.url?.startsWith('/drop/')) {
    req.socket.destroy();
  } else if (req.url?.startsWith('/stall/')) {
    // The answer starts and never finishes.
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.write('<edmx:Edmx');
  } else if (req.url?.startsWith('/odata/WorkOrders')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ value: [{ WorkOrderNumber: 'WO-1' }] }));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(EDMX);
  }
}

function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => resolve(false);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(true);
    });
  });
}

async function listenOnBlockedPort(server: Server): Promise<number | null> {
  for (const port of BLOCKED_PORTS) if (await tryListen(server, port)) return port;
  return null;
}

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(factoryLogix);
const port = await listenOnBlockedPort(server);

// The same FactoryLogix over https, with a self-signed certificate (openssl, as in the other TLS tests).
let certDir = '';
let tlsServer: https.Server | null = null;
let tlsPort: number | null = null;
if (opensslAvailable()) {
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
  tlsServer = https.createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, factoryLogix);
  tlsPort = await listenOnBlockedPort(tlsServer);
}

afterAll(() => {
  for (const s of [server, tlsServer]) {
    s?.closeAllConnections();
    s?.close();
  }
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

function creds(path = 'odata', password = 'p') {
  return { base_url: `http://127.0.0.1:${port}/${path}`, username: 'u', password };
}

describe.skipIf(port === null)('a FactoryLogix on a port Node\'s fetch will not connect to', () => {
  it('is out of fetch\'s reach on its own', async () => {
    const err = (await fetch(`http://127.0.0.1:${port}/odata/$metadata`).catch((e: unknown) => e)) as Error;
    expect((err.cause as Error).message).toBe('bad port');
  });

  it('answers Test connection, with the credentials sent', async () => {
    const res = await fetchMetadata(creds(), 5_000);
    expect(res.error).toBeNull();
    expect(res.metadata?.entity_sets.map((s) => s.name)).toEqual(['WorkOrders']);
    expect(seen.accept).toBe('application/xml');
  });

  it('answers the preview', async () => {
    const mapping = { entity_set: 'WorkOrders', watermark_field: null, key: ['WorkOrderNumber'], fields: { job_number: 'WorkOrderNumber' } };
    const res = await runPreview(creds(), 'work_orders', mapping, {}, 5_000);
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([{ WorkOrderNumber: 'WO-1' }]);
  });

  it('passes on an HTTP error with its body', async () => {
    const res = await fetchMetadata(creds('odata', 'wrong'), 5_000);
    expect(res.error).toBe('HTTP 401 Unauthorized: bad credentials');
  });

  it('names the reason when the connection drops', async () => {
    const res = await fetchMetadata(creds('drop'), 5_000);
    expect(res.metadata).toBeNull();
    expect(res.error).toBe('connection reset (socket hang up, ECONNRESET)');
  });

  it('reports an answer that stops coming as a timeout', async () => {
    const res = await fetchMetadata(creds('stall'), 300);
    expect(res.metadata).toBeNull();
    expect(res.error).toBe('request timed out after 300 ms');
  });

  it.skipIf(tlsPort === null)('still checks the certificate of an https address', async () => {
    const res = await fetchMetadata({ base_url: `https://127.0.0.1:${tlsPort}/odata`, username: 'u', password: 'p' }, 5_000);
    expect(res.metadata).toBeNull();
    expect(res.error).toBe('certificate not trusted (self-signed certificate, DEPTH_ZERO_SELF_SIGNED_CERT)');
  });
});
