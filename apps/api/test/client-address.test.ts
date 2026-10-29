import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';
import { SseHub } from '../src/sse.js';

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

// docker-compose: browser -> [the site's own TLS proxy] -> nginx -> api. nginx appends the address
// it saw to the client's X-Forwarded-For, and so does a well-behaved proxy in front of it.
const NGINX = '172.18.0.3';
const CLIENT = '10.0.0.66';
const SITE_PROXY = '10.1.2.3';

/** Returns a lookup of the address the api counts (req.ip, the login rate limit's key) for a request. */
async function clientAddress(trustedProxies?: string[]) {
  const log = pino({ level: 'silent' });
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  const ctx = {
    env: { sessionSecret: 'a-very-long-test-session-secret-value', trustedProxies },
    pool: db,
    db,
    log,
    sse: new SseHub('postgres://unused', log),
    version: 'test',
  } as unknown as AppContext;
  const app = await buildServer(ctx);
  app.get('/test/ip', async (req) => ({ ip: req.ip }));
  closers.push(() => app.close());
  return async (forwardedFor: string | null, remoteAddress = NGINX): Promise<string> => {
    const headers = forwardedFor === null ? {} : { 'x-forwarded-for': forwardedFor };
    const res = await app.inject({ method: 'GET', url: '/test/ip', remoteAddress, headers });
    expect(res.statusCode).toBe(200);
    return (res.json() as { ip: string }).ip;
  };
}

describe('client address behind nginx', () => {
  it('is the address nginx appended, not what the client wrote in front of it', async () => {
    const ip = await clientAddress();
    expect(await ip(CLIENT)).toBe(CLIENT);
    expect(await ip(`203.0.113.7, ${CLIENT}`)).toBe(CLIENT);
    expect(await ip(`not-an-address, ${SITE_PROXY}, ${CLIENT}`)).toBe(CLIENT);
    // The api binds "::", so nginx's own address arrives IPv4-mapped.
    expect(await ip(`203.0.113.7, ${CLIENT}`, `::ffff:${NGINX}`)).toBe(CLIENT);
  });

  it('is the peer itself when nothing was forwarded', async () => {
    const ip = await clientAddress();
    expect(await ip(null, CLIENT)).toBe(CLIENT);
  });

  it('is an unlisted proxy in front of nginx, which then stands for everyone behind it', async () => {
    const ip = await clientAddress();
    expect(await ip(`${CLIENT}, ${SITE_PROXY}`)).toBe(SITE_PROXY);
  });
});

describe('client address behind a proxy listed in TRUSTED_PROXIES', () => {
  it('is the address that proxy appended', async () => {
    const ip = await clientAddress([SITE_PROXY]);
    expect(await ip(`${CLIENT}, ${SITE_PROXY}`)).toBe(CLIENT);
    expect(await ip(`203.0.113.7, ${CLIENT}, ${SITE_PROXY}`)).toBe(CLIENT);
  });

  it('still counts a client that skips the proxy and names it in its own header', async () => {
    const ip = await clientAddress([SITE_PROXY]);
    expect(await ip(`203.0.113.7, ${SITE_PROXY}, ${CLIENT}`)).toBe(CLIENT);
  });

  it('matches CIDR ranges and IPv6', async () => {
    const ip = await clientAddress(['10.1.0.0/16', 'fd00::/8']);
    expect(await ip(`203.0.113.7, ${CLIENT}, 10.1.9.9`)).toBe(CLIENT);
    expect(await ip(`203.0.113.7, ${CLIENT}, fd00::5`)).toBe(CLIENT);
    expect(await ip(`203.0.113.7, ${CLIENT}, ::ffff:10.1.9.9`)).toBe(CLIENT);
    expect(await ip(`203.0.113.7, ${CLIENT}, 10.2.0.1`)).toBe('10.2.0.1');
  });

  it('stops at an entry that is not an address', async () => {
    const ip = await clientAddress([SITE_PROXY]);
    expect(await ip(`203.0.113.7, not-an-address, ${SITE_PROXY}`)).toBe('not-an-address');
  });
});
