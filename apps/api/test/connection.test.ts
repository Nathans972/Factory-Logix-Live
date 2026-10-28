import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { basicAuthHeader } from '../src/odata.js';
import { sameServer } from '../src/services/connection.js';
import { SseHub } from '../src/sse.js';

vi.mock('../src/db/repo/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/repo/settings.js')>()),
  getSettings: async () => DEFAULT_SETTINGS,
}));

const { buildServer } = await import('../src/server.js');

const SECRET = 'a-very-long-test-session-secret-value';
const KEY_HEX = 'cd'.repeat(32);
const STORED_PASSWORD = 'MES-service-account-Passw0rd!';
const STORED_URL = 'http://factorylogix.plant.local:6065/odata';
const OTHER_URL = 'http://factorylogix-new.plant.local:6065/odata';

/** One admin user and the `fl_connection` row of `settings`; a PUT writes the row back into `state.row`. */
function fakeDb(row: Record<string, unknown> | null) {
  const admin = { id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null };
  const state = { row, notified: 0 };
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM users WHERE id = $1')) return { rows: [admin], rowCount: 1 };
    if (sql.startsWith('SELECT key, value FROM settings WHERE key = $1') && values[0] === 'fl_connection') {
      return state.row ? { rows: [{ key: 'fl_connection', value: state.row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('INSERT INTO settings') && values[0] === 'fl_connection') {
      state.row = JSON.parse(String(values[1])) as Record<string, unknown>;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('SELECT pg_notify')) state.notified += 1;
    return { rows: [], rowCount: 0 };
  };
  return { query, state };
}

const savedRow = () => ({ base_url: STORED_URL, username: 'svc-dashboard', password_enc: encrypt(STORED_PASSWORD, KEY_HEX) });

let outgoing: Array<{ url: string; authorization: string }> = [];
let closers: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', KEY_HEX);
  outgoing = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    outgoing.push({ url: String(url), authorization: init?.headers?.Authorization ?? '' });
    return new Response('unauthorized', { status: 401, statusText: 'Unauthorized' });
  });
});
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function adminApi(db: ReturnType<typeof fakeDb>) {
  const log = pino({ level: 'silent' });
  const ctx = { env: { sessionSecret: SECRET }, pool: db, db, log, sse: new SseHub('postgres://unused', log), version: 'test' } as unknown as AppContext;
  const app = await buildServer(ctx);
  closers.push(() => app.close());
  const headers = { cookie: `fld_session=${await signSession({ userId: 1, role: 'admin' }, SECRET)}` };
  return (method: 'POST' | 'PUT', url: string, payload: Record<string, unknown>) => app.inject({ method, url, headers, payload });
}

describe('sameServer', () => {
  it('compares scheme, host and port, not the path', () => {
    expect(sameServer(STORED_URL, 'http://FactoryLogix.plant.local:6065/odata/v2/')).toBe(true);
    expect(sameServer('http://fl.plant.local/odata', ' http://fl.plant.local:80/other ')).toBe(true);
    expect(sameServer(STORED_URL, 'https://factorylogix.plant.local:6065/odata')).toBe(false);
    expect(sameServer(STORED_URL, 'http://factorylogix.plant.local:6066/odata')).toBe(false);
    expect(sameServer(STORED_URL, 'http://factorylogix.plant.local.attacker.example:6065/odata')).toBe(false);
    expect(sameServer(STORED_URL, 'http://factorylogix.plant.local:6065@attacker.example/odata')).toBe(false);
    expect(sameServer(STORED_URL, 'http://attacker.example\\@factorylogix.plant.local:6065/odata')).toBe(false);
  });

  it('never matches a URL without a network origin or one that does not parse', () => {
    expect(sameServer('file:///srv/odata', 'file:///srv/odata')).toBe(false);
    expect(sameServer(STORED_URL, 'not a url')).toBe(false);
    expect(sameServer('', '')).toBe(false);
  });
});

describe('POST /api/admin/connection/test', () => {
  it('tests the saved connection with the saved password when the body is empty', async () => {
    const api = await adminApi(fakeDb(savedRow()));
    expect((await api('POST', '/api/admin/connection/test', {})).statusCode).toBe(200);
    expect(outgoing).toEqual([
      { url: `${STORED_URL}/$metadata`, authorization: basicAuthHeader('svc-dashboard', STORED_PASSWORD) },
    ]);
  });

  it('keeps using the saved password on the saved server when only the path or user name changed', async () => {
    const api = await adminApi(fakeDb(savedRow()));
    const res = await api('POST', '/api/admin/connection/test', {
      base_url: 'http://factorylogix.plant.local:6065/odata/v2',
      username: 'svc-other',
    });
    expect(res.statusCode).toBe(200);
    expect(outgoing).toEqual([
      {
        url: 'http://factorylogix.plant.local:6065/odata/v2/$metadata',
        authorization: basicAuthHeader('svc-other', STORED_PASSWORD),
      },
    ]);
  });

  it('sends the password typed for another server, never the saved one', async () => {
    const api = await adminApi(fakeDb(savedRow()));
    await api('POST', '/api/admin/connection/test', { base_url: OTHER_URL, username: 'svc-dashboard', password: 'typed' });
    await api('POST', '/api/admin/connection/test', { base_url: OTHER_URL, username: 'svc-dashboard' });
    expect(outgoing).toEqual([
      { url: `${OTHER_URL}/$metadata`, authorization: basicAuthHeader('svc-dashboard', 'typed') },
      { url: `${OTHER_URL}/$metadata`, authorization: basicAuthHeader('svc-dashboard', '') },
    ]);
  });
});

describe('PUT /api/admin/connection', () => {
  it('refuses to keep the saved password for another server, and leaves the saved connection alone', async () => {
    const db = fakeDb(savedRow());
    const before = db.state.row;
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: OTHER_URL, username: 'svc-dashboard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/enter the password for the new server/);
    expect(db.state.row).toBe(before);
    expect(db.state.notified).toBe(0);
  });

  it('saves another server with the password typed for it', async () => {
    const db = fakeDb(savedRow());
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: OTHER_URL, username: 'svc-dashboard', password: 'new-one' });
    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toEqual({ base_url: OTHER_URL, username: 'svc-dashboard', has_password: true });
    expect(db.state.row?.base_url).toBe(OTHER_URL);
    expect(decrypt(String(db.state.row?.password_enc), KEY_HEX)).toBe('new-one');
  });

  it('keeps the saved password while the URL stays on the same server', async () => {
    const db = fakeDb(savedRow());
    const passwordEnc = db.state.row?.password_enc;
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', {
      base_url: 'http://factorylogix.plant.local:6065/odata/v2',
      username: 'svc-other',
    });
    expect(res.statusCode).toBe(200);
    expect(db.state.row).toEqual({
      base_url: 'http://factorylogix.plant.local:6065/odata/v2',
      username: 'svc-other',
      password_enc: passwordEnc,
    });
  });

  it('lets the URL move without a password while none is saved', async () => {
    const db = fakeDb({ base_url: STORED_URL, username: 'svc-dashboard', password_enc: null });
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: OTHER_URL, username: 'svc-dashboard' });
    expect(res.statusCode).toBe(200);
    expect(db.state.row).toEqual({ base_url: OTHER_URL, username: 'svc-dashboard', password_enc: null });
  });
});
