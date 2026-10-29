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

/** An in-memory `shifts` table behind the same SQL the repo sends. */
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
      const row: ShiftRow = { id: nextId++, name, start_local: start, end_local: end, days_of_week: days, effective_from: from, effective_to: to };
      shifts.push(row);
      return ok([{ ...row }]);
    }
    if (q.startsWith('UPDATE shifts SET effective_to')) {
      const row = shifts.find((s) => s.id === params[1]);
      if (row) row.effective_to = params[0] as string | null;
      return ok(row ? [{ ...row }] : []);
    }
    if (q.startsWith('UPDATE shifts SET name')) {
      const [name, start, end, days, from, to, id] = params as [string, string, string, number[], string, string | null, number];
      const row = shifts.find((s) => s.id === id);
      if (!row) return ok();
      Object.assign(row, { name, start_local: start, end_local: end, days_of_week: days, effective_from: from, effective_to: to });
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
          if (sql === 'ROLLBACK') {
            if (saved) shifts = saved;
            return ok();
          }
          if (sql === 'COMMIT') return ok();
          return run(sql, params);
        },
        release: () => undefined,
      };
    },
  };
  return { db, pool, rows: () => structuredClone(shifts) };
}

/** Shifts in effect on a plant-local day, the way the engine reads the table (days_of_week + effective range). */
function inEffectOn(rows: ShiftRow[], date: string): ShiftRow[] {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return rows.filter(
    (s) => s.effective_from <= date && (s.effective_to === null || date <= s.effective_to) && s.days_of_week.includes(weekday),
  );
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

describe('editing a shift keeps the days already recorded', () => {
  it('does not change the definition of a past day when the times are edited and "Effective from" is left as the form shows it', async () => {
    // The edit form is pre-filled with the stored effective_from (ShiftForm: useState(initial?.effective_from)),
    // so an admin who only changes the times sends the same effective_from back.
    const day: ShiftRow = {
      id: 1,
      name: 'Day',
      start_local: '07:00',
      end_local: '19:00',
      days_of_week: EVERY_DAY,
      effective_from: '2025-01-01',
      effective_to: null,
    };
    const store = fakeShiftsDb([day]);
    const app = await appFor(store);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/shifts/1',
      payload: {
        name: 'Day',
        start_local: '06:00',
        end_local: '18:00',
        days_of_week: EVERY_DAY,
        effective_from: '2025-01-01',
        effective_to: null,
      },
    });
    expect(res.statusCode).toBeLessThan(500);

    // SPEC 10.2 / ShiftForm: "Editing creates a new version ... Days already recorded keep the definition
    // that was in effect then". 2025-06-15 is long past in every run; it must still read 07:00-19:00.
    const past = inEffectOn(store.rows(), '2025-06-15');
    expect(past.map((s) => `${s.start_local}-${s.end_local}`)).toEqual(['07:00-19:00']);
  });
});
