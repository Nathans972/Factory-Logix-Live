import http from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { ODataClient, ODataError } from '../src/odata/client.js';

/**
 * Node's fetch will not connect to a port on the Fetch standard's "bad port" list: it says "fetch failed"
 * (cause "bad port") without trying. The collector must still poll a FactoryLogix served on one. These are
 * the listed ports a test may listen on (above 1023).
 */
const BLOCKED_PORTS = [10080, 6666, 6667, 6668, 6669, 6665, 6679, 6697, 6566, 6000, 5061, 5060, 4190, 4045, 3659, 2049, 1723, 1720, 1719];

const AUTH = `Basic ${Buffer.from('u:p').toString('base64')}`;

let seen: http.IncomingHttpHeaders = {};
const server = http.createServer((req, res) => {
  seen = req.headers;
  if (req.headers.authorization !== AUTH) {
    res.writeHead(401, 'Unauthorized', { 'Content-Type': 'text/plain' });
    res.end('bad credentials');
  } else if (req.url?.startsWith('/stall/')) {
    // Never answers.
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json; odata.metadata=minimal' });
    res.end(JSON.stringify({ value: [{ UnitSerial: 'S1' }], '@odata.nextLink': 'UnitProcessHistory?$skiptoken=1' }));
  }
});

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => resolve(false);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(true);
    });
  });
}

let port: number | null = null;
for (const candidate of BLOCKED_PORTS) {
  if (await tryListen(candidate)) {
    port = candidate;
    break;
  }
}

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

function client(path = 'odata', password = 'p', timeoutSeconds = 5): ODataClient {
  return new ODataClient({ baseUrl: `http://127.0.0.1:${port}/${path}`, username: 'u', password, timeoutSeconds });
}

describe.skipIf(port === null)('polling a FactoryLogix on a port Node\'s fetch will not connect to', () => {
  it('is out of fetch\'s reach on its own', async () => {
    const err = (await fetch(`http://127.0.0.1:${port}/odata/UnitProcessHistory`).catch((e: unknown) => e)) as Error;
    expect((err.cause as Error).message).toBe('bad port');
  });

  it('reads the page, with the request headers sent', async () => {
    const page = await client().fetchPage('UnitProcessHistory', { top: 10 });
    expect(page).toEqual({ rows: [{ UnitSerial: 'S1' }], nextLink: 'UnitProcessHistory?$skiptoken=1' });
    expect(seen['user-agent']).toBe('fld-collector/1.0');
    expect(seen.accept).toBe('application/json;odata.metadata=minimal');
  });

  it('keeps the HTTP status of a refused login', async () => {
    const err = await client('odata', 'wrong').fetchPage('UnitProcessHistory').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ODataError);
    expect((err as ODataError).status).toBe(401);
    expect((err as ODataError).isAuth).toBe(true);
    expect((err as ODataError).body).toBe('bad credentials');
  });

  it('reports no answer as a timeout', async () => {
    const err = await client('stall', 'p', 1).fetchPage('UnitProcessHistory').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ODataError);
    expect((err as ODataError).isTimeout).toBe(true);
    expect((err as ODataError).message).toBe('OData request timed out after 1s');
  });
});
