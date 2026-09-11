import { describe, expect, it } from 'vitest';
import { colorForEfficiency, computeRollups } from '../src/rollups.js';
import { engineSettings, hourCell, ms } from './helpers.js';

const settings = engineSettings();
const HOUR_A = '2025-06-10T09:00-04:00';
const HOUR_B = '2025-06-10T10:00-04:00';

describe('colorForEfficiency', () => {
  it('uses the pace bands and treats null as neutral', () => {
    expect(colorForEfficiency(null, settings)).toBe('neutral');
    expect(colorForEfficiency(0.5, settings)).toBe('red');
    expect(colorForEfficiency(0.8, settings)).toBe('yellow');
    expect(colorForEfficiency(1, settings)).toBe('green');
    expect(colorForEfficiency(1.42, settings)).toBe('blue');
  });
});

describe('computeRollups', () => {
  it('combines rows with different standards through earned hours (spec 15.13)', () => {
    const cells = [
      hourCell({ hour: HOUR_A, operator: 'OP1', op: 'Weld', units: 60, charged: 60, std: 30 }),
      hourCell({ hour: HOUR_A, operator: 'OP2', op: 'Test', units: 10, charged: 60, std: 12 }),
    ];
    const r = computeRollups(cells, settings);
    expect(r.overall.units).toBe(70);
    expect(r.overall.charged_hours).toBe(2);
    expect(r.overall.earned_hours).toBeCloseTo(2.8333333, 6);
    expect(r.overall.efficiency).toBeCloseTo(1.4166667, 6);
    expect(r.overall.color).toBe('blue');
    expect(r.overall.rows_without_std).toBe(0);
    expect(r.overall.eligible_operators).toBe(2);
  });

  it('counts visitor units separately and excludes them from charged/earned', () => {
    const cells = [
      hourCell({ hour: HOUR_A, operator: 'OP1', units: 30, charged: 60, std: 30 }),
      hourCell({ hour: HOUR_A, operator: 'OP9', units: 7, eligible: false }),
    ];
    const r = computeRollups(cells, settings);
    expect(r.overall.units).toBe(30);
    expect(r.overall.visitor_units).toBe(7);
    expect(r.overall.charged_hours).toBe(1);
    expect(r.overall.earned_hours).toBe(1);
    expect(r.overall.efficiency).toBe(1);
    expect(r.overall.eligible_operators).toBe(1);
    expect(r.by_operator.map((x) => x.key)).toEqual(['OP1', 'OP9']);
    expect(r.by_operator[1]!.units).toBe(0);
    expect(r.by_operator[1]!.visitor_units).toBe(7);
    expect(r.by_operator[1]!.efficiency).toBeNull();
  });

  it('flags rows without a standard and suppresses efficiency', () => {
    const cells = [
      hourCell({ hour: HOUR_A, operator: 'OP1', units: 30, charged: 60, std: 30 }),
      hourCell({ hour: HOUR_A, operator: 'OP2', op: 'Test', units: 5, charged: 60, std: null }),
    ];
    const r = computeRollups(cells, settings);
    expect(r.overall.rows_without_std).toBe(1);
    expect(r.overall.efficiency).toBeNull();
    expect(r.overall.color).toBe('neutral');
    // the Weld operation on its own still has an efficiency
    const weld = r.by_operation.find((x) => x.key === 'Weld')!;
    expect(weld.efficiency).toBe(1);
    expect(weld.rows_without_std).toBe(0);
  });

  it('groups by job, operation, operator and job+operation, sorted by key', () => {
    const cells = [
      hourCell({ hour: HOUR_A, job: 'JB', op: 'Weld', operator: 'OP2', units: 15, charged: 60 }),
      hourCell({ hour: HOUR_A, job: 'JA', op: 'Weld', operator: 'OP1', units: 30, charged: 60 }),
      hourCell({ hour: HOUR_B, job: 'JA', op: 'Test', operator: 'OP1', units: 30, charged: 60 }),
    ];
    const r = computeRollups(cells, settings, { operator_names: { OP1: 'Alice', OP2: null } });

    expect(r.by_job.map((x) => x.key)).toEqual(['JA', 'JB']);
    expect(r.by_job[0]!.units).toBe(60);
    expect(r.by_job[0]!.job_number).toBe('JA');
    expect(r.by_job[0]!.product_number).toBe('Z1');

    expect(r.by_operation.map((x) => x.key)).toEqual(['Test', 'Weld']);
    expect(r.by_operation[1]!.units).toBe(45);
    expect(r.by_operation[1]!.operation).toBe('Weld');

    expect(r.by_operator.map((x) => x.key)).toEqual(['OP1', 'OP2']);
    expect(r.by_operator[0]!.label).toBe('Alice');
    expect(r.by_operator[1]!.label).toBe('OP2'); // falls back to the id
    expect(r.by_operator[0]!.units).toBe(60);

    expect(r.by_job_operation.map((x) => x.key)).toEqual(['JA|Test', 'JA|Weld', 'JB|Weld']);
    expect(r.by_job_operation[0]!.operation).toBe('Test');
    expect(r.by_job_operation[0]!.job_number).toBe('JA');

    expect(r.overall.key).toBe('overall');
    expect(r.overall.job_number).toBeNull();
    expect(r.overall.operator_id).toBeNull();
  });

  it('returns a null efficiency with no charged time', () => {
    const r = computeRollups([], settings);
    expect(r.overall.units).toBe(0);
    expect(r.overall.charged_hours).toBe(0);
    expect(r.overall.efficiency).toBeNull();
    expect(r.overall.color).toBe('neutral');
    expect(r.by_job).toEqual([]);
  });

  it('accumulates across hours for the same operator', () => {
    const cells = [
      hourCell({ hour: HOUR_A, units: 30, charged: 60, std: 30 }),
      hourCell({ hour: HOUR_B, units: 15, charged: 30, std: 30 }),
    ];
    const r = computeRollups(cells, settings);
    expect(r.overall.units).toBe(45);
    expect(r.overall.charged_minutes).toBe(90);
    expect(r.overall.charged_hours).toBe(1.5);
    expect(r.overall.earned_hours).toBe(1.5);
    expect(r.overall.efficiency).toBe(1);
    expect(r.overall.color).toBe('green');
    expect(r.overall.label).toBe('Overall');
    expect(ms(HOUR_B) - ms(HOUR_A)).toBe(3_600_000);
  });
});
