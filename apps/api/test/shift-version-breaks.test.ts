import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

interface AuditRow {
  action: string;
  entity_id: string;
  before: { shift_ids?: number[] | null } | null;
  after: { shift_ids?: number[] | null } | null;
}

/**
 * The `shifts`, `breaks` and `audit_log` tables behind the statements the schedule routes send, and one
 * admin. ROLLBACK undoes the writes since BEGIN; a statement matching `failOn` throws.
 */
function fakeScheduleDb(shifts: ShiftDef[], breaks: BreakDef[], failOn?: RegExp) {
  const admin = { id: 1, username: 'admin', role: 'admin', active: true, created_at: new Date(0), last_login_at: null };
  const audit: AuditRow[] = [];
  let nextShiftId = Math.max(0, ...shifts.map((s) => s.id)) + 1;
  let snapshot: { shifts: ShiftDef[]; breaks: BreakDef[] } | null = null;
  const result = <T>(rows: T[]) => ({ rows: rows.map((r) => structuredClone(r)), rowCount: rows.length });
  const query = async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    if (failOn?.test(sql)) throw new Error(`simulated failure of: ${sql}`);
    if (sql === 'BEGIN') {
      snapshot = structuredClone({ shifts, breaks });
      return result([]);
    }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (sql === 'ROLLBACK' && snapshot) {
        shifts.splice(0, shifts.length, ...snapshot.shifts);
        breaks.splice(0, breaks.length, ...snapshot.breaks);
      }
      snapshot = null;
      return result([]);
    }
    if (sql.startsWith('INSERT INTO audit_log ')) {
      const [, action, , entity_id, before, after] = values as [unknown, string, string, string, string, string];
      audit.push({ action, entity_id, before: JSON.parse(before), after: JSON.parse(after) });
      return result([]);
    }
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
  return { query, connect: async () => client, audit };
}

let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

async function boot(
  shifts: ShiftDef[],
  breaks: BreakDef[],
  failOn?: RegExp,
): Promise<{ app: FastifyInstance; cookie: string; audit: AuditRow[] }> {
  const db = fakeScheduleDb(shifts, breaks, failOn);
  const app = await buildServer({
    env: { sessionSecret: SECRET },
    db,
    pool: db,
    log: pino({ level: 'silent' }),
    sse: { addClient: () => 0, removeClient: () => undefined, broadcast: () => undefined },
    version: 'test',
  } as unknown as AppContext);
  closers.push(() => app.close());
  return { app, cookie: `fld_session=${await signSession({ userId: 1, role: 'admin' }, SECRET)}`, audit: db.audit };
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
    // Only a version not in effect yet takes new times in place.
    const { app, cookie } = await boot(
      [shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00', effective_from: '2099-01-01' })],
      [breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] })],
    );

    const updated = await editShift(app, cookie, 1, {
      name: 'Day',
      start_local: '06:00',
      end_local: '18:00',
      days_of_week: ALL_DAYS,
      effective_from: '2099-01-01',
      effective_to: null,
    });
    expect(updated.id).toBe(1);
    expect((await list<BreakDef>(app, cookie, 'breaks')).map((b) => b.shift_ids)).toEqual([[1]]);
  });

  it('keeps the end date of a version that had already ended', async () => {
    const { app, cookie } = await boot(
      [
        shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00', effective_to: '2026-03-31' }),
        shift({ id: 2, name: 'Day', start_local: '06:00', end_local: '18:00', effective_from: '2026-04-01' }),
      ],
      [],
    );

    await editShift(app, cookie, 1, {
      name: 'Evening',
      start_local: '18:00',
      end_local: '23:00',
      days_of_week: ALL_DAYS,
      effective_from: '2026-11-08',
      effective_to: null,
    });
    // Closing it the day before would put 07:00-19:00 back on every day from April on, next to 06:00-18:00.
    expect((await list<ShiftDef>(app, cookie, 'shifts')).map((s) => [s.id, s.start_local, s.effective_from, s.effective_to])).toEqual([
      [1, '07:00', '2026-01-01', '2026-03-31'],
      [2, '06:00', '2026-04-01', null],
      [3, '18:00', '2026-11-08', null],
    ]);
  });

  it('records each break it changed in the audit log', async () => {
    const { app, cookie, audit } = await boot(
      [shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' })],
      [
        breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] }),
        breakDef({ id: 2, name: 'Afternoon', start_local: '14:00', duration_minutes: 15, shift_ids: null }),
      ],
    );

    await editShift(app, cookie, 1, {
      name: 'Day',
      start_local: '06:00',
      end_local: '18:00',
      days_of_week: ALL_DAYS,
      effective_from: '2026-11-08',
      effective_to: null,
    });
    expect(audit.map((e) => [e.action, e.entity_id, e.before?.shift_ids, e.after?.shift_ids])).toEqual([
      ['shift.versioned', '2', undefined, undefined],
      ['break.updated', '1', [1], [1, 2]],
    ]);
  });

  it('rolls the whole edit back when the breaks cannot be updated', async () => {
    const { app, cookie } = await boot(
      [shift({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' })],
      [breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] })],
      /^UPDATE breaks /,
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/shifts/1',
      headers: { cookie },
      payload: {
        name: 'Day',
        start_local: '06:00',
        end_local: '18:00',
        days_of_week: ALL_DAYS,
        effective_from: '2026-11-08',
        effective_to: null,
      },
    });
    expect(res.statusCode).toBe(500);
    // Not the old version closed with no new one, nor a new version that Lunch does not know about.
    expect((await list<ShiftDef>(app, cookie, 'shifts')).map((s) => [s.id, s.effective_to])).toEqual([[1, null]]);
    expect((await list<BreakDef>(app, cookie, 'breaks')).map((b) => b.shift_ids)).toEqual([[1]]);
  });
});

/**
 * Without a later effective-from the row is updated in place, and every day it covers is evaluated
 * against it (spec 10.2): a version in effect before today must keep its times and days.
 */
describe('PUT /api/admin/shifts/:id without a later effective-from', () => {
  const day = { name: 'Day', start_local: '07:00', end_local: '19:00', days_of_week: ALL_DAYS, effective_to: null };

  beforeEach(() => {
    // 15:00 on 4 November 2026 in New York, the default plant time zone.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 4, 20));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function refused(stored: ShiftDef, body: ShiftWrite): Promise<void> {
    const lunch = breakDef({ id: 1, name: 'Lunch', start_local: '11:00', shift_ids: [1] });
    const { app, cookie, audit } = await boot([structuredClone(stored)], [lunch]);
    const res = await app.inject({ method: 'PUT', url: '/api/admin/shifts/1', headers: { cookie }, payload: body });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json<{ message: string }>().message).toContain('need a later "Effective from"');
    expect(await list<ShiftDef>(app, cookie, 'shifts')).toEqual([stored]);
    expect((await list<BreakDef>(app, cookie, 'breaks')).map((b) => b.shift_ids)).toEqual([[1]]);
    expect(audit).toEqual([]);
  }

  it.each([
    ['times', { start_local: '06:00', end_local: '18:00', effective_from: '2026-01-01' }],
    ['days', { days_of_week: [1, 2, 3, 4, 5], effective_from: '2026-01-01' }],
    ['times from an earlier effective-from', { start_local: '06:00', end_local: '18:00', effective_from: '2025-06-01' }],
  ])('refuses new %s for a version in effect before today and changes nothing', async (_what, change) => {
    await refused(shift({ id: 1, ...day }), { ...day, ...change });
  });

  it('refuses new times for a version that started yesterday in the plant time zone', async () => {
    const stored = shift({ id: 1, ...day, effective_from: '2026-11-03' });
    await refused(stored, { ...day, start_local: '06:00', end_local: '18:00', effective_from: '2026-11-03' });
  });

  it('takes new times in place for a version that starts today in the plant time zone', async () => {
    // 21:00 on 4 November in New York, already 5 November in UTC.
    vi.setSystemTime(Date.UTC(2026, 10, 5, 2));
    const { app, cookie } = await boot([shift({ id: 1, ...day, effective_from: '2026-11-04' })], []);
    const updated = await editShift(app, cookie, 1, { ...day, start_local: '06:00', end_local: '18:00', effective_from: '2026-11-04' });
    expect(updated).toEqual(shift({ id: 1, ...day, start_local: '06:00', end_local: '18:00', effective_from: '2026-11-04' }));
  });

  it('still renames a version in effect before today and moves its end date in place', async () => {
    const { app, cookie } = await boot([shift({ id: 1, ...day })], []);
    const updated = await editShift(app, cookie, 1, { ...day, name: 'Day shift', effective_from: '2026-01-01', effective_to: '2026-11-30' });
    expect(updated).toEqual(shift({ id: 1, ...day, name: 'Day shift', effective_to: '2026-11-30' }));
  });
});
