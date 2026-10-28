import { describe, expect, it } from 'vitest';
import { buildOperatorDetail, buildShiftView } from '../src/index.js';
import { engineSettings, hourCell, ms, workOrder } from './helpers.js';

/**
 * Stored hour cells keep the StdHr that was in force when they were last computed (the collector only
 * recomputes the current and previous hour after a poll, and nothing recomputes older hours when a manager
 * sets an override/adjustment or the nightly standard changes). So one operation can legitimately carry
 * two different StdHr values inside one shift. Each hour here is run exactly at its own standard.
 */
const settings = engineSettings();
const H07 = '2026-06-10T07:00-04:00';
const H08 = '2026-06-10T08:00-04:00';
const H09 = '2026-06-10T09:00-04:00';
const H10 = '2026-06-10T10:00-04:00';

const cells = [
  // 07:00 and 08:00 were run against StdHr 30 (30 units in 60 charged minutes = pace 1.00)
  hourCell({ hour: H07, units: 30, charged: 60, std: 30 }),
  hourCell({ hour: H08, units: 30, charged: 60, std: 30 }),
  // a manager set an override of 40 at 09:30: 09:00 and 10:00 were recomputed against StdHr 40 (40 units = pace 1.00)
  hourCell({ hour: H09, units: 40, charged: 60, std: 40 }),
  hourCell({ hour: H10, units: 40, charged: 60, std: 40 }),
];

describe('a standard that changes mid-shift', () => {
  it('shift view: the operation row targets the sum of its cells, not the first hour StdHr times all minutes', () => {
    const view = buildShiftView({
      shift: {
        shift_id: 1,
        name: 'Day',
        date: '2026-06-10',
        start_utc: ms('2026-06-10T07:00-04:00'),
        end_utc: ms('2026-06-10T19:00-04:00'),
      },
      cells,
      work_orders: [workOrder({ job_number: 'JA' })],
      routes: { Z1: ['Weld'] },
      active_job_numbers: ['JA'],
      operator_names: {},
      derived_qty_complete: {},
      filters: null,
      settings,
      now: ms('2026-06-10T11:00-04:00'),
    });
    const job = view.jobs[0]!;
    const op = job.operations[0]!;

    // The job header (earned hours) correctly reads 100%: every hour ran exactly at its standard.
    expect(job.efficiency).toBeCloseTo(1, 9);
    expect(job.color).toBe('green');

    // The only operation of that job must agree with it: 140 units against 30+30+40+40 = 140 target units.
    expect(op.units).toBe(140);
    expect(op.target_units).toBeCloseTo(140, 9);
    expect(op.pace).toBeCloseTo(1, 9);
    expect(op.color).toBe('green');
  });

  it('operator detail: the per-job row targets the sum of its cells', () => {
    const detail = buildOperatorDetail({
      operator_id: 'OP1',
      operator_name: 'Alice',
      cells,
      columns: [],
      assignment: null,
      pins: [],
      product_names: {},
      settings,
      now: ms('2026-06-10T11:00-04:00'),
      range: { from_utc: ms('2026-06-10T07:00-04:00'), to_utc: ms('2026-06-10T19:00-04:00') },
    });
    const row = detail.rows[0]!;
    expect(row.units).toBe(140);
    expect(row.target_units).toBeCloseTo(140, 9);
    expect(row.pace).toBeCloseTo(1, 9);
    expect(row.color).toBe('green');
  });
});
