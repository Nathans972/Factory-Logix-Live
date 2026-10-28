import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Role } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { registerAdminScheduleRoutes } from '../src/routes/admin/schedule.js';

interface ShiftRow {
  id: number;
  name: string;
  start_local: string;
  end_local: string;
  days_of_week: number[];
  effective_from: string;
  effective_to: string | null;
}

/** Postgres refuses a `$n::date` that is not a real calendar day (SQLSTATE 22008). */
function pgDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const real = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !real || real.toISOString().slice(0, 10) !== text || Number(m[1]) < 1) {
    throw Object.assign(new Error(`date/time field value out of range: "${text}"`), { code: '22008' });
  }
  return text;
}

/** An in-memory `shifts` table behind the same SQL the repo sends, with BEGIN/COMMIT/ROLLBACK on `connect()`. */
function fakeShiftsDb(initial: ShiftRow[]) {
  let shifts: ShiftRow[] = structuredClone(initial);
  let nextId = Math.max(0, ...initial.map((s) => s.id)) + 1;
  const ok = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });

  const run = async (sql: string, params: unknown[] = []) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT') && q.includes('FROM shifts ORDER BY')) {
      return ok([...shifts].sort((a, b) => a.effective_from.localeCompare(b.effective_from) || a.id - b.id).map((s) => ({ ...s })));
    }
    if (q.startsWith('SELECT') && q.includes('FROM shifts WHERE id = $1')) {
      return ok(shifts.filter((s) => s.id === params[0]).map((s) => ({ ...s })));
    }
    if (q.startsWith('INSERT INTO shifts')) {
      const [name, start, end, days, from, to] = params as [string, string, string, number[], string, string | null];
      const row: ShiftRow = {
        id: nextId++,
        name,
        start_local: start,
        end_local: end,
        days_of_week: days,
        effective_from: pgDate(from) as string,
        effective_to: pgDate(to),
      };
      shifts.push(row);
      return ok([{ ...row }]);
    }
    if (q.startsWith('UPDATE shifts SET effective_to')) {
      const row = shifts.find((s) => s.id === params[1]);
      if (row) row.effective_to = pgDate(params[0]);
      return ok(row ? [{ ...row }] : []);
    }
    if (q.startsWith('UPDATE shifts SET name')) {
      const [name, start, end, days, from, to, id] = params as [string, string, string, number[], string, string | null, number];
      const row = shifts.find((s) => s.id === id);
      if (!row) return ok();
      Object.assign(row, {
        name,
        start_local: start,
        end_local: end,
        days_of_week: days,
        effective_from: pgDate(from),
        effective_to: pgDate(to),
      });
      return ok([{ ...row }]);
    }
    if (q.startsWith('DELETE FROM shifts')) {
      shifts = shifts.filter((s) => s.id !== params[0]);
      return ok();
    }
    if (q.startsWith('INSERT INTO audit_log') || q.includes('pg_notify')) return ok();
    throw new Error(`fake db: unexpected SQL ${q}`);
  };

  const db = { query: run };
  const pool = {
    query: run,
    connect: async () => {
      let saved: ShiftRow[] | null = null;
      return {
        query: async (sql: string, params?: unknown[]) => {
          if (sql === 'BEGIN') {
            saved = structuredClone(shifts);
            return ok();
          }
          if (sql === 'COMMIT') {
            saved = null;
            return ok();
          }
          if (sql === 'ROLLBACK') {
            if (saved) shifts = saved;
            saved = null;
            return ok();
          }
          return run(sql, params);
        },
        release: () => undefined,
      };
    },
  };
  return { db, pool, rows: () => structuredClone(shifts) };
}

let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function appFor(store: ReturnType<typeof fakeShiftsDb>): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { id: 1, username: 'admin', role: 'admin' as Role, active: true, created_at: 0, last_login_at: null };
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ message: err.message });
  });
  const ctx = {
    db: store.db,
    pool: store.pool,
    log: { warn: () => undefined, error: () => undefined },
    sse: { broadcast: () => undefined },
  } as unknown as AppContext;
  app.decorate('ctx', ctx);
  await registerAdminScheduleRoutes(app, ctx);
  server = app;
  return app;
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const DAY_SHIFT: ShiftRow = {
  id: 1,
  name: 'Day',
  start_local: '07:00',
  end_local: '19:00',
  days_of_week: EVERY_DAY,
  effective_from: '2025-01-01',
  effective_to: null,
};
const NEW_TIMES = { name: 'Day', start_local: '06:00', end_local: '18:00', days_of_week: EVERY_DAY, effective_to: null };

describe('shift versions and dates that are not on the calendar', () => {
  it('does not end the current version of a shift when the new version cannot be saved', async () => {
    const store = fakeShiftsDb([DAY_SHIFT]);
    const app = await appFor(store);

    // 2026-02-29 passes `localDateSchema` (YYYY-MM-DD) but is not a day; previousDay() maps it to 2026-02-28.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/shifts/1',
      payload: { ...NEW_TIMES, effective_from: '2026-02-29' },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    // Whatever the answer, the stored definition must be exactly what it was: still open-ended, no gap.
    expect(store.rows()).toEqual([DAY_SHIFT]);
  });

  it('answers 400, not 500, for a shift whose effective date is not on the calendar', async () => {
    const store = fakeShiftsDb([]);
    const app = await appFor(store);

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/shifts',
      payload: { ...NEW_TIMES, effective_from: '2026-04-31' },
    });

    expect(res.statusCode).toBe(400);
  });
});
