import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { expandBreaks } from '@fld/engine';
import type { BreakDef, ShiftDef, ShiftWrite } from '@fld/shared';
import type { AppContext } from '../src/context.js';
import { signSession } from '../src/auth/session.js';
import { buildServer } from '../src/server.js';

/**
 * Editing a shift with a later "Effective from" closes the old row and inserts the new version under a
 * new id (spec 10.2). The engine only places a break scoped to selected shifts while one of its
 * `shift_ids` is in progress at the break start, so the edit must not leave those breaks on the old id.
 */
const SECRET = 'a-very-long-test-session-secret-value';
const TZ = 'America/New_York';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const MIN = 60_000;

function shift(s: Pick<ShiftDef, 'id' | 'name' | 'start_local' | 'end_local'> & Partial<ShiftDef>): ShiftDef {
  return { days_of_week: ALL_DAYS, effective_from: '2026-01-01', effective_to: null, ...s };
}

function breakDef(b: Pick<BreakDef, 'id' | 'name' | 'start_local' | 'shift_ids'> & Partial<BreakDef>): BreakDef {
  return { duration_minutes: 30, days_of_week: ALL_DAYS, effective_from: '2026-01-01', effective_to: null, ...b };
}

/** The `shifts` and `breaks` tables behind the statements the schedule routes send, and one admin. */
function fakeScheduleDb(shifts: ShiftDef[], breaks: BreakDef[]) {
  const admin = { id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null };
  let nextShiftId = Math.max(0, ...shifts.map((s) => s.id)) + 1;
  const result = <T>(rows: T[]) => ({ rows: rows.map((r) => structuredClone(r)), rowCount: rows.length });
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (sql.includes('FROM users WHERE id = $1')) return result([admin]);
    if (/FROM shifts WHERE id = \$1$/.test(sql)) return result(shifts.filter((s) => s.id === values[0]));
    if (/FROM shifts ORDER BY /.test(sql)) return result(shifts);
    if (sql.startsWith('UPDATE shifts SET effective_to = $1::date WHERE id = $2')) {
      const row = shifts.find((s) => s.id === values[1]);
      if (row) row.effective_to = values[0] as string;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    const shiftValues = () => {
      const [name, start_local, end_local, days_of_week, effective_from, effective_to] = values as [
        string,
        string,
        string,
        number[],
        string,
        string | null,
      ];
      return { name, start_local, end_local, days_of_week, effective_from, effective_to };
    };
    if (sql.startsWith('INSERT INTO shifts ')) {
      const row = { id: nextShiftId++, ...shiftValues() };
      shifts.push(row);
      return result([row]);
    }
    if (sql.startsWith('UPDATE shifts SET name = $1, ')) {
      const row = shifts.find((s) => s.id === values[6]);
      if (row) Object.assign(row, shiftValues());
      return result(row ? [row] : []);
    }
    if (/FROM breaks ORDER BY /.test(sql)) return result(breaks);
    if (/^UPDATE breaks SET shift_ids = array_append\(shift_ids, \$2(::int)?\) WHERE \$1(::int)? = ANY\(shift_ids\)/.test(sql)) {
      const [from, to] = values as [number, number];
      const changed = breaks.filter((b) => b.shift_ids?.includes(from) && !b.shift_ids.includes(to));
      for (const b of changed) b.shift_ids = [...(b.shift_ids ?? []), to];
      return result(changed);
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => undefined };
  return { query, connect: async () => client };
}

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

async function boot(shifts: ShiftDef[], breaks: BreakDef[]): Promise<{ app: FastifyInstance; cookie: string }> {
  const db = fakeScheduleDb(shifts, breaks);
  const app = await buildServer({
    env: { sessionSecret: SECRET },
    db,
    pool: db,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext);
  closers.push(() => app.close());
  return { app, cookie: `fld_session=${await signSession({ userId: 1, role: 'admin' }, SECRET)}` };
}

async function editShift(app: FastifyInstance, cookie: string, id: number, body: ShiftWrite): Promise<ShiftDef> {
  const res = await app.inject({ method: 'PUT', url: `/api/admin/shifts/${id}`, headers: { cookie }, payload: body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<ShiftDef>();
}

async function list<T>(app: FastifyInstance, cookie: string, what: 'shifts' | 'breaks'): Promise<T[]> {
  const res = await app.inject({ method: 'GET', url: `/api/admin/${what}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<T[]>();
}

/** Break intervals the engine places on one plant-local day (New York is UTC-5 in November 2026). */
function breaksOn(day: number, breaks: BreakDef[], shifts: ShiftDef[]) {
  const from = Date.UTC(2026, 10, day, 5);
  return expandBreaks(breaks, shifts, from, from + 24 * 60 * MIN, TZ).map((b) => ({
    name: b.name,
    start: new Date(b.start_utc).toISOString(),
    minutes: (b.end_utc - b.start_utc) / MIN,
  }));
}

describe('PUT /api/admin/shifts/:id with a later effective-from', () => {
  it('keeps a break scoped to the shift applying to the new version', async () => {
    const { app, cookie } = await boot(
      [shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' })],
      [breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] })],
    );
    const lunch = [{ name: 'Lunch', start: '2026-11-04T16:00:00.000Z', minutes: 30 }];
    const before = { shifts: await list<ShiftDef>(app, cookie, 'shifts'), breaks: await list<BreakDef>(app, cookie, 'breaks') };
    expect(breaksOn(4, before.breaks, before.shifts)).toEqual(lunch);

    const version = await editShift(app, cookie, 1, {
      name: 'Day',
      start_local: '06:00',
      end_local: '18:00',
      days_of_week: ALL_DAYS,
      effective_from: '2026-11-08',
      effective_to: null,
    });
    expect(version.id).toBe(2);

    const shifts = await list<ShiftDef>(app, cookie, 'shifts');
    const breaks = await list<BreakDef>(app, cookie, 'breaks');
    expect(shifts.map((s) => [s.id, s.start_local, s.effective_from, s.effective_to])).toEqual([
      [1, '07:00', '2026-01-01', '2026-11-07'],
      [2, '06:00', '2026-11-08', null],
    ]);

    // Before the new version starts the old one still places Lunch; from its effective-from the new one does.
    expect(breaksOn(4, breaks, shifts)).toEqual(lunch);
    expect(breaksOn(9, breaks, shifts)).toEqual([{ name: 'Lunch', start: '2026-11-09T16:00:00.000Z', minutes: 30 }]);
    expect(breaks.find((b) => b.name === 'Lunch')?.shift_ids).toEqual([1, 2]);
  });

  it('adds the new version only to breaks scoped to the edited shift', async () => {
    const { app, cookie } = await boot(
      [
        shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' }),
        shift({ id: 2, name: 'Night', start_local: '19:00', end_local: '07:00' }),
      ],
      [
        breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] }),
        breakDef({ id: 2, name: 'Midnight meal', start_local: '23:00', shift_ids: [2] }),
        breakDef({ id: 3, name: 'Safety talk', start_local: '07:00', duration_minutes: 10, shift_ids: [2, 1] }),
        breakDef({ id: 4, name: 'Afternoon', start_local: '14:00', duration_minutes: 15, shift_ids: null }),
      ],
    );

    const version = await editShift(app, cookie, 1, {
      name: 'Day',
      start_local: '07:00',
      end_local: '19:00',
      days_of_week: [1, 2, 3, 4, 5],
      effective_from: '2026-11-08',
      effective_to: null,
    });
    expect(version.id).toBe(3);

    const breaks = await list<BreakDef>(app, cookie, 'breaks');
    expect(breaks.map((b) => [b.name, b.shift_ids])).toEqual([
      ['Lunch', [1, 3]],
      ['Midnight meal', [2]],
      ['Safety talk', [2, 1, 3]],
      ['Afternoon', null],
    ]);
  });

  it('leaves the breaks alone when the edit keeps the effective-from and so updates the row in place', async () => {
    const { app, cookie } = await boot(
      [shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' })],
      [breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] })],
    );

    const updated = await editShift(app, cookie, 1, {
      name: 'Day',
      start_local: '06:00',
      end_local: '18:00',
      days_of_week: ALL_DAYS,
      effective_from: '2026-01-01',
      effective_to: null,
    });
    expect(updated.id).toBe(1);
    expect((await list<BreakDef>(app, cookie, 'breaks')).map((b) => b.shift_ids)).toEqual([[1]]);
  });
});
