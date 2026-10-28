/**
 * Spec section 15 acceptance scenarios 1-13, with the exact numbers from the spec.
 * (14 and 15 are TV scenarios; they are web tests in apps/web/src/pages/tv/scenarios.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { ComputeHourCellsInput, ComputeHourCellsOutput, HourCell, UnitStep } from '@fld/shared';
import { computeHourCells, groupCells } from '../src/cells.js';
import { computeRollups } from '../src/rollups.js';
import {
  buildStandardsLookup,
  computeStandard,
  resolveEffectiveStandard,
} from '../src/standards.js';
import { hourLabel, rollingWindowColumns } from '../src/time.js';
import { buildTvDashboard } from '../src/views.js';
import {
  HOUR,
  MINUTE,
  TZ,
  adjustment,
  at,
  breakInterval,
  engineSettings,
  findCell,
  hourCell,
  ms,
  override,
  standard,
  stdLookup,
  step,
  stepRun,
  workOrder,
} from './helpers.js';

const STD30 = stdLookup([['Z1', 'Weld', 30]]);

function compute(
  steps: UnitStep[],
  o: { from: string | number; to: string | number; now: string | number } & Partial<
    Omit<ComputeHourCellsInput, 'steps' | 'from_utc' | 'to_utc' | 'now'>
  >,
): ComputeHourCellsOutput {
  return computeHourCells({
    steps,
    breaks: o.breaks ?? [],
    standards: o.standards ?? STD30,
    pins: o.pins ?? [],
    settings: o.settings ?? engineSettings(),
    from_utc: at(o.from),
    to_utc: at(o.to),
    now: at(o.now),
  });
}

describe('15.1 partial first hour', () => {
  it('charges 40 minutes, targets 20 and paces 4 units at 0.20 (red)', () => {
    const steps = [
      step('OP1', 'JA', 'Weld', '2025-06-10T15:20-04:00', '2025-06-10T15:30-04:00'),
      step('OP1', 'JA', 'Weld', '2025-06-10T15:30-04:00', '2025-06-10T15:40-04:00'),
      step('OP1', 'JA', 'Weld', '2025-06-10T15:40-04:00', '2025-06-10T15:50-04:00'),
      step('OP1', 'JA', 'Weld', '2025-06-10T15:50-04:00', '2025-06-10T15:59-04:00'),
    ];
    const out = compute(steps, {
      from: '2025-06-10T15:00-04:00',
      to: '2025-06-10T16:00-04:00',
      now: '2025-06-10T16:00-04:00',
    });
    expect(out.cells).toHaveLength(1);
    const cell = out.cells[0]!;
    expect(cell.eligible).toBe(true);
    expect(cell.charged_minutes).toBe(40);
    expect(cell.std_hr).toBe(30);
    expect(cell.target_units).toBe(20);
    expect(cell.units).toBe(4);
    expect(cell.pace).toBeCloseTo(0.2, 10);
    expect(cell.color).toBe('red');
    expect(cell.provisional).toBe(false);
  });

  it('paces the same 40 charged minutes with 18 units at 0.90 (green)', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T15:20-04:00', 2, 18); // 15:20-15:56
    const out = compute(steps, {
      from: '2025-06-10T15:00-04:00',
      to: '2025-06-10T16:00-04:00',
      now: '2025-06-10T16:00-04:00',
    });
    const cell = out.cells[0]!;
    expect(cell.charged_minutes).toBe(40);
    expect(cell.target_units).toBe(20);
    expect(cell.units).toBe(18);
    expect(cell.pace).toBeCloseTo(0.9, 10);
    expect(cell.color).toBe('green');
  });
});

describe('15.2 current hour prorating', () => {
  // The operator worked 08:00-08:50 and carries the assignment into the 09:00 hour.
  const carried = stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 10, 5);

  it('charges 10 minutes at 09:10 with 5 units: target 5, pace 1.00, green', () => {
    const current = stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 2, 5); // 09:00-09:10
    const out = compute([...carried, ...current], {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T09:10-04:00',
    });
    const cell = findCell(out.cells, { hour: '2025-06-10T09:00-04:00' })!;
    expect(cell.eligible).toBe(true);
    expect(cell.provisional).toBe(true);
    expect(cell.charged_minutes).toBe(10);
    expect(cell.target_units).toBe(5);
    expect(cell.units).toBe(5);
    expect(cell.pace).toBe(1);
    expect(cell.color).toBe('green');
  });

  it('is neutral at 09:03 with 0 units because charged 3 < neutral_minutes 5', () => {
    const out = compute(carried, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T09:03-04:00',
    });
    const cell = findCell(out.cells, { hour: '2025-06-10T09:00-04:00' })!;
    expect(cell.eligible).toBe(true); // continuing operator
    expect(cell.charged_minutes).toBe(3);
    expect(cell.units).toBe(0);
    expect(cell.color).toBe('neutral');
  });
});

describe('15.3 visitor rework', () => {
  it('makes Job B a visitor without breaking the Job A window', () => {
    const jobA = stepRun('OP1', 'JA', 'Weld', '2025-06-10T10:00-04:00', 5, 11); // 10:00-10:55
    // 8 rework boards scanned through Job B between 10:40 and 10:42 (start ~ complete).
    const jobB: UnitStep[] = [];
    for (let i = 0; i < 8; i++) {
      const s = ms('2025-06-10T10:40-04:00') + i * 15_000;
      jobB.push(step('OP1', 'JB', 'Weld', s, s + 5_000));
    }
    const out = compute([...jobA, ...jobB], {
      from: '2025-06-10T10:00-04:00',
      to: '2025-06-10T11:00-04:00',
      now: '2025-06-10T11:00-04:00',
    });

    const b = findCell(out.cells, { job: 'JB' })!;
    expect(b.work_minutes).toBeLessThan(10);
    expect(b.eligible).toBe(false);
    expect(b.color).toBe('visitor');
    expect(b.units).toBe(8); // still counted toward the job total
    expect(b.charged_minutes).toBe(0);
    expect(b.pace).toBeNull();

    const a = findCell(out.cells, { job: 'JA' })!;
    expect(a.eligible).toBe(true);
    expect(a.window_minutes).toBe(60); // unbroken through 10:40-10:42
    expect(a.charged_minutes).toBe(60);
  });
});

describe('15.4 split hour', () => {
  it('charges Job A 40 minutes and Job B 20 minutes, each judged on its own window', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 10, 4), // 09:00-09:40
      step('OP1', 'JB', 'Weld', '2025-06-10T09:40-04:00', '2025-06-10T09:50-04:00'),
      step('OP1', 'JB', 'Weld', '2025-06-10T09:50-04:00', '2025-06-10T09:59-04:00'),
    ];
    const out = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
    });
    const a = findCell(out.cells, { job: 'JA' })!;
    const b = findCell(out.cells, { job: 'JB' })!;
    expect(a.eligible).toBe(true);
    expect(b.eligible).toBe(true);
    expect(a.charged_minutes).toBe(40);
    expect(b.charged_minutes).toBe(20);
    expect(a.target_units).toBe(20);
    expect(b.target_units).toBe(10);
    expect(a.units).toBe(4);
    expect(b.units).toBe(2);
  });
});

describe('15.5 break subtraction', () => {
  it('charges 45 minutes through a 14:00-14:15 break: target 22.5, pace 0.98, green', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T13:30-04:00', 7, 4), // 13:30-13:58
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T14:15-04:00', 2, 22), // 14:15-14:59
    ];
    const out = compute(steps, {
      from: '2025-06-10T14:00-04:00',
      to: '2025-06-10T15:00-04:00',
      now: '2025-06-10T15:00-04:00',
      breaks: [breakInterval(1, '2025-06-10T14:00-04:00', '2025-06-10T14:15-04:00')],
    });
    const cell = findCell(out.cells, { hour: '2025-06-10T14:00-04:00' })!;
    expect(cell.window_minutes).toBe(60);
    expect(cell.break_minutes).toBe(15);
    expect(cell.charged_minutes).toBe(45);
    expect(cell.target_units).toBe(22.5);
    expect(cell.units).toBe(22);
    expect(cell.pace).toBeCloseTo(0.9778, 4);
    expect(cell.color).toBe('green');
  });
});

describe('15.6 idle timeout', () => {
  it('ends the window 30 minutes after the last scan and drops the next hour', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T11:00-04:00', 5, 2); // last scan 11:10
    const out = compute(steps, {
      from: '2025-06-10T11:00-04:00',
      to: '2025-06-10T13:00-04:00',
      now: '2025-06-10T12:30-04:00',
    });
    const eleven = findCell(out.cells, { hour: '2025-06-10T11:00-04:00' })!;
    expect(eleven.window_minutes).toBe(40); // 11:00 -> 11:40
    expect(findCell(out.cells, { hour: '2025-06-10T12:00-04:00' })).toBeUndefined();
    expect(out.assignments[0]!.job_number).toBeNull();
  });
});

describe('15.7 batching correction', () => {
  it('turns a 10-in / 10-out batch into 5 minutes per unit (12/hr, not 1.2/hr)', () => {
    const batch = (operator: string): UnitStep[] => {
      const out: UnitStep[] = [];
      for (let i = 0; i < 10; i++) {
        out.push(step(operator, 'JA', 'Weld', '2025-06-10T08:00-04:00', '2025-06-10T08:50-04:00'));
      }
      return out;
    };
    const std = computeStandard({
      product_number: 'Z1',
      operation: 'Weld',
      steps: [...batch('OP1'), ...batch('OP2')],
      breaks: [],
      settings: engineSettings(),
      now: ms('2025-06-10T10:00-04:00'),
      fl_std_hr: null,
      rework_flag_mapped: false,
    });
    expect(std.median_minutes_per_unit).toBe(5);
    expect(std.computed_std_hr).toBe(12);
  });
});

describe('15.8 grouped mode', () => {
  it('targets 45 from 90 charged minutes, paces 1.11 (blue) and counts 53 with the visitor', () => {
    const hour = '2025-06-10T09:00-04:00';
    const cells: HourCell[] = [
      hourCell({ hour, operator: 'OP1', units: 30, charged: 60, std: 30 }),
      hourCell({ hour, operator: 'OP2', units: 20, charged: 30, std: 30 }),
      hourCell({ hour, operator: 'OP3', units: 3, eligible: false }),
    ];
    const [g] = groupCells(cells, engineSettings(), at(hour));
    expect(g!.charged_minutes).toBe(90);
    expect(g!.target_units).toBe(45);
    expect(g!.eligible_units).toBe(50);
    expect(g!.pace).toBeCloseTo(1.1111, 4);
    expect(g!.color).toBe('blue');
    expect(g!.units).toBe(53);
    expect(g!.visitor_units).toBe(3);
  });
});

describe('15.9 rolling window', () => {
  it('rolls the columns at the top of the hour and moves the dropped units into Prior', () => {
    const before = rollingWindowColumns(ms('2025-06-10T21:59-04:00'), TZ);
    const after = rollingWindowColumns(ms('2025-06-10T22:00-04:00'), TZ);
    expect(before.map((c) => c.label)).toEqual([
      '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21',
    ]);
    expect(after.map((c) => c.label)).toEqual([
      '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22',
    ]);

    const cells = before.map((c) =>
      hourCell({ hour: c.hour_start_utc, operator: 'OP1', units: 5, charged: 60, std: 30 }),
    );
    const base = {
      work_order: workOrder({ job_number: 'J1' }),
      route: ['Weld'],
      cells,
      defect_cells: [],
      prior_defects: [],
      grouped: false,
      show_std_day: true,
      shift_length_hours: 12,
      std_hr_by_operation: { Weld: 30 },
      operator_names: { OP1: 'Alice' },
      derived_qty_complete: 0,
      settings: engineSettings(),
    };
    const dash1 = buildTvDashboard({
      ...base,
      columns: before,
      prior: [{ operation: 'Weld', operator_id: 'OP1', units: 100 }],
      now: ms('2025-06-10T21:59-04:00'),
    });
    const dash2 = buildTvDashboard({
      ...base,
      columns: after,
      // the 10:00 hour (5 units) has fallen out of the window and moved into Prior
      prior: [{ operation: 'Weld', operator_id: 'OP1', units: 105 }],
      now: ms('2025-06-10T22:00-04:00'),
    });
    expect(dash1.rows[0]!.shift).toBe(60);
    expect(dash2.rows[0]!.shift).toBe(55);
    expect(dash1.rows[0]!.prior + dash1.rows[0]!.shift).toBe(160);
    expect(dash2.rows[0]!.prior + dash2.rows[0]!.shift).toBe(160);
  });
});

describe('15.10 DST fall-back', () => {
  it('keeps the two 01:00 hours as separate cells with no double counting', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-11-02T05:00:00Z', 5, 11), // 01:00-01:55 EDT
      ...stepRun('OP1', 'JA', 'Weld', '2025-11-02T06:00:00Z', 5, 11), // 01:00-01:55 EST
    ];
    const out = compute(steps, {
      from: '2025-11-02T05:00:00Z',
      to: '2025-11-02T07:00:00Z',
      now: '2025-11-02T07:00:00Z',
    });
    expect(out.cells).toHaveLength(2);
    const [edt, est] = out.cells;
    expect(edt!.hour_start_utc).toBe(ms('2025-11-02T05:00:00Z'));
    expect(est!.hour_start_utc).toBe(ms('2025-11-02T06:00:00Z'));
    expect(est!.hour_start_utc - edt!.hour_start_utc).toBe(HOUR);
    expect(hourLabel(edt!.hour_start_utc, TZ)).toBe('01');
    expect(hourLabel(est!.hour_start_utc, TZ)).toBe('01');
    expect(edt!.units).toBe(11);
    expect(est!.units).toBe(11);
    expect(edt!.units + est!.units).toBe(22); // 22 completions, counted once each
    expect(edt!.charged_minutes).toBe(60);
    expect(est!.charged_minutes).toBe(60);
  });

  it('still produces 12 consecutive UTC hours on both transition nights', () => {
    const fallBack = rollingWindowColumns(ms('2025-11-02T07:30:00Z'), TZ);
    expect(fallBack).toHaveLength(12);
    expect(fallBack.map((c) => c.label).filter((l) => l === '01')).toHaveLength(2);

    const springForward = rollingWindowColumns(ms('2025-03-09T08:30:00Z'), TZ);
    expect(springForward).toHaveLength(12);
    expect(springForward.map((c) => c.label)).not.toContain('02'); // 02:00 never happens
    for (const cols of [fallBack, springForward]) {
      for (let i = 1; i < cols.length; i++) {
        expect(cols[i]!.hour_start_utc - cols[i - 1]!.hour_start_utc).toBe(HOUR);
      }
    }
  });
});

describe('15.11 standards fallback', () => {
  const steps = [
    ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 6),
    ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 6),
  ];
  const input = {
    product_number: 'Z1',
    operation: 'Weld',
    steps,
    breaks: [],
    settings: engineSettings(),
    now: ms('2025-06-10T10:00-04:00'),
    rework_flag_mapped: false,
  };

  it('leaves computed null below std_min_units and uses the FactoryLogix StdHr when mapped', () => {
    const withFl = computeStandard({ ...input, fl_std_hr: 25 });
    expect(withFl.sample_units).toBe(12);
    expect(withFl.computed_std_hr).toBeNull();
    expect(withFl.fallback_source).toBe('fl_std_hr');
    const lookup = buildStandardsLookup([withFl], [], []);
    expect(lookup.get('Z1 Weld')!.effective).toBe(25);
    expect(lookup.get('Z1 Weld')!.provenance).toBe('base_fl');
  });

  it('colors cells neutral when there is no standard at all', () => {
    const none = computeStandard({ ...input, fl_std_hr: null });
    expect(none.fallback_source).toBe('none');
    const lookup = buildStandardsLookup([none], [], []);
    expect(lookup.get('Z1 Weld')!.effective).toBeNull();

    const out = compute(stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 6), {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
      standards: lookup,
    });
    const cell = out.cells[0]!;
    expect(cell.std_hr).toBeNull();
    expect(cell.target_units).toBe(0);
    expect(cell.pace).toBeNull();
    expect(cell.color).toBe('neutral');
  });
});

describe('15.12 override precedence', () => {
  it('goes 30 -> 33 (global +10%) -> 36 (operation +20%) -> 40 (hard override)', () => {
    const base = standard({
      product_number: 'Z1',
      operation: 'Weld',
      computed_std_hr: 30,
      fallback_source: 'computed',
    });
    const global = adjustment({ id: 1, scope: 'global', percent: 10 });
    const opAdj = adjustment({ id: 2, scope: 'operation', percent: 20, operation: 'Weld' });
    const hard = override({ id: 1, scope: 'product', product_number: 'Z1', std_hr: 40 });

    expect(resolveEffectiveStandard(base, [], [], 'Z1', 'Weld').effective).toBe(30);
    expect(resolveEffectiveStandard(base, [global], [], 'Z1', 'Weld').effective).toBe(33);
    expect(resolveEffectiveStandard(base, [global, opAdj], [], 'Z1', 'Weld').effective).toBe(36);
    expect(resolveEffectiveStandard(base, [global, opAdj], [hard], 'Z1', 'Weld').effective).toBe(40);

    const resolved = resolveEffectiveStandard(base, [global, opAdj], [hard], 'Z1', 'Weld');
    expect(resolved.provenance).toBe('override_product');
    expect(resolved.adjustment!.id).toBe(2); // most specific, not stacked
    expect(resolved.adjusted).toBe(36);
    expect(resolved.base).toBe(30);
  });
});

describe('15.13 shift efficiency', () => {
  it('combines 60@30 and 10@12 into 2.833 earned hours over 2 charged hours (1.42, blue)', () => {
    const hour = '2025-06-10T09:00-04:00';
    const cells = [
      hourCell({ hour, operator: 'OP1', op: 'Weld', units: 60, charged: 60, std: 30 }),
      hourCell({ hour, operator: 'OP2', op: 'Test', units: 10, charged: 60, std: 12 }),
    ];
    const r = computeRollups(cells, engineSettings());
    expect(r.overall.earned_hours).toBeCloseTo(2.8333, 4);
    expect(r.overall.charged_hours).toBe(2);
    expect(r.overall.efficiency).toBeCloseTo(1.4167, 4);
    expect(Math.round(r.overall.efficiency! * 100) / 100).toBe(1.42);
    expect(r.overall.color).toBe('blue');
    expect(MINUTE).toBe(60_000);
  });
});
