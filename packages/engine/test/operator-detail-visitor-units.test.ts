import { describe, expect, it } from 'vitest';
import type { ShiftInstance } from '@fld/shared';
import { computeHourCells } from '../src/cells.js';
import { hourColumns } from '../src/time.js';
import { buildOperatorDetail, buildShiftView } from '../src/views.js';
import { TZ, engineSettings, ms, stdLookup, stepRun, workOrder } from './helpers.js';

const settings = engineSettings();

// One operator, one shift. OP1 works JA/Weld (StdHr 30) at exactly standard for two hours, moves
// to JB/Test (StdHr 12), then pops back to JA/Weld at 12:00 to clear 6 rework boards in 3 minutes
// (a visitor in that hour, spec 7.3) and returns to JB/Test.
const SHIFT: ShiftInstance = {
  shift_id: 1,
  name: 'Day',
  date: '2025-06-10',
  start_utc: ms('2025-06-10T07:00-04:00'),
  end_utc: ms('2025-06-10T19:00-04:00'),
};
const NOW = ms('2025-06-10T13:30-04:00');

const steps = [
  ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 2, 59),
  ...stepRun('OP1', 'JB', 'Test', '2025-06-10T10:00-04:00', 5, 24),
  ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T12:00-04:00', 0.5, 6),
  ...stepRun('OP1', 'JB', 'Test', '2025-06-10T12:03-04:00', 5, 11),
];

const { cells } = computeHourCells({
  steps,
  breaks: [],
  standards: stdLookup([
    ['Z1', 'Weld', 30],
    ['Z1', 'Test', 12],
  ]),
  pins: [],
  settings,
  from_utc: SHIFT.start_utc,
  to_utc: NOW,
  now: NOW,
});

const shiftView = buildShiftView({
  shift: SHIFT,
  cells,
  work_orders: [workOrder({ job_number: 'JA' }), workOrder({ job_number: 'JB' })],
  routes: { Z1: ['Weld', 'Test'] },
  active_job_numbers: ['JA', 'JB'],
  operator_names: { OP1: 'Alice' },
  derived_qty_complete: {},
  filters: {},
  settings,
  now: NOW,
});

const operatorDetail = buildOperatorDetail({
  operator_id: 'OP1',
  operator_name: 'Alice',
  cells,
  columns: hourColumns(SHIFT.end_utc - 12 * 3_600_000, SHIFT.end_utc, TZ),
  assignment: null,
  pins: [],
  product_names: {},
  settings,
  now: NOW,
  range: { from_utc: SHIFT.start_utc, to_utc: SHIFT.end_utc },
});

describe('operator page vs shift view for the same operator, job, operation and shift', () => {
  const weldSection = shiftView.jobs.find((j) => j.job_number === 'JA')!.operations.find((o) => o.operation === 'Weld')!;
  const shiftRow = weldSection.operators.find((o) => o.operator_id === 'OP1')!;
  const operatorRow = operatorDetail.rows.find((r) => r.job_number === 'JA' && r.operation === 'Weld')!;

  it('the 12:00 rework scan-through is a visitor hour (precondition)', () => {
    const rework = cells.find((c) => c.job_number === 'JA' && c.hour_start_utc === ms('2025-06-10T12:00-04:00'))!;
    expect(rework.eligible).toBe(false);
    expect(rework.units).toBe(6);
    expect(weldSection.visitor_units).toBe(6);
    // the shift view judges OP1 on the 59 eligible units against 120 charged minutes (target 60)
    expect(shiftRow.units).toBe(59);
    expect(shiftRow.charged_minutes).toBe(120);
    expect(shiftRow.pace).toBeCloseTo(59 / 60, 6);
    expect(shiftRow.color).toBe('green');
  });

  it('shows the same pace and colour on the operator page (visitor units are not in the pace numerator, spec 7.3)', () => {
    expect(operatorRow.charged_minutes).toBe(shiftRow.charged_minutes);
    expect(operatorRow.target_units).toBeCloseTo(shiftRow.target_units, 6);
    expect(operatorRow.pace).toBeCloseTo(shiftRow.pace!, 6);
    expect(operatorRow.color).toBe(shiftRow.color);
  });

  it('gives the same shift-wide figure on the operator page KPI as the target it is judged against', () => {
    // OperatorPage.tsx: pace KPI = sum(rows.units) / sum(rows.target_units)
    const units = operatorDetail.rows.reduce((s, r) => s + r.units, 0);
    const target = operatorDetail.rows.reduce((s, r) => s + r.target_units, 0);
    const eligibleUnits = shiftView.rollups.by_operator.find((r) => r.operator_id === 'OP1')!.units;
    expect(units / target).toBeCloseTo(eligibleUnits / target, 6);
  });
});
