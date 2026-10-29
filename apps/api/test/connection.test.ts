import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { decrypt, encrypt } from '../src/crypto.js';
import { basicAuthHeader } from '../src/odata.js';
import { sameConnection } from '../src/services/connection.js';
import { SseHub } from '../src/sse.js';

vi.mock('../src/db/repo/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/repo/settings.js')>()),
  getSettings: async () => DEFAULT_SETTINGS,
}));

const { buildServer } = await import('../src/server.js');

const SECRET = 'a-very-long-test-session-secret-value';
const KEY_HEX = 'cd'.repeat(32);
/** The key of the install a restored backup came from. */
const OLD_INSTALL_KEY_HEX = 'ef'.repeat(32);
const STORED_PASSWORD = 'MES-service-account-Passw0rd!';
const STORED_URL = 'http://factorylogix.plant.local:6065/odata';
const OTHER_URL = 'http://factorylogix-new.plant.local:6065/odata';
const URL_PASSWORD = 's3cretPass';
/** The saved server with the account in front, the way a browser or curl takes it. */
const URL_WITH_PASSWORD = `http://svc-dashboard:${URL_PASSWORD}@factorylogix.plant.local:6065/odata`;

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
  return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) => app.inject({ method, url, headers, payload });
}

describe('sameConnection', () => {
  const saved = { base_url: STORED_URL, username: 'svc-dashboard' };

  it('matches the saved URL and user name, ignoring surrounding spaces', () => {
    expect(sameConnection(saved, { base_url: ` ${STORED_URL} `, username: ' svc-dashboard ' })).toBe(true);
  });

  it('does not match any other URL or user name, even on the saved server', () => {
    for (const base_url of [
      'http://factorylogix.plant.local:6065/odata/v2',
      'http://factorylogix.plant.local:6065/odata/../other-app',
      'https://factorylogix.plant.local:6065/odata',
      'http://factorylogix.plant.local:6066/odata',
      'http://factorylogix.plant.local.attacker.example:6065/odata',
      'http://factorylogix.plant.local:6065@attacker.example/odata',
      'http://attacker.example\\@factorylogix.plant.local:6065/odata',
      OTHER_URL,
    ]) {
      expect(sameConnection(saved, { base_url, username: 'svc-dashboard' }), base_url).toBe(false);
    }
    expect(sameConnection(saved, { base_url: STORED_URL, username: 'svc-other' })).toBe(false);
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

  it('uses the saved password while the form still holds the saved URL and user name', async () => {
    const api = await adminApi(fakeDb(savedRow()));
    const res = await api('POST', '/api/admin/connection/test', { base_url: STORED_URL, username: 'svc-dashboard' });
    expect(res.statusCode).toBe(200);
    expect(outgoing).toEqual([
      { url: `${STORED_URL}/$metadata`, authorization: basicAuthHeader('svc-dashboard', STORED_PASSWORD) },
    ]);
  });

  it('does not send the saved password once the path or the user name changed, even on the saved server', async () => {
    const api = await adminApi(fakeDb(savedRow()));
    const otherPath = 'http://factorylogix.plant.local:6065/other-app';
    await api('POST', '/api/admin/connection/test', { base_url: otherPath, username: 'svc-dashboard' });
    await api('POST', '/api/admin/connection/test', { base_url: STORED_URL, username: 'svc-other' });
    expect(outgoing).toEqual([
      { url: `${otherPath}/$metadata`, authorization: basicAuthHeader('svc-dashboard', '') },
      { url: `${STORED_URL}/$metadata`, authorization: basicAuthHeader('svc-other', '') },
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
    expect(res.json().message).toMatch(/enter the password again/);
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

  it('refuses to keep the saved password when only the path or the user name changed', async () => {
    const db = fakeDb(savedRow());
    const before = db.state.row;
    const api = await adminApi(db);
    for (const body of [
      { base_url: 'http://factorylogix.plant.local:6065/odata/v2', username: 'svc-dashboard' },
      { base_url: STORED_URL, username: 'svc-other' },
    ]) {
      expect((await api('PUT', '/api/admin/connection', body)).statusCode).toBe(400);
    }
    expect(db.state.row).toBe(before);
    expect(db.state.notified).toBe(0);
  });

  it('keeps the saved password when the same URL and user name are saved again', async () => {
    const db = fakeDb(savedRow());
    const before = { ...db.state.row };
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: STORED_URL, username: 'svc-dashboard' });
    expect(res.statusCode).toBe(200);
    expect(db.state.row).toEqual(before);
  });

  it('lets the URL move without a password while none is saved', async () => {
    const db = fakeDb({ base_url: STORED_URL, username: 'svc-dashboard', password_enc: null });
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: OTHER_URL, username: 'svc-dashboard' });
    expect(res.statusCode).toBe(200);
    expect(db.state.row).toEqual({ base_url: OTHER_URL, username: 'svc-dashboard', password_enc: null });
  });
});

describe('a saved password this ENCRYPTION_KEY cannot decrypt (a backup restored from another install)', () => {
  const restoredRow = () => ({ base_url: STORED_URL, username: 'svc-dashboard', password_enc: encrypt(STORED_PASSWORD, OLD_INSTALL_KEY_HEX) });

  it('shows the connection as needing the password again', async () => {
    const api = await adminApi(fakeDb(restoredRow()));
    const res = await api('GET', '/api/admin/connection');
    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toEqual({ base_url: STORED_URL, username: 'svc-dashboard', has_password: true, password_unreadable: true });
  });

  it('fails Test connection with what to do, and sends nothing', async () => {
    const api = await adminApi(fakeDb(restoredRow()));
    const res = await api('POST', '/api/admin/connection/test', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/^enter the password again: .*ENCRYPTION_KEY/) });
    expect(outgoing).toEqual([]);
  });

  it('answers $metadata with a 400 that says what to do, and sends nothing', async () => {
    const api = await adminApi(fakeDb(restoredRow()));
    const res = await api('GET', '/api/admin/mapping/metadata');
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^enter the password again: .*ENCRYPTION_KEY/);
    expect(outgoing).toEqual([]);
  });

  it('refuses to keep it on save, and leaves the saved connection alone', async () => {
    const db = fakeDb(restoredRow());
    const before = db.state.row;
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: STORED_URL, username: 'svc-dashboard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^enter the password again: .*ENCRYPTION_KEY/);
    expect(db.state.row).toBe(before);
    expect(db.state.notified).toBe(0);
  });

  it('works again once the password is typed and saved', async () => {
    const db = fakeDb(restoredRow());
    const api = await adminApi(db);
    const typed = { base_url: STORED_URL, username: 'svc-dashboard', password: STORED_PASSWORD };
    expect((await api('POST', '/api/admin/connection/test', typed)).statusCode).toBe(200);
    expect((await api('PUT', '/api/admin/connection', typed)).statusCode).toBe(200);
    expect(decrypt(String(db.state.row?.password_enc), KEY_HEX)).toBe(STORED_PASSWORD);
    expect((await api('GET', '/api/admin/connection')).json().connection).toEqual({ base_url: STORED_URL, username: 'svc-dashboard', has_password: true });
    expect((await api('POST', '/api/admin/connection/test', {})).statusCode).toBe(200);
    expect(outgoing).toEqual([
      { url: `${STORED_URL}/$metadata`, authorization: basicAuthHeader('svc-dashboard', STORED_PASSWORD) },
      { url: `${STORED_URL}/$metadata`, authorization: basicAuthHeader('svc-dashboard', STORED_PASSWORD) },
    ]);
  });
});

describe('a user name or password typed into the server URL', () => {
  it('refuses to save it, and leaves the saved connection alone', async () => {
    const db = fakeDb(savedRow());
    const before = db.state.row;
    const api = await adminApi(db);
    for (const base_url of [URL_WITH_PASSWORD, 'http://svc-dashboard@factorylogix.plant.local:6065/odata']) {
      const res = await api('PUT', '/api/admin/connection', { base_url, username: 'svc-dashboard', password: 'typed' });
      expect(res.statusCode, base_url).toBe(400);
      expect(res.json().message).toMatch(/^the FactoryLogix server URL must not contain a user name or password/);
      expect(res.body).not.toContain(URL_PASSWORD);
    }
    expect(db.state.row).toBe(before);
    expect(db.state.notified).toBe(0);
  });

  it('fails Test connection with what to do, and sends nothing', async () => {
    const api = await adminApi(fakeDb(savedRow()));
    const res = await api('POST', '/api/admin/connection/test', { base_url: URL_WITH_PASSWORD, username: 'svc-dashboard', password: 'typed' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/^the FactoryLogix server URL must not contain/) });
    expect(res.body).not.toContain(URL_PASSWORD);
    expect(outgoing).toEqual([]);
  });
});

describe('a server URL saved with the password in it by an earlier version', () => {
  const savedWithPassword = () => ({ base_url: URL_WITH_PASSWORD, username: 'svc-dashboard', password_enc: encrypt(STORED_PASSWORD, KEY_HEX) });

  it('shows it with the password masked', async () => {
    const api = await adminApi(fakeDb(savedWithPassword()));
    const res = await api('GET', '/api/admin/connection');
    expect(res.json().connection).toEqual({
      base_url: 'http://svc-dashboard:***@factorylogix.plant.local:6065/odata',
      username: 'svc-dashboard',
      has_password: true,
    });
  });

  it('is never sent: Test connection and $metadata say what to do', async () => {
    const api = await adminApi(fakeDb(savedWithPassword()));
    const test = await api('POST', '/api/admin/connection/test', {});
    expect(test.json()).toMatchObject({ ok: false, error: expect.stringMatching(/^the FactoryLogix server URL must not contain/) });
    const metadata = await api('GET', '/api/admin/mapping/metadata');
    expect(metadata.statusCode).toBe(400);
    expect(metadata.json().message).toMatch(/^the FactoryLogix server URL must not contain/);
    expect(test.body + metadata.body).not.toContain(URL_PASSWORD);
    expect(outgoing).toEqual([]);
  });

  it('is replaced once saved without it, and the audit entry does not repeat the password', async () => {
    const db = fakeDb(savedWithPassword());
    const sent: unknown[][] = [];
    const query = db.query;
    db.query = async (text, values = []) => {
      sent.push(values);
      return query(text, values);
    };
    const api = await adminApi(db);
    const res = await api('PUT', '/api/admin/connection', { base_url: STORED_URL, username: 'svc-dashboard', password: STORED_PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(db.state.row?.base_url).toBe(STORED_URL);
    const statements = JSON.stringify(sent);
    expect(statements).toContain('connection.updated');
    expect(statements).toContain('svc-dashboard:***@factorylogix.plant.local');
    expect(statements).not.toContain(URL_PASSWORD);
  });
});
