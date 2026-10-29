import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BreakDef, BreakWrite, Role, ShiftDef } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { invalidateSettingsCache } from '../src/db/repo/settings.js';
import { registerAdminScheduleRoutes } from '../src/routes/admin/schedule.js';
import { registerAdminSettingsRoutes } from '../src/routes/admin/settings.js';

/**
 * The collector only recomputes the current and previous hour (and the hours new rows touch), and
 * stored hour cells keep the settings, shifts and breaks they were computed with. So after a change
 * the cells depend on, the API asks it to recompute today's and yesterday's (docs/API.md); other
 * settings leave the cells alone. See also engine-settings-recompute.test.ts.
 */
const TZ = 'America/Chicago';
// 21:30 on Sunday 1 November 2026 in Chicago, the day daylight saving time ended: yesterday began at
// 00:00 CDT (UTC-5), 46.5 hours earlier, not 24 + 21.5.
const NOW = Date.parse('2026-11-02T03:30:00Z');
const YESTERDAY_START = Date.parse('2026-10-31T05:00:00Z');

type Control = { cmd: string; from_utc?: number; to_utc?: number };

const lunchWrite: BreakWrite = {
  name: 'Lunch',
  start_local: '11:00',
  duration_minutes: 30,
  days_of_week: [1, 2, 3, 4, 5],
  shift_ids: null,
  effective_from: '2026-01-01',
  effective_to: null,
};
const lunch: BreakDef = { id: 7, ...lunchWrite };
const day: ShiftDef = {
  id: 3,
  name: 'Day',
  start_local: '07:00',
  end_local: '15:30',
  days_of_week: [1, 2, 3, 4, 5],
  effective_from: '2026-01-01',
  effective_to: null,
};

/** The settings, shifts and breaks tables behind the statements these routes send, and the NOTIFYs on the control channel. */
function fakeDb() {
  const notified: Control[] = [];
  const settings = new Map<string, unknown>([['plant_timezone', TZ]]);
  const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const q = sql.replace(/\s+/g, ' ').trim();
      if (q.includes('pg_notify')) {
        notified.push(JSON.parse(params[1] as string) as Control);
        return ok();
      }
      if (q.startsWith('SELECT key, value FROM settings')) return ok([...settings].map(([key, value]) => ({ key, value })));
      if (q.startsWith('INSERT INTO settings')) {
        settings.set(params[0] as string, JSON.parse(params[1] as string));
        return ok();
      }
      if (q.startsWith('INSERT INTO audit_log')) return ok();
      if (/FROM breaks WHERE id = \$1$/.test(q)) return ok(params[0] === lunch.id ? [lunch] : []);
      if (q.startsWith('UPDATE breaks SET name = $1')) {
        const [name, start_local, duration_minutes, days_of_week, shift_ids, effective_from, effective_to, id] = params;
        return ok([{ id, name, start_local, duration_minutes, days_of_week, shift_ids, effective_from, effective_to }]);
      }
      if (/FROM shifts WHERE id = \$1$/.test(q)) return ok(params[0] === day.id ? [day] : []);
      if (q.startsWith('DELETE FROM shifts WHERE id = $1')) return ok([{}]);
      throw new Error(`fake db: unexpected SQL ${q}`);
    },
  };
  return { db, notified };
}

let server: FastifyInstance | null = null;

beforeEach(() => {
  invalidateSettingsCache();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(async () => {
  vi.useRealTimers();
  await server?.close();
  server = null;
});

async function appFor(db: ReturnType<typeof fakeDb>['db']): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { id: 1, username: 'admin', role: 'admin' as Role, active: true, created_at: 0, last_login_at: null };
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const ctx = { db, pool: db, log: { warn: () => undefined, error: () => undefined }, sse: { broadcast: () => undefined } } as unknown as AppContext;
  app.decorate('ctx', ctx);
  await registerAdminSettingsRoutes(app, ctx);
  await registerAdminScheduleRoutes(app, ctx);
  server = app;
  return app;
}

const todayAndYesterday = [{ cmd: 'restart' }, { cmd: 'recompute_cells', from_utc: YESTERDAY_START, to_utc: NOW }];

describe('saving settings', () => {
  it('asks for the hour cells of today and yesterday, plant time, after the restart that loads them', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/settings', payload: { neutral_minutes: 8, retention_days_raw_events: 30 } });
    expect(res.statusCode, res.body).toBe(200);
    expect(store.notified).toEqual(todayAndYesterday);
  });

  it('counts those days in the plant time zone being saved', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/settings', payload: { plant_timezone: 'Europe/Berlin' } });
    expect(res.statusCode, res.body).toBe(200);
    // 04:30 on 2 November in Berlin: yesterday is 1 November, from 00:00 CET (UTC+1).
    expect(store.notified).toEqual([{ cmd: 'restart' }, { cmd: 'recompute_cells', from_utc: Date.parse('2026-10-31T23:00:00Z'), to_utc: NOW }]);
  });

  it.each([
    ['settings the hour cells do not depend on', { retention_days_raw_events: 30, floor_idle_flag_minutes: 20, poll_interval_seconds: 60 }],
    ['an hour cell setting saved at the value it has', { color_yellow_below: 0.9, plant_timezone: TZ }],
  ])('only restarts the collector for %s', async (_what, patch) => {
    const store = fakeDb();
    const app = await appFor(store.db);
    const res = await app.inject({ method: 'PATCH', url: '/api/admin/settings', payload: patch });
    expect(res.statusCode, res.body).toBe(200);
    expect(store.notified).toEqual([{ cmd: 'restart' }]);
  });
});

describe('editing the schedule', () => {
  it('asks for the hour cells of today and yesterday after a break is changed', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    const res = await app.inject({ method: 'PUT', url: `/api/admin/breaks/${lunch.id}`, payload: { ...lunchWrite, start_local: '11:30' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(store.notified).toEqual(todayAndYesterday);
  });

  it('asks for the hour cells of today and yesterday after a shift is deleted', async () => {
    const store = fakeDb();
    const app = await appFor(store.db);
    const res = await app.inject({ method: 'DELETE', url: `/api/admin/shifts/${day.id}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(store.notified).toEqual(todayAndYesterday);
  });
});
