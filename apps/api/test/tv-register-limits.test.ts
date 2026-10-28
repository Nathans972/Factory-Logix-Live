import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { SseHub } from '../src/sse.js';

vi.mock('../src/services/dashboard.js', () => ({ buildDashboard: async () => ({}) }));
vi.mock('../src/db/repo/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/repo/settings.js')>()),
  getSettings: async () => DEFAULT_SETTINGS,
}));
vi.mock('../src/services/sync-health.js', () => ({
  buildSyncHealth: async () => ({ status: 'ok', delayed: false, delayed_since: null, last_success_at: 1 }),
}));

const { buildServer } = await import('../src/server.js');

/** A `displays` table keyed by device token, plus every statement the API sent. */
function fakeDb() {
  const byToken = new Map<string, Record<string, unknown>>();
  const sent: Array<{ sql: string; values: unknown[] }> = [];
  let nextId = 1;
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    sent.push({ sql, values });
    if (sql.startsWith('INSERT INTO displays')) {
      const [code, token] = values as string[];
      const row = {
        id: nextId++,
        pairing_code: code,
        device_token: token,
        name: null,
        claimed_at: null,
        job_number: null,
        group_operators: false,
        show_std_day: true,
        show_gauge: true,
        shift_length_hours: 12,
        last_seen_at: new Date(),
        created_at: new Date(),
      };
      byToken.set(token, row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM displays WHERE device_token = $1::uuid')) {
      const row = byToken.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return { sent, db: { query } };
}

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

async function setup() {
  const { sent, db } = fakeDb();
  const log = pino({ level: 'silent' });
  const ctx = {
    env: { sessionSecret: 'a-very-long-test-session-secret-value' },
    pool: db,
    db,
    log,
    sse: new SseHub('postgres://unused', log),
    version: 'test',
  } as unknown as AppContext;
  const app = await buildServer(ctx);
  closers.push(() => app.close());
  const register = (remoteAddress: string, device_token: string = randomUUID()) =>
    app.inject({ method: 'POST', url: '/api/tv/register', remoteAddress, payload: { device_token } });
  return { sent, register };
}

describe('POST /api/tv/register limits', () => {
  it('refuses an address that keeps creating displays, and nobody else', async () => {
    const { register } = await setup();
    for (let i = 0; i < 10; i += 1) expect((await register('10.0.0.66')).statusCode).toBe(200);

    const refused = await register('10.0.0.66');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: 'too_many_requests', statusCode: 429 });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    expect((await register('10.0.0.20')).statusCode).toBe(200);
  });

  it('never refuses a TV it already knows, however often it loads the page', async () => {
    const { register } = await setup();
    const token = randomUUID();
    for (let i = 0; i < 30; i += 1) {
      const res = await register('10.0.0.30', token);
      expect(res.statusCode).toBe(200);
      expect(res.json().device_token).toBe(token);
    }
  });

  it('frees codes held by unclaimed displays before it adds one', async () => {
    const { sent, register } = await setup();
    const token = randomUUID();
    await register('10.0.0.40', token);
    const prune = sent.findIndex((s) => s.sql.startsWith('DELETE FROM displays WHERE claimed_at IS NULL'));
    const insert = sent.findIndex((s) => s.sql.startsWith('INSERT INTO displays'));
    expect(prune).toBeGreaterThanOrEqual(0);
    expect(prune).toBeLessThan(insert);
    expect(sent[prune].values).toEqual([999]);

    // A known TV registering again adds nothing, so it deletes nothing.
    sent.length = 0;
    await register('10.0.0.40', token);
    expect(sent.some((s) => s.sql.startsWith('DELETE'))).toBe(false);
  });
});
