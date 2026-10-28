import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { SseHub } from '../src/sse.js';

// The dashboard, settings and sync-health services are not what is under test: keep them canned.
vi.mock('../src/services/dashboard.js', () => ({
  buildDashboard: async (_db: unknown, job: string) => ({
    job: { job_number: job },
    rows: [{ operator_id: 'jsmith', operator_name: 'Jane Smith', units: 42 }],
  }),
}));
vi.mock('../src/db/repo/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db/repo/settings.js')>()),
  getSettings: async () => DEFAULT_SETTINGS,
}));
vi.mock('../src/services/sync-health.js', () => ({
  buildSyncHealth: async () => ({ status: 'ok', delayed: false, delayed_since: null, last_success_at: 1 }),
}));

const { buildServer } = await import('../src/server.js');

const SECRET = 'a-very-long-test-session-secret-value';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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

/** An in-memory `displays` table behind the same SQL the repository sends, plus one admin user. */
function fakeDb() {
  const rows: Row[] = [];
  let nextId = 1;
  const admin = { id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null };
  const result = (found: Row[]) => ({ rows: found, rowCount: found.length });
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM users WHERE id = $1')) return { rows: [admin], rowCount: 1 };
    if (sql.startsWith('INSERT INTO displays')) {
      const [code, token] = values as string[];
      if (rows.some((r) => r.pairing_code === code || r.device_token === token.toLowerCase())) {
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
      rows.push(row);
      return result([row]);
    }
    if (sql.includes('FROM displays WHERE device_token = $1::uuid')) {
      return result(rows.filter((r) => r.device_token === String(values[0]).toLowerCase()));
    }
    if (sql.includes('FROM displays WHERE pairing_code = $1')) return result(rows.filter((r) => r.pairing_code === values[0]));
    if (sql.includes('FROM displays WHERE id = $1')) return result(rows.filter((r) => r.id === values[0]));
    if (sql.startsWith('UPDATE displays SET last_seen_at = now() WHERE id = $1')) {
      for (const r of rows) if (r.id === values[0]) r.last_seen_at = new Date();
      return result([]);
    }
    if (sql.startsWith('UPDATE displays SET') && sql.includes('claimed_at = COALESCE')) {
      // updateDisplayRow(): `col = $n` pairs, the id is the last parameter.
      const row = rows.find((r) => r.id === values[values.length - 1]);
      if (!row) return result([]);
      for (const m of sql.matchAll(/(\w+) = \$(\d+)/g)) (row as unknown as Record<string, unknown>)[m[1]] = values[Number(m[2]) - 1];
      row.claimed_at = row.claimed_at ?? new Date();
      return result([row]);
    }
    return { rows: [], rowCount: 0 };
  };
  return { rows, db: { query } };
}

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

async function setup() {
  const { rows, db } = fakeDb();
  const log = pino({ level: 'silent' });
  const sse = new SseHub('postgres://unused', log); // never started: no LISTEN connection needed
  const ctx = { env: { sessionSecret: SECRET }, pool: db, db, log, sse, version: 'test' } as unknown as AppContext;
  const app = await buildServer(ctx);
  closers.push(() => app.close());
  const cookie = `fld_session=${await signSession({ userId: 1, role: 'admin' }, SECRET)}`;
  return { app, sse, rows, cookie };
}

describe('anonymous /api/events stream', () => {
  it('does not hand out anything that unlocks a job dashboard', async () => {
    const { app, sse, rows, cookie } = await setup();

    // Someone on the plant LAN opens the event stream without logging in.
    const stream = app.inject({ method: 'GET', url: '/api/events' });

    // A real TV pairs and an admin claims it for job J-100.
    const tvToken = '0b8d6f0e-2f0a-4c55-9d0c-3a1f6f1d7a11';
    const reg = await app.inject({ method: 'POST', url: '/api/tv/register', payload: { device_token: tvToken } });
    expect(reg.statusCode).toBe(200);
    const claim = await app.inject({
      method: 'POST',
      url: '/api/admin/displays/claim',
      headers: { cookie },
      payload: { pairing_code: rows[0].pairing_code, name: 'Line 3', job_number: 'J-100' },
    });
    expect(claim.statusCode).toBe(200);

    // Close the stream and read what the anonymous listener received.
    await sse.stop();
    const seen = (await stream).payload;

    // Whatever the stream revealed, try it as a TV token, the way an attacker would.
    const leaked = [...new Set(seen.match(UUID_RE) ?? [])];
    const unlocked: string[] = [];
    for (const token of leaked) {
      const res = await app.inject({ method: 'GET', url: `/api/tv/${token}/state` });
      if (res.statusCode === 200 && res.json().dashboard) unlocked.push(token);
    }
    expect(unlocked, 'TV device tokens visible to an anonymous /api/events listener that return the job dashboard').toEqual([]);
  });
});
