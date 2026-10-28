import { describe, expect, it } from 'vitest';
import type { HourCell, OperatorAssignment, ShiftInstance, TvDashboardInput } from '@fld/shared';
import {
  buildFloorView,
  buildJobDetail,
  buildOperatorDetail,
  buildProductView,
  buildShiftView,
  buildTvDashboard,
} from '../src/views.js';
import { computeRollups } from '../src/rollups.js';
import { rollingWindowColumns } from '../src/time.js';
import {
  TZ,
  adjustment,
  engineSettings,
  hourCell,
  ms,
  override,
  pin,
  standard,
  workOrder,
} from './helpers.js';

const settings = engineSettings();

// ---------------------------------------------------------------------------
// TV dashboard
// ---------------------------------------------------------------------------

const NOW = ms('2025-06-10T21:30-04:00');
const COLUMNS = rollingWindowColumns(NOW, TZ);
const H20 = ms('2025-06-10T20:00-04:00');
const H21 = ms('2025-06-10T21:00-04:00');

function tvCells(): HourCell[] {
  return [
    hourCell({ hour: H20, op: 'Weld', operator: 'OP1', units: 25, charged: 60, std: 30 }),
    hourCell({ hour: H21, op: 'Weld', operator: 'OP1', units: 15, charged: 30, std: 30, provisional: true }),
    hourCell({ hour: H21, op: 'Test', operator: 'OP2', units: 10, charged: 60, std: 12, provisional: true }),
    // OP3 is a visitor in every hour of the window: the row must be omitted.
    hourCell({ hour: H20, op: 'Weld', operator: 'OP3', units: 3, eligible: false }),
    hourCell({ hour: H21, op: 'Weld', operator: 'OP3', units: 2, eligible: false, provisional: true }),
    // OP4 is a visitor in one hour and eligible in the next: the row stays.
    hourCell({ hour: H20, op: 'Weld', operator: 'OP4', units: 4, eligible: false }),
    hourCell({ hour: H21, op: 'Weld', operator: 'OP4', units: 20, charged: 60, std: 30, provisional: true }),
  ];
}

function tvInput(o: Partial<TvDashboardInput> = {}): TvDashboardInput {
  return {
    work_order: workOrder({ job_number: 'J1', qty_released: 500, qty_complete: null }),
    route: ['Weld', 'Test'],
    cells: tvCells(),
    prior: [
      { operation: 'Weld', operator_id: 'OP1', units: 30 },
      { operation: 'Weld', operator_id: 'OP4', units: 4 },
      { operation: 'Test', operator_id: 'OP2', units: 5 },
    ],
    defect_cells: [{ hour_start_utc: H21, job_number: 'J1', operation: 'Weld', count: 2 }],
    prior_defects: [{ operation: 'Weld', count: 1 }],
    columns: COLUMNS,
    grouped: false,
    show_std_day: true,
    shift_length_hours: 12,
    std_hr_by_operation: { Weld: 30, Test: 12 },
    operator_names: { OP1: 'Alice', OP2: 'Bob', OP3: 'Carol', OP4: 'Dave' },
    derived_qty_complete: 100,
    settings,
    now: NOW,
    ...o,
  };
}

describe('buildTvDashboard (separate mode)', () => {
  const tv = buildTvDashboard(tvInput());

  it('orders rows by route sequence then operator name and omits all-visitor rows', () => {
    expect(tv.rows.map((r) => `${r.operation}/${r.operator_name}`)).toEqual([
      'Weld/Alice',
      'Weld/Dave',
      'Test/Bob',
    ]);
    expect(tv.rows.map((r) => r.operation_seq)).toEqual([1, 1, 2]);
    expect(tv.rows.every((r) => r.visitor_row === false)).toBe(true);
    expect(tv.rows.find((r) => r.operator_id === 'OP3')).toBeUndefined();
  });

  it('aligns cells to the columns and blanks the rest', () => {
    const alice = tv.rows[0]!;
    expect(alice.cells).toHaveLength(COLUMNS.length);
    alice.cells.forEach((cell, i) => {
      expect(cell.hour_start_utc).toBe(COLUMNS[i]!.hour_start_utc);
    });
    for (let i = 0; i < 10; i++) {
      expect(alice.cells[i]).toEqual({
        hour_start_utc: COLUMNS[i]!.hour_start_utc,
        units: 0,
        color: 'blank',
        pace: null,
        charged_minutes: 0,
        eligible: false,
        visitor: false,
        provisional: false,
      });
    }
    expect(alice.cells[10]!.units).toBe(25);
    expect(alice.cells[10]!.color).toBe('yellow'); // 25 / 30
    expect(alice.cells[11]!.units).toBe(15);
    expect(alice.cells[11]!.color).toBe('green'); // 15 / 15
    expect(alice.cells[11]!.provisional).toBe(true);
  });

  it('renders the visitor hour of a mixed row with the visitor color', () => {
    const dave = tv.rows[1]!;
    expect(dave.cells[10]!.color).toBe('visitor');
    expect(dave.cells[10]!.visitor).toBe(true);
    expect(dave.cells[10]!.units).toBe(4);
    expect(dave.cells[11]!.color).toBe('red'); // 20 / 30
    expect(dave.shift).toBe(24);
  });

  it('carries prior, shift and std_day', () => {
    expect(tv.rows[0]!.prior).toBe(30);
    expect(tv.rows[0]!.shift).toBe(40);
    expect(tv.rows[0]!.std_hr).toBe(30);
    expect(tv.rows[0]!.std_day).toBe(360);
    expect(tv.rows[2]!.std_day).toBe(144);
    expect(tv.show_std_day).toBe(true);
  });

  it('builds the job header and progress', () => {
    expect(tv.job).toEqual({
      job_number: 'J1',
      product_number: 'Z1',
      product_name: 'PCBA, EXAMPLE BOARD',
      qty_released: 500,
      qty_complete: 100, // derived, because the work order has none
      progress: 0.2,
    });
    expect(tv.generated_at).toBe(NOW);
    expect(tv.columns).toBe(COLUMNS);
  });

  it('prefers the work-order qty_complete and clamps progress', () => {
    const tv2 = buildTvDashboard(
      tvInput({ work_order: workOrder({ job_number: 'J1', qty_released: 500, qty_complete: 600 }) }),
    );
    expect(tv2.job.qty_complete).toBe(600);
    expect(tv2.job.progress).toBe(1);
    const tv3 = buildTvDashboard(
      tvInput({ work_order: workOrder({ job_number: 'J1', qty_released: 0, qty_complete: 3 }) }),
    );
    expect(tv3.job.progress).toBe(0);
  });

  it('builds defect rows for every route operation aligned to the columns', () => {
    expect(tv.defect_rows.map((r) => r.operation)).toEqual(['Weld', 'Test']);
    const weld = tv.defect_rows[0]!;
    expect(weld.cells).toHaveLength(COLUMNS.length);
    expect(weld.cells[11]).toBe(2);
    expect(weld.cells[10]).toBe(0);
    expect(weld.shift_qty).toBe(2);
    expect(weld.prior).toBe(1);
    const test = tv.defect_rows[1]!;
    expect(test.shift_qty).toBe(0);
    expect(test.prior).toBe(0);
  });

  it('adds defect rows for non-route operations with a non-zero count', () => {
    const tv2 = buildTvDashboard(
      tvInput({
        defect_cells: [{ hour_start_utc: H21, job_number: 'J1', operation: 'Rework', count: 3 }],
      }),
    );
    const rework = tv2.defect_rows.find((r) => r.operation === 'Rework')!;
    expect(rework.operation_seq).toBe(1000);
    expect(rework.shift_qty).toBe(3);
    expect(tv2.defect_rows.at(-1)!.operation).toBe('Rework');
  });
});

describe('buildTvDashboard (grouped mode)', () => {
  const tv = buildTvDashboard(tvInput({ grouped: true }));

  it('produces one row per operation with visitor units folded into the count', () => {
    expect(tv.rows.map((r) => r.operation)).toEqual(['Weld', 'Test']);
    // grouped rows name a single operator; otherwise operator_id is null and `operators` lists them
    for (const r of tv.rows) {
      expect(r.operators.length).toBeGreaterThan(0);
      if (r.operators.length === 1) expect(r.operator_id).toBe(r.operators[0]);
      else expect(r.operator_id).toBeNull();
    }
    expect(tv.rows[0]!.operators.length).toBeGreaterThan(1);
    const weld = tv.rows[0]!;
    expect(weld.cells[10]!.units).toBe(32); // 25 eligible + 3 + 4 visitor
    expect(weld.cells[11]!.units).toBe(37); // 15 + 20 eligible + 2 visitor
    expect(weld.cells[10]!.charged_minutes).toBe(60);
    expect(weld.cells[11]!.charged_minutes).toBe(90);
    expect(weld.cells[11]!.pace).toBeCloseTo(35 / 45, 6);
    expect(weld.shift).toBe(69);
    expect(weld.prior).toBe(34); // summed over operators
  });
});

// ---------------------------------------------------------------------------
// Shift view
// ---------------------------------------------------------------------------

const SHIFT: ShiftInstance = {
  shift_id: 1,
  name: 'Day',
  date: '2025-06-10',
  start_utc: ms('2025-06-10T07:00-04:00'),
  end_utc: ms('2025-06-10T19:00-04:00'),
};
const SHIFT_NOW = ms('2025-06-10T12:00-04:00');
const SH09 = ms('2025-06-10T09:00-04:00');
const SH10 = ms('2025-06-10T10:00-04:00');

function shiftCells(): HourCell[] {
  return [
    hourCell({ hour: SH09, job: 'JA', op: 'Weld', operator: 'OP1', units: 30, charged: 60, std: 30 }),
    hourCell({ hour: SH09, job: 'JA', op: 'Weld', operator: 'OP2', units: 12, charged: 30, std: 30 }),
    hourCell({ hour: SH10, job: 'JA', op: 'Test', operator: 'OP3', units: 10, charged: 60, std: 12 }),
    hourCell({ hour: SH09, job: 'JA', op: 'Weld', operator: 'OP9', units: 5, eligible: false }),
  ];
}

function shiftInput(filters = {}) {
  return {
    shift: SHIFT,
    cells: shiftCells(),
    work_orders: [
      workOrder({ job_number: 'JA', qty_released: 200, qty_complete: null }),
      workOrder({ job_number: 'JB', qty_released: 100, qty_complete: 10 }),
    ],
    routes: { Z1: ['Weld', 'Test'] },
    active_job_numbers: ['JA', 'JB'],
    operator_names: { OP1: 'Alice', OP2: 'Bob', OP3: 'Carol', OP9: 'Zed' },
    derived_qty_complete: { JA: 50 },
    filters,
    settings,
    now: SHIFT_NOW,
  };
}

describe('buildShiftView', () => {
  const view = buildShiftView(shiftInput());

  it('summarises the shift with earned-hours efficiency', () => {
    expect(view.in_progress).toBe(true);
    expect(view.summary.total_units).toBe(52);
    expect(view.summary.total_charged_hours).toBe(2.5);
    expect(view.summary.total_earned_hours).toBeCloseTo(2.2333333, 6);
    expect(view.summary.efficiency).toBeCloseTo(0.8933333, 6);
    expect(view.summary.color).toBe('yellow');
    expect(view.summary.active_jobs).toBe(2);
    expect(view.summary.eligible_operators).toBe(3);
    expect(view.summary.rows_without_std).toBe(0);
    expect(view.generated_at).toBe(SHIFT_NOW);
  });

  it('marks a past shift as not in progress', () => {
    const past = buildShiftView({ ...shiftInput(), now: ms('2025-06-11T09:00-04:00') });
    expect(past.in_progress).toBe(false);
  });

  it('builds a job section per active job, keeping empty ones', () => {
    expect(view.jobs.map((j) => j.job_number)).toEqual(['JA', 'JB']);
    const ja = view.jobs[0]!;
    expect(ja.qty_complete).toBe(50); // derived
    expect(ja.qty_released).toBe(200);
    expect(ja.progress).toBe(0.25);
    expect(ja.units).toBe(52);
    expect(ja.efficiency).toBeCloseTo(0.8933333, 6);
    const jb = view.jobs[1]!;
    expect(jb.operations).toEqual([]);
    expect(jb.units).toBe(0);
    expect(jb.efficiency).toBeNull();
    expect(jb.qty_complete).toBe(10);
  });

  it('orders operation rows by route and splits visitors out', () => {
    const ops = view.jobs[0]!.operations;
    expect(ops.map((o) => o.operation)).toEqual(['Weld', 'Test']);
    const weld = ops[0]!;
    expect(weld.operation_seq).toBe(1);
    expect(weld.std_hr).toBe(30);
    expect(weld.units).toBe(42);
    expect(weld.visitor_units).toBe(5);
    expect(weld.charged_minutes).toBe(90);
    expect(weld.target_units).toBe(45);
    expect(weld.pace).toBeCloseTo(42 / 45, 6);
    expect(weld.color).toBe('green');
    expect(weld.eligible_operators).toBe(2);
    expect(weld.operators.map((o) => o.operator_name)).toEqual(['Alice', 'Bob', 'Zed']);
    expect(weld.operators[0]).toMatchObject({ units: 30, charged_minutes: 60, target_units: 30, color: 'green', eligible: true, visitor: false });
    expect(weld.operators[1]).toMatchObject({ units: 12, target_units: 15, color: 'yellow' });
    expect(weld.operators[2]).toMatchObject({ units: 5, charged_minutes: 0, pace: null, color: 'visitor', eligible: false, visitor: true });
  });

  it('applies the operation filter to cells', () => {
    const filtered = buildShiftView(shiftInput({ operation: 'Weld' }));
    expect(filtered.summary.total_units).toBe(42);
    expect(filtered.jobs[0]!.operations.map((o) => o.operation)).toEqual(['Weld']);
    expect(filtered.summary.active_jobs).toBe(2);
  });

  it('applies the job filter to sections and cells', () => {
    const filtered = buildShiftView(shiftInput({ job: 'JA' }));
    expect(filtered.summary.active_jobs).toBe(1);
    expect(filtered.jobs[0]!.job_number).toBe('JA');
  });

  it('applies the operator filter', () => {
    const filtered = buildShiftView(shiftInput({ operator: 'OP1' }));
    expect(filtered.summary.total_units).toBe(30);
    expect(filtered.summary.eligible_operators).toBe(1);
  });

  it('exposes the same numbers through rollups', () => {
    expect(view.rollups.by_operation.map((r) => r.key)).toEqual(['Test', 'Weld']);
    expect(view.rollups.by_operator.map((r) => r.key)).toEqual(['OP1', 'OP2', 'OP3', 'OP9']);
    expect(view.rollups.overall.visitor_units).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Floor view
// ---------------------------------------------------------------------------

describe('buildFloorView', () => {
  const now = ms('2025-06-10T10:30-04:00');
  const hour = ms('2025-06-10T10:00-04:00');
  const assignments: OperatorAssignment[] = [
    {
      operator_id: 'OP1',
      job_number: 'JA',
      operation: 'Weld',
      assigned_since: hour,
      last_scan_at: ms('2025-06-10T10:25-04:00'),
    },
    {
      operator_id: 'OP2',
      job_number: 'JA',
      operation: 'Weld',
      assigned_since: hour,
      last_scan_at: ms('2025-06-10T10:00-04:00'),
    },
    {
      operator_id: 'OP3',
      job_number: null,
      operation: null,
      assigned_since: null,
      last_scan_at: null,
    },
  ];
  const view = buildFloorView({
    current_cells: [
      hourCell({ hour, operator: 'OP2', units: 10, charged: 30, std: 30, provisional: true }),
      hourCell({ hour, operator: 'OP1', units: 15, charged: 30, std: 30, provisional: true }),
      hourCell({ hour, operator: 'OP3', units: 2, eligible: false, provisional: true }),
      hourCell({ hour: ms('2025-06-10T09:00-04:00'), operator: 'OP1', units: 30 }),
    ],
    window_cells: [
      hourCell({ hour, operator: 'OP1', units: 15, charged: 30 }),
      hourCell({ hour: ms('2025-06-10T09:00-04:00'), operator: 'OP1', units: 30 }),
      hourCell({ hour, operator: 'OP2', units: 10, charged: 30 }),
    ],
    assignments,
    operator_names: { OP1: 'Alice', OP2: 'Bob', OP3: 'Carol' },
    product_names: { Z1: 'PCBA, EXAMPLE BOARD' },
    settings,
    now,
  });

  it('keeps only current-hour rows, sorted by operator name', () => {
    expect(view.hour_start_utc).toBe(hour);
    expect(view.rows.map((r) => r.operator_name)).toEqual(['Alice', 'Bob', 'Carol']);
    expect(view.rows[0]!.units_hour).toBe(15);
    expect(view.rows[0]!.units_12h).toBe(45);
    expect(view.rows[0]!.product_name).toBe('PCBA, EXAMPLE BOARD');
    expect(view.generated_at).toBe(now);
  });

  it('flags operators idle for longer than floor_idle_flag_minutes', () => {
    expect(view.rows[0]!.minutes_since_scan).toBe(5);
    expect(view.rows[0]!.idle_flag).toBe(false);
    expect(view.rows[1]!.minutes_since_scan).toBe(30);
    expect(view.rows[1]!.idle_flag).toBe(true);
    expect(view.rows[2]!.minutes_since_scan).toBeNull();
    expect(view.rows[2]!.idle_flag).toBe(false);
  });

  it('marks visitor rows so the UI can toggle them', () => {
    expect(view.rows.map((r) => r.visitor)).toEqual([false, false, true]);
    expect(view.rows[2]!.color).toBe('visitor');
  });
});

// ---------------------------------------------------------------------------
// Operator detail
// ---------------------------------------------------------------------------

describe('buildOperatorDetail', () => {
  const detail = buildOperatorDetail({
    operator_id: 'OP1',
    operator_name: 'Alice',
    cells: [
      hourCell({ hour: H20, job: 'JA', op: 'Weld', operator: 'OP1', units: 25, charged: 60, std: 30 }),
      hourCell({ hour: H21, job: 'JA', op: 'Weld', operator: 'OP1', units: 15, charged: 30, std: 30 }),
      hourCell({ hour: ms('2025-06-10T09:00-04:00'), job: 'JA', op: 'Weld', operator: 'OP1', units: 10, charged: 60, std: 30 }),
      hourCell({ hour: H21, job: 'JB', op: 'Test', operator: 'OP1', units: 3, eligible: false }),
      hourCell({ hour: H21, job: 'JA', op: 'Weld', operator: 'OP2', units: 99, charged: 60, std: 30 }),
    ],
    columns: COLUMNS,
    assignment: null,
    pins: [pin({ id: 7, operator_id: 'OP1', job_number: 'JA', mode: 'force_eligible' })],
    product_names: { Z1: 'PCBA, EXAMPLE BOARD' },
    settings,
    now: NOW,
    range: { from_utc: ms('2025-06-10T09:00-04:00'), to_utc: ms('2025-06-10T22:00-04:00') },
  });

  it('builds one strip per job/operation inside the columns', () => {
    expect(detail.strips.map((s) => `${s.job_number}/${s.operation}`)).toEqual(['JA/Weld', 'JB/Test']);
    const strip = detail.strips[0]!;
    expect(strip.cells).toHaveLength(COLUMNS.length);
    expect(strip.cells[0]!.color).toBe('blank');
    expect(strip.cells[10]!.units).toBe(25);
    expect(strip.total_units).toBe(40); // the 09:00 cell is outside the columns
    expect(strip.std_hr).toBe(30);
  });

  it('aggregates the whole range per job/operation', () => {
    const weld = detail.rows[0]!;
    expect(weld.window_minutes).toBe(150);
    expect(weld.charged_minutes).toBe(150);
    expect(weld.units).toBe(50);
    expect(weld.target_units).toBe(75);
    expect(weld.pace).toBeCloseTo(50 / 75, 6);
    expect(weld.color).toBe('red');
    expect(weld.eligible_hours).toBe(3);
    expect(weld.visitor_hours).toBe(0);
    expect(weld.pinned).toBe('force_eligible');
    expect(weld.product_name).toBe('PCBA, EXAMPLE BOARD');

    const test = detail.rows[1]!;
    expect(test.visitor_hours).toBe(1);
    expect(test.eligible_hours).toBe(0);
    expect(test.charged_minutes).toBe(0);
    expect(test.color).toBe('neutral');
    expect(test.pinned).toBeNull();
  });

  it('ignores other operators and echoes the range', () => {
    expect(detail.rows.every((r) => r.units !== 99)).toBe(true);
    expect(detail.range.to_utc).toBe(ms('2025-06-10T22:00-04:00'));
    expect(detail.operator_name).toBe('Alice');
  });
});

// ---------------------------------------------------------------------------
// Rows spanning a standard change
// ---------------------------------------------------------------------------

describe('rows that span a mid-shift standard change', () => {
  // Cells keep the StdHr in force when they were computed: an override moved Weld from 20 to 60 at 10:00.
  // Alice beat the old standard (24 of 20, blue) and fell behind the new one (42 of 60, yellow).
  const hourAt = (hh: string) => ms(`2025-06-10T${hh}:00-04:00`);
  const cells = [
    hourCell({ hour: hourAt('08'), units: 24, charged: 60, std: 20 }),
    hourCell({ hour: hourAt('09'), units: 24, charged: 60, std: 20 }),
    hourCell({ hour: hourAt('10'), units: 42, charged: 60, std: 60 }),
    hourCell({ hour: hourAt('11'), units: 42, charged: 60, std: 60 }),
  ];
  const shiftView = (c: HourCell[]) => buildShiftView({ ...shiftInput(), cells: c, active_job_numbers: ['JA'] });

  it('targets the sum of its hours and judges the row in earned hours, like the job efficiency', () => {
    const view = shiftView(cells);
    const job = view.jobs[0]!;
    const op = job.operations[0]!;
    expect(op.units).toBe(132);
    expect(op.target_units).toBe(160); // 20 + 20 + 60 + 60
    expect(op.pace).toBeCloseTo(0.95, 9); // (1.2 + 1.2 + 0.7 + 0.7) earned hours / 4 charged hours
    expect(op.pace).toBe(job.efficiency);
    expect(op.pace).toBe(view.rollups.by_job_operation[0]!.efficiency);
    expect(op.color).toBe('green');
    expect(job.color).toBe('green');
    expect(op.operators[0]).toMatchObject({ target_units: 160, pace: op.pace, color: 'green' });
  });

  it('shows the StdHr of the latest hour, whatever order the cells come in', () => {
    expect(shiftView(cells).jobs[0]!.operations[0]!.std_hr).toBe(60);
    expect(shiftView([...cells].reverse()).jobs[0]!.operations[0]!.std_hr).toBe(60);
  });

  it('leaves the row unjudged when part of it ran without a standard, like the job efficiency', () => {
    const view = shiftView([
      hourCell({ hour: hourAt('08'), units: 30, charged: 60, std: null }),
      hourCell({ hour: hourAt('09'), units: 30, charged: 60, std: null }),
      hourCell({ hour: hourAt('10'), units: 40, charged: 60, std: 40 }),
      hourCell({ hour: hourAt('11'), units: 40, charged: 60, std: 40 }),
    ]);
    const job = view.jobs[0]!;
    const op = job.operations[0]!;
    expect(job.efficiency).toBeNull();
    expect(op.std_hr).toBe(40);
    expect(op.target_units).toBe(80);
    expect(op.pace).toBeNull();
    expect(op.color).toBe('neutral');
    expect(op.operators[0]!.pace).toBeNull();
  });

  it('applies the same rules to the operator detail rows and strips', () => {
    const now = hourAt('11') + 30 * 60_000;
    const detail = buildOperatorDetail({
      operator_id: 'OP1',
      operator_name: 'Alice',
      cells,
      columns: rollingWindowColumns(now, TZ),
      assignment: null,
      pins: [],
      product_names: {},
      settings,
      now,
      range: { from_utc: SHIFT.start_utc, to_utc: SHIFT.end_utc },
    });
    const row = detail.rows[0]!;
    expect(row.std_hr).toBe(60);
    expect(row.target_units).toBe(160);
    expect(row.pace).toBe(computeRollups(cells, settings).overall.efficiency);
    expect(row.color).toBe('green');
    expect(detail.strips[0]!.std_hr).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Job detail
// ---------------------------------------------------------------------------

describe('buildJobDetail', () => {
  const dash = buildTvDashboard(tvInput());
  const grouped = buildTvDashboard(tvInput({ grouped: true }));
  const emptyShift: ShiftInstance = {
    shift_id: 2,
    name: 'Night',
    date: '2025-06-09',
    start_utc: ms('2025-06-09T19:00-04:00'),
    end_utc: ms('2025-06-10T07:00-04:00'),
  };
  const detail = buildJobDetail({
    dashboard_separate: dash,
    dashboard_grouped: grouped,
    all_cells: [
      hourCell({ hour: SH09, job: 'JA', op: 'Weld', operator: 'OP1', units: 30, charged: 60, std: 30 }),
      hourCell({ hour: SH10, job: 'JA', op: 'Test', operator: 'OP1', units: 10, charged: 60, std: 12 }),
      hourCell({ hour: SH09, job: 'JA', op: 'Weld', operator: 'OP9', units: 5, eligible: false }),
    ],
    shift_instances: [SHIFT, emptyShift],
    operator_names: { OP1: 'Alice', OP9: 'Zed' },
    displays_showing: [{ id: 1, name: 'Line 1 TV' }],
    settings,
    now: SHIFT_NOW,
  });

  it('totals each operator across the job', () => {
    expect(detail.operators.map((o) => o.operator_name)).toEqual(['Alice', 'Zed']);
    expect(detail.operators[0]).toMatchObject({
      units: 40,
      charged_minutes: 120,
      operations: ['Test', 'Weld'],
    });
    expect(detail.operators[1]).toMatchObject({ units: 5, charged_minutes: 0 });
  });

  it('builds shift history and skips shifts with no cells', () => {
    expect(detail.shift_history).toHaveLength(1);
    const row = detail.shift_history[0]!;
    expect(row.shift.shift_id).toBe(1);
    expect(row.units).toBe(40);
    expect(row.charged_hours).toBe(2);
    expect(row.earned_hours).toBeCloseTo(1.8333333, 6);
    expect(row.efficiency).toBeCloseTo(0.9166667, 6);
    expect(row.color).toBe('green');
  });

  it('passes the dashboards and displays through', () => {
    expect(detail.dashboard_separate).toBe(dash);
    expect(detail.dashboard_grouped).toBe(grouped);
    expect(detail.displays_showing).toEqual([{ id: 1, name: 'Line 1 TV' }]);
    expect(detail.generated_at).toBe(SHIFT_NOW);
  });
});

// ---------------------------------------------------------------------------
// Product view
// ---------------------------------------------------------------------------

describe('buildProductView', () => {
  const view = buildProductView({
    product_number: 'Z1',
    product_name: 'PCBA, EXAMPLE BOARD',
    route: ['Weld', 'Test', 'Pack'],
    standards: [
      standard({ product_number: 'Z1', operation: 'Weld', computed_std_hr: 30, fallback_source: 'computed' }),
      standard({ product_number: 'Z1', operation: 'Test', fl_std_hr: 12, fallback_source: 'fl_std_hr' }),
      standard({ product_number: 'Z1', operation: 'Legacy', computed_std_hr: 5, fallback_source: 'computed' }),
      standard({ product_number: 'Z9', operation: 'Weld', computed_std_hr: 99 }),
    ],
    adjustments: [
      adjustment({ id: 1, scope: 'global', percent: 10 }),
      adjustment({ id: 2, scope: 'operation', percent: 50, operation: 'Test' }),
      adjustment({ id: 3, scope: 'product', percent: 99, product_number: 'Z9' }),
    ],
    overrides: [
      override({ id: 1, scope: 'product_operation', product_number: 'Z1', operation: 'Pack', std_hr: 7 }),
      override({ id: 2, scope: 'product', product_number: 'Z9', std_hr: 99 }),
    ],
  });

  it('emits a row per route operation plus orphan standards', () => {
    expect(view.rows.map((r) => r.operation)).toEqual(['Weld', 'Test', 'Pack', 'Legacy']);
    expect(view.rows.map((r) => r.operation_seq)).toEqual([1, 2, 3, 1000]);
    expect(view.rows[2]!.standard).toBeNull();
    expect(view.rows[0]!.standard!.computed_std_hr).toBe(30);
  });

  it('reports provenance for every row', () => {
    const [weld, test, pack, legacy] = view.rows;
    expect(weld!.effective).toMatchObject({
      base: 30,
      base_source: 'computed',
      adjusted: 33,
      effective: 33,
      provenance: 'adjusted',
    });
    expect(weld!.effective.adjustment!.id).toBe(1);

    expect(test!.effective).toMatchObject({
      base: 12,
      base_source: 'fl_std_hr',
      adjusted: 18,
      effective: 18,
      provenance: 'adjusted',
    });
    expect(test!.effective.adjustment!.id).toBe(2); // operation beats global

    expect(pack!.effective).toMatchObject({
      base: null,
      base_source: 'none',
      adjusted: null,
      effective: 7,
      provenance: 'override_product_operation',
    });

    expect(legacy!.effective).toMatchObject({ base: 5, effective: 5.5, provenance: 'adjusted' });
  });

  it('returns only the adjustments and overrides in scope', () => {
    expect(view.adjustments.map((a) => a.id)).toEqual([1, 2]);
    expect(view.overrides.map((o) => o.id)).toEqual([1]);
    expect(view.product_name).toBe('PCBA, EXAMPLE BOARD');
  });
});
