/**
 * Shift view (spec 9.2, 10.4) after a versioned shift edit: "past shifts are always evaluated
 * against the definition in effect on that day". The Shift page keeps the selected shift_id when
 * the date input changes, so picking an earlier date sends the current version's id with a date
 * before that version took effect. The request must not report that day with the new times.
 *
 * Hour cells come from the real engine (`computeHourCells`); the fake database answers the queries
 * the shift view issues.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  pickEngineSettings,
  type HourCell,
  type ShiftView,
  type Standard,
  type UnitStep,
} from '@fld/shared';
import { buildStandardsLookup, computeHourCells } from '@fld/engine';
import type { Db } from '../src/db/pool.js';
import { ApiError } from '../src/errors.js';
import { buildShiftViewForQuery } from '../src/services/shift-view.js';

const at = (iso: string): number => Date.parse(iso);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

// The plant moved both shifts one hour earlier from 2025-06-02 (versioned edit: the old rows got
// effective_to 2025-06-01, new rows with new ids start 2025-06-02).
const SHIFT_ROWS = [
  { id: 1, name: 'Day', start_local: '07:00', end_local: '19:00', days_of_week: EVERY_DAY, effective_from: '2025-01-01', effective_to: '2025-06-01' },
  { id: 2, name: 'Night', start_local: '19:00', end_local: '07:00', days_of_week: EVERY_DAY, effective_from: '2025-01-01', effective_to: '2025-06-01' },
  { id: 3, name: 'Day', start_local: '06:00', end_local: '18:00', days_of_week: EVERY_DAY, effective_from: '2025-06-02', effective_to: null },
  { id: 4, name: 'Night', start_local: '18:00', end_local: '06:00', days_of_week: EVERY_DAY, effective_from: '2025-06-02', effective_to: null },
];

function fakeDb(steps: UnitStep[], cells: HourCell[]): Db {
  const answer = (sql: string, params: unknown[]): unknown[] => {
    const ms = (v: unknown) => (v as Date).getTime();
    if (sql.includes('FROM settings')) return [];
    if (sql.includes('FROM shifts')) return SHIFT_ROWS;
    if (sql.includes('FROM hour_cells c JOIN operations o') && sql.includes('c.hour_start_utc >= $1 AND c.hour_start_utc < $2')) {
      const [from, to] = [ms(params[0]), ms(params[1])];
      return cells.filter((c) => c.hour_start_utc >= from && c.hour_start_utc < to).map((c) => ({ ...c, hour_start_utc: new Date(c.hour_start_utc) }));
    }
    if (sql.startsWith('SELECT DISTINCT job_number FROM unit_steps') || sql.startsWith('SELECT job_number FROM unit_steps')) {
      const [from, to] = [ms(params[0]), ms(params[1])];
      const inside = (t: number | null) => t !== null && t >= from && t < to;
      return [...new Set(steps.filter((s) => inside(s.start_ts) || inside(s.complete_ts)).map((s) => s.job_number))].map((job_number) => ({ job_number }));
    }
    if (sql.includes('FROM work_orders w WHERE w.job_number = ANY')) {
      return (params[0] as string[]).map((job_number) => ({
        job_number, product_number: 'Z-200', product_name: null, qty_released: 500, qty_complete: 100, status: 'In Process', fl_created_at: null, fl_modified_at: null,
      }));
    }
    if (sql.includes('FROM product_routes r JOIN operations o')) return (params[0] as string[]).map((product_number) => ({ product_number, operation: 'Test' }));
    if (sql.includes('FROM operators WHERE operator_id = ANY')) return [];
    if (sql.includes('count(DISTINCT s.unit_id)')) return [];
    throw new Error(`fake db: unexpected query: ${sql}`);
  };
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const rows = answer(sql.replace(/\s+/g, ' ').trim(), params);
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  } as unknown as Db;
}

let seq = 0;
function unitsEvery10Min(operator: string, from: string, to: string): UnitStep[] {
  const out: UnitStep[] = [];
  for (let t = at(from); t < at(to); t += 10 * 60_000) {
    seq += 1;
    out.push({
      unit_id: `U-${seq}`, job_number: 'J-200', product_number: 'Z-200', operation: 'Test', operation_seq: null,
      operator_id: operator, start_ts: t, complete_ts: t + 9 * 60_000, result: null, rework_flag: null,
    });
  }
  return out;
}

const STD: Standard = {
  product_number: 'Z-200', operation: 'Test', computed_std_hr: 6, median_minutes_per_unit: 10, sample_units: 300,
  sample_operators: 5, sample_from: null, sample_to: null, computed_at: 0, fallback_source: 'computed', fl_std_hr: null,
};

describe('shift view for a date before the current shift version', () => {
  // Tuesday 2025-05-20, under the old times: night shift (ALee) until 07:00, day shift (BKim) 07:00-19:00.
  const steps = [
    ...unitsEvery10Min('ALee', '2025-05-20T05:00:00-04:00', '2025-05-20T07:00:00-04:00'),
    ...unitsEvery10Min('BKim', '2025-05-20T07:00:00-04:00', '2025-05-20T19:00:00-04:00'),
  ];
  const NOW = at('2025-06-10T10:00:00-04:00');
  const { cells } = computeHourCells({
    steps,
    breaks: [],
    standards: buildStandardsLookup([STD], [], []),
    pins: [],
    settings: pickEngineSettings(DEFAULT_SETTINGS),
    from_utc: at('2025-05-20T04:00:00-04:00'),
    to_utc: at('2025-05-20T20:00:00-04:00'),
    now: NOW,
  });
  const db = fakeDb(steps, cells);

  it('reports May 20 with the Day shift as it was defined on May 20 (07:00-19:00), or refuses', async () => {
    // What the Shift page requests after the user changes the date from today to May 20.
    let view: ShiftView | null = null;
    try {
      view = await buildShiftViewForQuery(db, { date: '2025-05-20', shift_id: 3 }, NOW);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
    if (view === null) return; // refusing a version that was not in effect that day is also correct

    expect([new Date(view.shift.start_utc).toISOString(), new Date(view.shift.end_utc).toISOString()]).toEqual([
      new Date(at('2025-05-20T07:00:00-04:00')).toISOString(),
      new Date(at('2025-05-20T19:00:00-04:00')).toISOString(),
    ]);
    // 72 boards tested by the day shift; none of the night shift's.
    expect(view.summary.total_units).toBe(72);
    expect(view.rollups.by_operator.map((r) => r.operator_id)).toEqual(['BKim']);
  });
});
