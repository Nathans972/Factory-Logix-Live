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

/** 4-digit pairing codes run 1000..9999. */
const CODE_SPACE = 9000;

interface Row {
  id: number;
  pairing_code: string;
  device_token: string;
  name: string | null;
  claimed_at: Date | null;
  job_number: string | null;
  group_operators: boolean;
  show_std_day: boolean;
  show_gauge: boolean;
  shift_length_hours: number;
  last_seen_at: Date | null;
  created_at: Date;
}

/** An in-memory `displays` table (unique pairing_code and device_token) behind the repository's SQL. */
function fakeDb() {
  const byCode = new Map<string, Row>();
  const byToken = new Map<string, Row>();
  let nextId = 1;
  const result = (found: Row[]) => ({ rows: found, rowCount: found.length });
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('INSERT INTO displays')) {
      const [code, token] = values as string[];
      if (byCode.has(code) || byToken.has(token.toLowerCase())) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const row: Row = {
        id: nextId++,
        pairing_code: code,
        device_token: token.toLowerCase(),
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
      byCode.set(code, row);
      byToken.set(row.device_token, row);
      return result([row]);
    }
    if (sql.includes('FROM displays WHERE device_token = $1::uuid')) {
      const row = byToken.get(String(values[0]).toLowerCase());
      return result(row ? [row] : []);
    }
    if (sql.startsWith('UPDATE displays SET last_seen_at = now() WHERE id = $1')) return result([]);
    return { rows: [], rowCount: 0 };
  };
  return { count: () => byToken.size, db: { query } };
}

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

describe('POST /api/tv/register (no login)', () => {
  it('cannot be used by one host to stop other TVs from pairing', { timeout: 120_000 }, async () => {
    const { count, db } = fakeDb();
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

    const register = (remoteAddress: string) =>
      app.inject({ method: 'POST', url: '/api/tv/register', remoteAddress, payload: { device_token: randomUUID() } });

    // One host on the plant LAN keeps registering random device tokens until the code space is
    // full, or the server starts refusing it (rate limit, quota), or a generous attempt budget runs out.
    let attempts = 0;
    while (count() < CODE_SPACE && attempts < 60_000) {
      attempts += 1;
      const res = await register('10.0.0.66');
      if (res.statusCode === 429 || res.statusCode === 403 || res.statusCode === 503) break;
    }

    // A genuinely new TV on another host now powers up and asks for a pairing code.
    const tv = await register('10.0.0.20');
    expect(tv.statusCode, `new TV registration after ${attempts} anonymous registrations (${count()} display rows)`).toBe(200);
    expect(tv.json().pairing_code).toMatch(/^\d{4}$/);
  });
});
