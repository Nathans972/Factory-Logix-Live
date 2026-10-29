/**
 * Shift view (spec 9.2) with shifts that change on the half hour (06:30 / 15:00 / 23:30), which the
 * shift form and schema accept. Hour cells cover whole clock hours, and the shift view takes the
 * cells whose hour starts inside the shift, so the 06:00-07:00 cell (half night shift, half day
 * shift) is reported entirely in the night shift.
 *
 * The hour cells are produced by the real engine (`computeHourCells`), the way the collector writes
 * them; the fake database answers the queries the shift view issues.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  pickEngineSettings,
  type HourCell,
  type Standard,
  type UnitStep,
  type WorkOrder,
} from '@fld/shared';
import { buildStandardsLookup, computeHourCells } from '@fld/engine';
import type { Db } from '../src/db/pool.js';
import { buildShiftViewForQuery } from '../src/services/shift-view.js';

const at = (iso: string): number => Date.parse(iso);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

const SHIFT_ROWS = [
  { id: 1, name: 'Day', start_local: '06:30', end_local: '15:00', days_of_week: EVERY_DAY, effective_from: '2025-01-01', effective_to: null },
  { id: 2, name: 'Swing', start_local: '15:00', end_local: '23:30', days_of_week: EVERY_DAY, effective_from: '2025-01-01', effective_to: null },
  { id: 3, name: 'Night', start_local: '23:30', end_local: '06:30', days_of_week: EVERY_DAY, effective_from: '2025-01-01', effective_to: null },
];

interface World {
  steps: UnitStep[];
  cells: HourCell[];
  workOrders: WorkOrder[];
}

function fakeDb(world: World): Db {
  const answer = (sql: string, params: unknown[]): unknown[] => {
    const ms = (v: unknown) => (v as Date).getTime();
    if (sql.includes('FROM settings')) return [];
    if (sql.includes('FROM shifts')) return SHIFT_ROWS;
    if (sql.includes('FROM hour_cells c JOIN operations o') && sql.includes('c.hour_start_utc >= $1 AND c.hour_start_utc < $2')) {
      const [from, to] = [ms(params[0]), ms(params[1])];
      return world.cells
        .filter((c) => c.hour_start_utc >= from && c.hour_start_utc < to)
        .map((c) => ({ ...c, hour_start_utc: new Date(c.hour_start_utc) }));
    }
    if (sql.startsWith('SELECT DISTINCT job_number FROM unit_steps') || sql.startsWith('SELECT job_number FROM unit_steps')) {
      const [from, to] = [ms(params[0]), ms(params[1])];
      const inside = (t: number | null) => t !== null && t >= from && t < to;
      return [...new Set(world.steps.filter((s) => inside(s.start_ts) || inside(s.complete_ts)).map((s) => s.job_number))].map(
        (job_number) => ({ job_number }),
      );
    }
    if (sql.includes('FROM work_orders w WHERE w.job_number = ANY')) {
      const jobs = params[0] as string[];
      return world.workOrders.filter((w) => jobs.includes(w.job_number));
    }
    if (sql.includes('FROM product_routes r JOIN operations o')) {
      return (params[0] as string[]).map((product_number) => ({ product_number, operation: 'Test' }));
    }
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
function unit(operator: string, start: string, complete: string): UnitStep {
  seq += 1;
  return {
    unit_id: `U-${seq}`,
    job_number: 'J-200',
    product_number: 'Z-200',
    operation: 'Test',
    operation_seq: null,
    operator_id: operator,
    start_ts: at(start),
    complete_ts: at(complete),
    result: null,
    rework_flag: null,
  };
}

const STD: Standard = {
  product_number: 'Z-200',
  operation: 'Test',
  computed_std_hr: 6,
  median_minutes_per_unit: 10,
  sample_units: 300,
  sample_operators: 5,
  sample_from: null,
  sample_to: null,
  computed_at: 0,
  fallback_source: 'computed',
  fl_std_hr: null,
};

describe('shift view with shifts that change on the half hour', () => {
  // Tuesday 2025-06-03, America/New_York (EDT). The night shift (ALee) tests boards until 06:25 and
  // goes home; the day shift (BKim) starts at 06:30 and tests a board every 10 minutes until 09:00.
  const steps: UnitStep[] = [];
  for (let m = 0; m < 60; m += 10) {
    const start = `2025-06-03T05:${String(m).padStart(2, '0')}:00-04:00`;
    const done = `2025-06-03T05:${String(m + 9).padStart(2, '0')}:00-04:00`;
    steps.push(unit('ALee', start, done));
  }
  steps.push(unit('ALee', '2025-06-03T06:00:00-04:00', '2025-06-03T06:09:00-04:00'));
  steps.push(unit('ALee', '2025-06-03T06:10:00-04:00', '2025-06-03T06:19:00-04:00'));
  for (let t = at('2025-06-03T06:30:00-04:00'); t < at('2025-06-03T09:00:00-04:00'); t += 10 * 60_000) {
    steps.push(unit('BKim', new Date(t).toISOString(), new Date(t + 9 * 60_000).toISOString()));
  }

  const NOW = at('2025-06-03T16:00:00-04:00');
  const { cells } = computeHourCells({
    steps,
    breaks: [],
    standards: buildStandardsLookup([STD], [], []),
    pins: [],
    settings: pickEngineSettings(DEFAULT_SETTINGS),
    from_utc: at('2025-06-02T23:00:00-04:00'),
    to_utc: at('2025-06-03T16:00:00-04:00'),
    now: NOW,
  });

  const db = fakeDb({
    steps,
    cells,
    workOrders: [
      { job_number: 'J-200', product_number: 'Z-200', product_name: null, qty_released: 500, qty_complete: 40, status: 'In Process', fl_created_at: null, fl_modified_at: null },
    ],
  });

  const completedIn = (from: string, to: string) =>
    steps.filter((s) => s.complete_ts !== null && s.complete_ts >= at(from) && s.complete_ts < at(to)).length;

  it('counts the units the day shift completed from 06:30 in the day shift', async () => {
    const day = await buildShiftViewForQuery(db, { date: '2025-06-03', shift_id: 1 }, NOW);
    expect(completedIn('2025-06-03T06:30:00-04:00', '2025-06-03T15:00:00-04:00')).toBe(15);
    expect(day.summary.total_units).toBe(15);
  });

  it('does not report a day-shift operator in the night shift', async () => {
    const night = await buildShiftViewForQuery(db, { date: '2025-06-02', shift_id: 3 }, NOW);
    expect(completedIn('2025-06-02T23:30:00-04:00', '2025-06-03T06:30:00-04:00')).toBe(8);
    expect(night.summary.total_units).toBe(8);
    expect(night.rollups.by_operator.map((r) => r.operator_id)).toEqual(['ALee']);
  });
});
