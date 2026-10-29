import { describe, expect, it } from 'vitest';
import { buildShiftView, computeRollups } from '../src/index.js';
import { engineSettings, hourCell, ms, workOrder } from './helpers.js';

/**
 * SPEC 7.11: "Rows with a null StdHr are excluded from efficiency and flagged in the UI."
 * docs/CALCULATIONS.md section 10: "Rows with no StdHr are left out of the efficiency number and flagged
 * in the UI rather than silently treated as zero."
 * The shift page hint reads "Excluded from efficiency" when rows_without_std > 0.
 * The engine instead returns a null efficiency (blank headline, neutral colour) for the whole group as soon
 * as ONE row has no standard.
 */
const settings = engineSettings();
const HOUR_A = '2026-06-10T09:00-04:00';

const cells = [
  // Weld has a standard and ran exactly at it: 30 units / StdHr 30 = 1.0 earned hour in 1.0 charged hour
  hourCell({ hour: HOUR_A, operator: 'OP1', op: 'Weld', units: 30, charged: 60, std: 30 }),
  // a new operation with no standard yet (fewer than std_min_units samples, no FactoryLogix fallback)
  hourCell({ hour: HOUR_A, operator: 'OP2', op: 'Pack', units: 12, charged: 60, std: null }),
];

describe('rows without a standard', () => {
  it('are left out of the efficiency number, not used to blank it', () => {
    const r = computeRollups(cells, settings);
    expect(r.overall.rows_without_std).toBe(1); // flagged
    expect(r.overall.efficiency).not.toBeNull();
    expect(r.overall.efficiency).toBeCloseTo(1, 9);
    expect(r.overall.color).toBe('green');
  });

  it('do not blank the shift header or the job efficiency', () => {
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
      routes: { Z1: ['Weld', 'Pack'] },
      active_job_numbers: ['JA'],
      operator_names: {},
      derived_qty_complete: {},
      filters: null,
      settings,
      now: ms('2026-06-10T11:00-04:00'),
    });
    expect(view.summary.rows_without_std).toBe(1);
    expect(view.summary.efficiency).not.toBeNull();
    expect(view.summary.efficiency).toBeCloseTo(1, 9);
    expect(view.summary.color).toBe('green');
    expect(view.jobs[0]!.efficiency).toBeCloseTo(1, 9);
  });
});
