import { describe, expect, it } from 'vitest';
import type { ComputeHourCellsInput, ComputeHourCellsOutput, UnitStep } from '@fld/shared';
import {
  colorForPace,
  computeDefectHourCells,
  computeHourCells,
  groupCells,
} from '../src/cells.js';
import {
  HOUR,
  MINUTE,
  TZ,
  at,
  breakInterval,
  defect,
  engineSettings,
  findCell,
  hourCell,
  ms,
  pin,
  step,
  stepRun,
  stdLookup,
} from './helpers.js';

const STD30 = stdLookup([['Z1', 'Weld', 30]]);

function compute(
  steps: UnitStep[],
  o: {
    from: string | number;
    to: string | number;
    now: string | number;
  } & Partial<Omit<ComputeHourCellsInput, 'steps' | 'from_utc' | 'to_utc' | 'now'>>,
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

describe('colorForPace', () => {
  const s = engineSettings();
  it('uses the 0.70 / 0.90 / 1.05 bands', () => {
    expect(colorForPace(null, s)).toBe('neutral');
    expect(colorForPace(0, s)).toBe('red');
    expect(colorForPace(0.699, s)).toBe('red');
    expect(colorForPace(0.7, s)).toBe('yellow');
    expect(colorForPace(0.899, s)).toBe('yellow');
    expect(colorForPace(0.9, s)).toBe('green');
    expect(colorForPace(1.05, s)).toBe('green');
    expect(colorForPace(1.0501, s)).toBe('blue');
  });

  it('honours custom bands', () => {
    const custom = engineSettings({ color_red_below: 0.5, color_yellow_below: 0.8, color_blue_above: 1.2 });
    expect(colorForPace(0.6, custom)).toBe('yellow');
    expect(colorForPace(1.2, custom)).toBe('green');
    expect(colorForPace(1.21, custom)).toBe('blue');
  });
});

describe('eligibility', () => {
  it('needs eligibility_minutes of work in a completed hour', () => {
    const eligible = compute(stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 3), {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
    });
    expect(findCell(eligible.cells, { operator: 'OP1' })!.eligible).toBe(true);

    // 9 minutes of work: below the 10-minute threshold.
    const visitor = compute(stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 3, 3), {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
    });
    const cell = findCell(visitor.cells, { operator: 'OP1' })!;
    expect(cell.work_minutes).toBe(9);
    expect(cell.eligible).toBe(false);
    expect(cell.color).toBe('visitor');
    expect(cell.window_minutes).toBe(0);
    expect(cell.charged_minutes).toBe(0);
    expect(cell.units).toBe(3);
  });

  it('scales the threshold in the current hour', () => {
    // At 09:12 the threshold is 10 * 12/60 = 2 minutes; 4 minutes of work clears it.
    const out = compute(stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 2, 2), {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T09:12-04:00',
    });
    const cell = findCell(out.cells, { operator: 'OP1' })!;
    expect(cell.eligible).toBe(true);
    expect(cell.provisional).toBe(true);
  });

  it('uses a floor of one minute for the current-hour threshold', () => {
    // At 09:02 the scaled threshold would be 0.33; the floor of 1 minute applies.
    const out = compute(
      [step('OP1', 'JA', 'Weld', '2025-06-10T09:00:00-04:00', '2025-06-10T09:00:30-04:00')],
      {
        from: '2025-06-10T09:00-04:00',
        to: '2025-06-10T10:00-04:00',
        now: '2025-06-10T09:02-04:00',
      },
    );
    expect(findCell(out.cells, { operator: 'OP1' })!.eligible).toBe(false);
  });

  it('keeps a continuing operator eligible in the current hour', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 10, 5), // 08:00-08:50
    ];
    const out = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T09:03-04:00',
    });
    const cell = findCell(out.cells, { hour: '2025-06-10T09:00-04:00' })!;
    expect(cell.eligible).toBe(true);
    expect(cell.units).toBe(0);
    expect(cell.charged_minutes).toBe(3);
    expect(cell.color).toBe('neutral'); // charged < neutral_minutes while provisional
  });

  it('lets an active pin force eligibility either way', () => {
    const visitorSteps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 1, 3);
    const forced = compute(visitorSteps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
      pins: [pin({ operator_id: 'OP1', job_number: 'JA', mode: 'force_eligible' })],
    });
    expect(findCell(forced.cells, { operator: 'OP1' })!.eligible).toBe(true);

    const workingSteps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 10, 5);
    const suppressed = compute(workingSteps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
      pins: [pin({ operator_id: 'OP1', job_number: 'JA', mode: 'force_visitor', operation: 'Weld' })],
    });
    const cell = findCell(suppressed.cells, { operator: 'OP1' })!;
    expect(cell.eligible).toBe(false);
    expect(cell.color).toBe('visitor');
    expect(cell.charged_minutes).toBe(0);
  });

  it('ignores expired pins and pins for another operation', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 1, 3);
    const expired = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
      pins: [
        pin({
          operator_id: 'OP1',
          job_number: 'JA',
          mode: 'force_eligible',
          expires_at: ms('2025-06-10T09:30-04:00'),
        }),
      ],
    });
    expect(findCell(expired.cells, { operator: 'OP1' })!.eligible).toBe(false);

    const otherOp = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
      pins: [
        pin({ operator_id: 'OP1', job_number: 'JA', mode: 'force_eligible', operation: 'Test' }),
      ],
    });
    expect(findCell(otherOp.cells, { operator: 'OP1' })!.eligible).toBe(false);
  });
});

describe('ownership windows', () => {
  it('anchors at the first start and sums multiple segments in an hour', () => {
    const steps = [
      step('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', '2025-06-10T09:10-04:00'),
      step('OP1', 'JB', 'Weld', '2025-06-10T09:10-04:00', '2025-06-10T09:20-04:00'),
      step('OP1', 'JA', 'Weld', '2025-06-10T09:20-04:00', '2025-06-10T09:30-04:00'),
      step('OP1', 'JA', 'Weld', '2025-06-10T09:30-04:00', '2025-06-10T09:40-04:00'),
    ];
    const out = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
    });
    const ja = findCell(out.cells, { job: 'JA' })!;
    const jb = findCell(out.cells, { job: 'JB' })!;
    expect(ja.window_minutes).toBe(50); // 09:00-09:10 plus 09:20-10:00
    expect(ja.units).toBe(3);
    expect(jb.window_minutes).toBe(10);
    expect(jb.units).toBe(1);
  });

  it('does not let visitor scans break an ownership window', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T10:00-04:00', 5, 11), // 10:00-10:55
      // 8 rework scan-throughs on JB, 5 seconds each
      ...stepRun('OP1', 'JB', 'Weld', '2025-06-10T10:40-04:00', 5 / 60, 8, { gapMinutes: 10 / 60 }),
    ];
    const out = compute(steps, {
      from: '2025-06-10T10:00-04:00',
      to: '2025-06-10T11:00-04:00',
      now: '2025-06-10T11:00-04:00',
    });
    const ja = findCell(out.cells, { job: 'JA' })!;
    const jb = findCell(out.cells, { job: 'JB' })!;
    expect(ja.eligible).toBe(true);
    expect(ja.window_minutes).toBe(60);
    expect(jb.eligible).toBe(false);
    expect(jb.units).toBe(8);
    expect(jb.window_minutes).toBe(0);
    expect(out.assignments[0]!.job_number).toBe('JA');
  });

  it('closes the window at the idle deadline, skipping break time', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T11:00-04:00', 5, 2); // last scan 11:10
    const noBreaks = compute(steps, {
      from: '2025-06-10T11:00-04:00',
      to: '2025-06-10T13:00-04:00',
      now: '2025-06-10T12:30-04:00',
    });
    expect(findCell(noBreaks.cells, { hour: '2025-06-10T11:00-04:00' })!.window_minutes).toBe(40);
    expect(findCell(noBreaks.cells, { hour: '2025-06-10T12:00-04:00' })).toBeUndefined();
    expect(noBreaks.assignments[0]).toEqual({
      operator_id: 'OP1',
      job_number: null,
      operation: null,
      assigned_since: null,
      last_scan_at: ms('2025-06-10T11:10-04:00'),
    });

    // A 15-minute break inside the idle countdown pushes the deadline to 11:55.
    const withBreak = compute(steps, {
      from: '2025-06-10T11:00-04:00',
      to: '2025-06-10T13:00-04:00',
      now: '2025-06-10T12:30-04:00',
      breaks: [breakInterval(1, '2025-06-10T11:20-04:00', '2025-06-10T11:35-04:00')],
    });
    const cell = findCell(withBreak.cells, { hour: '2025-06-10T11:00-04:00' })!;
    expect(cell.window_minutes).toBe(55);
    expect(cell.break_minutes).toBe(15);
    expect(cell.charged_minutes).toBe(40);
  });

  it('keeps the assignment when the idle deadline is still in the future', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T11:00-04:00', 5, 2);
    const out = compute(steps, {
      from: '2025-06-10T11:00-04:00',
      to: '2025-06-10T12:00-04:00',
      now: '2025-06-10T11:20-04:00',
    });
    expect(out.assignments[0]).toEqual({
      operator_id: 'OP1',
      job_number: 'JA',
      operation: 'Weld',
      assigned_since: ms('2025-06-10T11:00-04:00'),
      last_scan_at: ms('2025-06-10T11:10-04:00'),
    });
  });

  it('re-opens a window when the operator returns after an idle gap', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 2), // 09:00-09:10
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T10:20-04:00', 5, 5), // returns at 10:20
    ];
    const out = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T11:00-04:00',
      now: '2025-06-10T11:00-04:00',
    });
    expect(findCell(out.cells, { hour: '2025-06-10T09:00-04:00' })!.window_minutes).toBe(40);
    expect(findCell(out.cells, { hour: '2025-06-10T10:00-04:00' })!.window_minutes).toBe(40);
  });
});

describe('breaks and charged minutes', () => {
  it('subtracts break overlap from the window', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T14:00-04:00', 5, 11); // 14:00-14:55
    const out = compute(steps, {
      from: '2025-06-10T14:00-04:00',
      to: '2025-06-10T15:00-04:00',
      now: '2025-06-10T15:00-04:00',
      breaks: [breakInterval(1, '2025-06-10T14:30-04:00', '2025-06-10T14:45-04:00')],
    });
    const cell = findCell(out.cells, {})!;
    expect(cell.window_minutes).toBe(60);
    expect(cell.break_minutes).toBe(15);
    expect(cell.charged_minutes).toBe(45);
  });

  it('keeps break minutes when count_work_during_breaks is on and a unit completed in the break', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T14:00-04:00', 5, 11);
    const breaks = [breakInterval(1, '2025-06-10T14:30-04:00', '2025-06-10T14:45-04:00')];
    const counted = compute(steps, {
      from: '2025-06-10T14:00-04:00',
      to: '2025-06-10T15:00-04:00',
      now: '2025-06-10T15:00-04:00',
      breaks,
      settings: engineSettings({ count_work_during_breaks: true }),
    });
    const cell = findCell(counted.cells, {})!;
    expect(cell.break_minutes).toBe(0);
    expect(cell.charged_minutes).toBe(60);
  });

  it('still subtracts a break with no completions when count_work_during_breaks is on', () => {
    // Units stop at 14:25 and resume at 14:45: nothing completes inside the break.
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T14:00-04:00', 5, 5), // 14:00-14:25
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T14:45-04:00', 5, 3), // 14:45-15:00
    ];
    const out = compute(steps, {
      from: '2025-06-10T14:00-04:00',
      to: '2025-06-10T15:00-04:00',
      now: '2025-06-10T15:00-04:00',
      breaks: [breakInterval(1, '2025-06-10T14:30-04:00', '2025-06-10T14:45-04:00')],
      settings: engineSettings({ count_work_during_breaks: true }),
    });
    const cell = findCell(out.cells, { hour: '2025-06-10T14:00-04:00' })!;
    expect(cell.break_minutes).toBe(15);
    expect(cell.charged_minutes).toBe(45);
  });
});

describe('target, pace and color', () => {
  it('computes target and pace from charged minutes', () => {
    const out = compute(stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 12), {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
    });
    const cell = findCell(out.cells, {})!;
    expect(cell.charged_minutes).toBe(60);
    expect(cell.target_units).toBe(30);
    // The 12th unit completes at 10:00 exactly, so it lands in the next hour bucket.
    expect(cell.units).toBe(11);
    expect(cell.pace).toBeCloseTo(11 / 30, 10);
    expect(cell.color).toBe('red');
  });

  it('is neutral when no standard is available', () => {
    const out = compute(stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 12), {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T10:00-04:00',
      standards: stdLookup([['Z1', 'Weld', null]]),
    });
    const cell = findCell(out.cells, {})!;
    expect(cell.std_hr).toBeNull();
    expect(cell.target_units).toBe(0);
    expect(cell.pace).toBeNull();
    expect(cell.color).toBe('neutral');
  });

  it('marks only the current hour provisional and only emits hours inside [from,to)', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 12),
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 12),
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T10:00-04:00', 5, 6),
    ];
    const out = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T11:00-04:00',
      now: '2025-06-10T10:30-04:00',
    });
    expect(out.cells.map((c) => c.hour_start_utc)).toEqual([
      ms('2025-06-10T09:00-04:00'),
      ms('2025-06-10T10:00-04:00'),
    ]);
    expect(out.cells[0]!.provisional).toBe(false);
    expect(out.cells[1]!.provisional).toBe(true);
  });

  it('reports one assignment per operator seen', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 6),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 6),
    ];
    const out = compute(steps, {
      from: '2025-06-10T09:00-04:00',
      to: '2025-06-10T10:00-04:00',
      now: '2025-06-10T09:40-04:00',
    });
    expect(out.assignments.map((a) => a.operator_id)).toEqual(['OP1', 'OP2']);
    expect(out.assignments.every((a) => a.job_number === 'JA')).toBe(true);
  });
});

describe('groupCells', () => {
  const settings = engineSettings();
  const hour = '2025-06-10T09:00-04:00';

  it('sums units across operators and paces on eligible work only', () => {
    const cells = [
      hourCell({ hour, operator: 'OP1', units: 30, charged: 60 }),
      hourCell({ hour, operator: 'OP2', units: 20, charged: 30 }),
      hourCell({ hour, operator: 'OP3', units: 3, eligible: false }),
    ];
    const [g] = groupCells(cells, settings, at(hour));
    expect(g!.units).toBe(53);
    expect(g!.eligible_units).toBe(50);
    expect(g!.visitor_units).toBe(3);
    expect(g!.charged_minutes).toBe(90);
    expect(g!.target_units).toBe(45);
    expect(g!.pace).toBeCloseTo(1.1111, 4);
    expect(g!.color).toBe('blue');
    expect(g!.eligible_operators).toEqual(['OP1', 'OP2']);
    expect(g!.visitor_operators).toEqual(['OP3']);
  });

  it('is a visitor cell when no operator is eligible', () => {
    const [g] = groupCells(
      [hourCell({ hour, operator: 'OP3', units: 4, eligible: false })],
      settings,
      at(hour),
    );
    expect(g!.color).toBe('visitor');
    expect(g!.pace).toBeNull();
    expect(g!.charged_minutes).toBe(0);
  });

  it('is neutral while provisional with too little charged time', () => {
    const [g] = groupCells(
      [hourCell({ hour, units: 1, charged: 3, provisional: true })],
      settings,
      at(hour),
    );
    expect(g!.provisional).toBe(true);
    expect(g!.color).toBe('neutral');
  });

  it('separates jobs, operations and hours', () => {
    const cells = [
      hourCell({ hour, job: 'JA', op: 'Weld', units: 1 }),
      hourCell({ hour, job: 'JB', op: 'Weld', units: 2 }),
      hourCell({ hour, job: 'JA', op: 'Test', units: 3 }),
      hourCell({ hour: at(hour) + HOUR, job: 'JA', op: 'Weld', units: 4 }),
    ];
    expect(groupCells(cells, settings, at(hour))).toHaveLength(4);
  });
});

describe('computeDefectHourCells', () => {
  it('counts defects per (hour, job, operation) inside the range', () => {
    const defects = [
      defect({ unit_id: 'U1', job_number: 'JA', operation: 'Weld', found_ts: '2025-06-10T09:05-04:00' }),
      defect({ unit_id: 'U2', job_number: 'JA', operation: 'Weld', found_ts: '2025-06-10T09:55-04:00' }),
      defect({ unit_id: 'U3', job_number: 'JA', operation: 'Test', found_ts: '2025-06-10T09:30-04:00' }),
      defect({ unit_id: 'U4', job_number: 'JA', operation: 'Weld', found_ts: '2025-06-10T10:30-04:00' }),
      defect({ unit_id: 'U5', job_number: 'JA', operation: 'Weld', found_ts: '2025-06-10T08:30-04:00' }),
    ];
    const out = computeDefectHourCells(
      defects,
      ms('2025-06-10T09:00-04:00'),
      ms('2025-06-10T11:00-04:00'),
      TZ,
    );
    expect(out).toEqual([
      { hour_start_utc: ms('2025-06-10T09:00-04:00'), job_number: 'JA', operation: 'Test', count: 1 },
      { hour_start_utc: ms('2025-06-10T09:00-04:00'), job_number: 'JA', operation: 'Weld', count: 2 },
      { hour_start_utc: ms('2025-06-10T10:00-04:00'), job_number: 'JA', operation: 'Weld', count: 1 },
    ]);
  });
});

describe('performance', () => {
  it('processes a large batch of steps quickly (guards against O(n^2))', () => {
    const settings = engineSettings();
    const start = ms('2025-06-01T04:00:00Z');
    const steps: UnitStep[] = [];
    const operators = 40;
    const perOperator = 2500; // 100k steps across ~83 hours
    for (let o = 0; o < operators; o++) {
      for (let i = 0; i < perOperator; i++) {
        const s = start + i * 2 * MINUTE;
        steps.push(step(`OP${o}`, 'JA', 'Weld', s, s + 2 * MINUTE));
      }
    }
    const now = start + perOperator * 2 * MINUTE;
    const out = computeHourCells({
      steps,
      breaks: [breakInterval(1, start + 3 * HOUR, start + 3 * HOUR + 15 * MINUTE)],
      standards: STD30,
      pins: [],
      settings,
      from_utc: start,
      to_utc: now,
      now,
    });
    expect(steps).toHaveLength(operators * perOperator);
    // One cell per operator per hour.
    expect(out.cells.length).toBe(operators * Math.ceil((perOperator * 2) / 60));
    expect(out.assignments).toHaveLength(operators);
  });

  it('does not walk the million hours since a zero-date start (1900) outside the window', () => {
    const window = { from: '2025-06-10T09:00-04:00', to: '2025-06-10T11:00-04:00', now: '2025-06-10T10:30-04:00' };
    const run = stepRun('OP1', 'JA', 'Weld', '2025-06-10T09:00-04:00', 5, 12);
    const started = performance.now();
    const zeroDate = compute([step('OP1', 'JA', 'Weld', '1900-01-01T00:00:00Z', '2025-06-10T10:10-04:00'), ...run], window);
    expect(performance.now() - started).toBeLessThan(1_000); // vitest cannot time out a synchronous test
    // The same unit started two days earlier gives the window the same cells.
    const twoDays = compute([step('OP1', 'JA', 'Weld', '2025-06-08T09:00-04:00', '2025-06-10T10:10-04:00'), ...run], window);
    expect(zeroDate.cells).toHaveLength(2);
    expect(zeroDate).toEqual(twoDays);
  });
});
