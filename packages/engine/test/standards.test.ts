import { describe, expect, it } from 'vitest';
import type { ComputeStandardInput, UnitStep } from '@fld/shared';
import {
  buildStandardsLookup,
  computeStandard,
  effectiveStdHr,
  resolveEffectiveStandard,
  stdKey,
} from '../src/standards.js';
import {
  adjustment,
  breakInterval,
  engineSettings,
  ms,
  override,
  standard,
  step,
  stepRun,
} from './helpers.js';

const NOW = ms('2025-06-10T10:00-04:00');

function input(steps: UnitStep[], o: Partial<ComputeStandardInput> = {}): ComputeStandardInput {
  return {
    product_number: 'Z1',
    operation: 'Weld',
    steps,
    breaks: [],
    settings: engineSettings(),
    now: NOW,
    fl_std_hr: null,
    rework_flag_mapped: false,
    ...o,
  };
}

/** `n` units that all start and all complete at the same instant (a scan-in/scan-out batch). */
function batch(operator: string, n: number, startIso: string, completeIso: string): UnitStep[] {
  const out: UnitStep[] = [];
  for (let i = 0; i < n; i++) out.push(step(operator, 'JA', 'Weld', startIso, completeIso));
  return out;
}

describe('stdKey', () => {
  it('joins product and operation with a single space', () => {
    expect(stdKey('Z1', 'Selective Solder - Top')).toBe('Z1 Selective Solder - Top');
  });
});

describe('computeStandard', () => {
  it('computes the median per-unit minutes and rounds StdHr to one decimal', () => {
    // Two operators, 10 sequential 5-minute units each: median 5 min => 12.0 per hour.
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
    ];
    const std = computeStandard(input(steps));
    expect(std.median_minutes_per_unit).toBe(5);
    expect(std.computed_std_hr).toBe(12);
    expect(std.sample_units).toBe(20);
    expect(std.sample_operators).toBe(2);
    expect(std.fallback_source).toBe('computed');
    expect(std.sample_from).toBe(ms('2025-06-10T08:05-04:00'));
    expect(std.sample_to).toBe(ms('2025-06-10T08:50-04:00'));
    expect(std.computed_at).toBe(NOW);
  });

  it('applies the batching correction (spec 15.7)', () => {
    // 10 boards scanned in at 08:00 and all out at 08:50 => 5 min each, not 50.
    const steps = [
      ...batch('OP1', 10, '2025-06-10T08:00-04:00', '2025-06-10T08:50-04:00'),
      ...batch('OP2', 10, '2025-06-10T08:00-04:00', '2025-06-10T08:50-04:00'),
    ];
    const std = computeStandard(input(steps));
    expect(std.median_minutes_per_unit).toBe(5);
    expect(std.computed_std_hr).toBe(12);
    expect(std.computed_std_hr).not.toBe(1.2);
  });

  it('starts a new session when the gap exceeds session_gap_minutes', () => {
    // Two 5-unit batches 30 minutes apart: each session is 10 minutes busy => 2 min per unit.
    const steps = [
      ...batch('OP1', 5, '2025-06-10T08:00-04:00', '2025-06-10T08:10-04:00'),
      ...batch('OP1', 5, '2025-06-10T08:40-04:00', '2025-06-10T08:50-04:00'),
      ...batch('OP2', 5, '2025-06-10T08:00-04:00', '2025-06-10T08:10-04:00'),
      ...batch('OP2', 5, '2025-06-10T08:40-04:00', '2025-06-10T08:50-04:00'),
    ];
    const std = computeStandard(input(steps));
    expect(std.median_minutes_per_unit).toBe(2);
    expect(std.computed_std_hr).toBe(30);
    expect(std.sample_units).toBe(20);
  });

  it('subtracts break overlap from session busy minutes', () => {
    const steps = [
      ...batch('OP1', 10, '2025-06-10T08:00-04:00', '2025-06-10T08:50-04:00'),
      ...batch('OP2', 10, '2025-06-10T08:00-04:00', '2025-06-10T08:50-04:00'),
    ];
    const std = computeStandard(
      input(steps, {
        breaks: [breakInterval(1, '2025-06-10T08:10-04:00', '2025-06-10T08:20-04:00')],
      }),
    );
    expect(std.median_minutes_per_unit).toBe(4); // (50 - 10) / 10
    expect(std.computed_std_hr).toBe(15);
  });

  it('excludes units completed by a visitor (not eligible in that hour)', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      // OP3 scans 8 boards through in 80 seconds: ~1.3 work minutes => visitor.
      ...stepRun('OP3', 'JA', 'Weld', '2025-06-10T08:40-04:00', 10 / 60, 8),
    ];
    const std = computeStandard(input(steps));
    expect(std.sample_units).toBe(20);
    expect(std.sample_operators).toBe(2);
    expect(std.computed_std_hr).toBe(12);
  });

  it('excludes units longer than std_max_unit_minutes, open units and reversed timestamps', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      step('OP1', 'JA', 'Weld', '2025-06-10T05:00-04:00', '2025-06-10T08:30-04:00'), // 210 min
      step('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', null), // open
      step('OP1', 'JA', 'Weld', '2025-06-10T08:30-04:00', '2025-06-10T08:30-04:00'), // zero length
    ];
    const std = computeStandard(input(steps));
    expect(std.sample_units).toBe(20);
    expect(std.computed_std_hr).toBe(12);
  });

  it('excludes the current hour and anything outside the lookback', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      // current hour (now is 10:00): 10 fast units that would drag the median down
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T10:00-04:00', 1, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T10:00-04:00', 1, 10),
      // 400 days ago, outside the 365-day lookback
      ...stepRun('OP1', 'JA', 'Weld', '2024-05-01T08:00-04:00', 1, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2024-05-01T08:00-04:00', 1, 10),
    ];
    const std = computeStandard(input(steps));
    expect(std.sample_units).toBe(20);
    expect(std.median_minutes_per_unit).toBe(5);
  });

  it('excludes rework only when the flag is mapped', () => {
    const base = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
    ];
    const rework = stepRun('OP1', 'JB', 'Weld', '2025-06-10T07:00-04:00', 1, 10).map((s) => ({
      ...s,
      rework_flag: true,
    }));
    const mapped = computeStandard(input([...base, ...rework], { rework_flag_mapped: true }));
    expect(mapped.sample_units).toBe(20);
    const unmapped = computeStandard(input([...base, ...rework], { rework_flag_mapped: false }));
    expect(unmapped.sample_units).toBe(30);
  });

  it('falls back when the sample is too small (spec 15.11)', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 6),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 6),
    ];
    const none = computeStandard(input(steps));
    expect(none.sample_units).toBe(12);
    expect(none.sample_operators).toBe(2);
    expect(none.computed_std_hr).toBeNull();
    expect(none.median_minutes_per_unit).toBeNull();
    expect(none.fallback_source).toBe('none');

    const withFl = computeStandard(input(steps, { fl_std_hr: 25 }));
    expect(withFl.computed_std_hr).toBeNull();
    expect(withFl.fallback_source).toBe('fl_std_hr');
    expect(withFl.fl_std_hr).toBe(25);
  });

  it('requires std_min_operators distinct operators', () => {
    const steps = stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 2, 25);
    const std = computeStandard(input(steps));
    expect(std.sample_units).toBe(25);
    expect(std.sample_operators).toBe(1);
    expect(std.computed_std_hr).toBeNull();
  });

  it('averages the two middle values for an even sample and rounds to one decimal', () => {
    // 10 units at 4 min (OP1) and a 10-unit batch worth 5 min each (OP2) => median 4.5 => 13.3/hr.
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 4, 10),
      ...batch('OP2', 10, '2025-06-10T08:00-04:00', '2025-06-10T08:50-04:00'),
    ];
    const std = computeStandard(input(steps));
    expect(std.median_minutes_per_unit).toBe(4.5);
    expect(std.computed_std_hr).toBe(13.3); // 60 / 4.5 = 13.333...
  });

  it('skips a session that falls entirely inside a break', () => {
    const steps = [
      ...stepRun('OP1', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...stepRun('OP2', 'JA', 'Weld', '2025-06-10T08:00-04:00', 5, 10),
      ...batch('OP3', 4, '2025-06-10T09:00-04:00', '2025-06-10T09:15-04:00'),
      ...stepRun('OP3', 'JA', 'Weld', '2025-06-10T09:00-04:00', 15, 1),
    ];
    const std = computeStandard(
      input(steps, {
        breaks: [breakInterval(1, '2025-06-10T09:00-04:00', '2025-06-10T09:15-04:00')],
      }),
    );
    expect(std.sample_units).toBe(20);
    expect(std.sample_operators).toBe(2);
  });
});

describe('resolveEffectiveStandard', () => {
  const computed = standard({
    product_number: 'Z1',
    operation: 'Weld',
    computed_std_hr: 30,
    fallback_source: 'computed',
  });

  it('uses the computed standard as base', () => {
    const eff = resolveEffectiveStandard(computed, [], [], 'Z1', 'Weld');
    expect(eff.base).toBe(30);
    expect(eff.base_source).toBe('computed');
    expect(eff.effective).toBe(30);
    expect(eff.provenance).toBe('base_computed');
    expect(eff.adjustment).toBeNull();
    expect(eff.override).toBeNull();
  });

  it('falls back to the FactoryLogix StdHr', () => {
    const s = standard({
      product_number: 'Z1',
      operation: 'Weld',
      fl_std_hr: 25,
      fallback_source: 'fl_std_hr',
    });
    const eff = resolveEffectiveStandard(s, [], [], 'Z1', 'Weld');
    expect(eff.base).toBe(25);
    expect(eff.base_source).toBe('fl_std_hr');
    expect(eff.provenance).toBe('base_fl');
  });

  it('reports none when there is no standard at all', () => {
    const eff = resolveEffectiveStandard(null, [], [], 'Z1', 'Weld');
    expect(eff.base).toBeNull();
    expect(eff.base_source).toBe('none');
    expect(eff.effective).toBeNull();
    expect(eff.provenance).toBe('none');
  });

  it('applies only the most specific adjustment (no stacking)', () => {
    const global = adjustment({ id: 1, scope: 'global', percent: 10 });
    const product = adjustment({ id: 2, scope: 'product', percent: 50, product_number: 'Z1' });
    const operation = adjustment({ id: 3, scope: 'operation', percent: 20, operation: 'Weld' });
    const productOp = adjustment({
      id: 4,
      scope: 'product_operation',
      percent: 100,
      product_number: 'Z1',
      operation: 'Weld',
    });

    expect(resolveEffectiveStandard(computed, [global], [], 'Z1', 'Weld').effective).toBe(33);
    expect(resolveEffectiveStandard(computed, [global, product], [], 'Z1', 'Weld').effective).toBe(45);
    expect(
      resolveEffectiveStandard(computed, [global, product, operation], [], 'Z1', 'Weld').effective,
    ).toBe(36);
    expect(
      resolveEffectiveStandard(computed, [global, product, operation, productOp], [], 'Z1', 'Weld')
        .effective,
    ).toBe(60);
    expect(resolveEffectiveStandard(computed, [global], [], 'Z1', 'Weld').provenance).toBe('adjusted');
  });

  it('ignores adjustments that do not match the product or operation', () => {
    const other = adjustment({ id: 1, scope: 'product', percent: 50, product_number: 'Z9' });
    const otherOp = adjustment({ id: 2, scope: 'operation', percent: 50, operation: 'Test' });
    const eff = resolveEffectiveStandard(computed, [other, otherOp], [], 'Z1', 'Weld');
    expect(eff.adjustment).toBeNull();
    expect(eff.effective).toBe(30);
  });

  it('breaks ties on the most recently created adjustment', () => {
    const older = adjustment({ id: 1, scope: 'global', percent: 10, created_at: 100 });
    const newer = adjustment({ id: 2, scope: 'global', percent: 20, created_at: 200 });
    const eff = resolveEffectiveStandard(computed, [older, newer], [], 'Z1', 'Weld');
    expect(eff.adjustment!.id).toBe(2);
    expect(eff.effective).toBe(36);
  });

  it('leaves adjusted null when there is no base', () => {
    const eff = resolveEffectiveStandard(null, [adjustment({ id: 1, scope: 'global', percent: 10 })], [], 'Z1', 'Weld');
    expect(eff.adjusted).toBeNull();
    expect(eff.effective).toBeNull();
    expect(eff.provenance).toBe('none');
  });

  it('lets a hard override replace everything', () => {
    const productOverride = override({ id: 1, scope: 'product', product_number: 'Z1', std_hr: 40 });
    const opOverride = override({
      id: 2,
      scope: 'product_operation',
      product_number: 'Z1',
      operation: 'Weld',
      std_hr: 55,
    });
    const adj = adjustment({ id: 1, scope: 'global', percent: 10 });

    const withProduct = resolveEffectiveStandard(computed, [adj], [productOverride], 'Z1', 'Weld');
    expect(withProduct.effective).toBe(40);
    expect(withProduct.provenance).toBe('override_product');
    expect(withProduct.adjusted).toBe(33); // still reported for the portal

    const withBoth = resolveEffectiveStandard(
      computed,
      [adj],
      [productOverride, opOverride],
      'Z1',
      'Weld',
    );
    expect(withBoth.effective).toBe(55);
    expect(withBoth.provenance).toBe('override_product_operation');
  });

  it('ignores inactive overrides and overrides for other products', () => {
    const inactive = override({
      id: 1,
      scope: 'product',
      product_number: 'Z1',
      std_hr: 40,
      active: false,
    });
    const otherProduct = override({ id: 2, scope: 'product', product_number: 'Z9', std_hr: 99 });
    const eff = resolveEffectiveStandard(computed, [], [inactive, otherProduct], 'Z1', 'Weld');
    expect(eff.override).toBeNull();
    expect(eff.effective).toBe(30);
  });
});

describe('buildStandardsLookup / effectiveStdHr', () => {
  it('creates an entry for every standard and every extra key', () => {
    const standards = [
      standard({ product_number: 'Z1', operation: 'Weld', computed_std_hr: 30 }),
      standard({ product_number: 'Z1', operation: 'Test', fl_std_hr: 12 }),
    ];
    const lookup = buildStandardsLookup(standards, [], [], [
      { product_number: 'Z1', operation: 'Pack' },
      { product_number: 'Z1', operation: 'Weld' },
    ]);
    expect(lookup.size).toBe(3);
    expect(effectiveStdHr(lookup, 'Z1', 'Weld')).toBe(30);
    expect(effectiveStdHr(lookup, 'Z1', 'Test')).toBe(12);
    expect(effectiveStdHr(lookup, 'Z1', 'Pack')).toBeNull();
    expect(lookup.get('Z1 Pack')!.provenance).toBe('none');
    expect(effectiveStdHr(lookup, 'Z9', 'Weld')).toBeNull();
  });

  it('applies adjustments and overrides while building', () => {
    const lookup = buildStandardsLookup(
      [standard({ product_number: 'Z1', operation: 'Weld', computed_std_hr: 30 })],
      [adjustment({ id: 1, scope: 'global', percent: 10 })],
      [],
    );
    expect(effectiveStdHr(lookup, 'Z1', 'Weld')).toBe(33);
  });
});
