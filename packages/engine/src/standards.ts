/**
 * Standard-hour computation and resolution (spec 7.1 / 7.2).
 */
import type {
  EffectiveStandard,
  Standard,
  StandardAdjustment,
  StandardOverride,
  UnitStep,
  UtcMs,
} from '@fld/shared';
import type { ComputeStandardInput, StandardsLookup, StdKey } from '@fld/shared';
import { hourStartUtc, mergeIntervals, nextHourStartUtc, overlapWithMerged } from './time.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function stdKey(product_number: string, operation: string): StdKey {
  return `${product_number} ${operation}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// 7.1 computeStandard
// ---------------------------------------------------------------------------

export function computeStandard(input: ComputeStandardInput): Standard {
  const { product_number, operation, steps, breaks, settings, now, fl_std_hr, rework_flag_mapped } =
    input;
  const tz = settings.plant_timezone;
  const mergedBreaks = mergeIntervals(breaks);
  const currentHour = hourStartUtc(now, tz);

  // --- Step 2 (pre-pass): work minutes per (operator, job, hour) over ALL supplied steps.
  const work = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const start = s.start_ts;
    const end = Math.min(s.complete_ts ?? now, now);
    if (end <= start) continue;
    let h = hourStartUtc(start, tz);
    while (h < end) {
      const hEnd = nextHourStartUtc(h, tz);
      const ov = Math.min(end, hEnd) - Math.max(start, h);
      if (ov > 0) {
        const key = `${s.operator_id}|${s.job_number}|${h}`;
        work.set(key, (work.get(key) ?? 0) + ov / MINUTE_MS);
      }
      h = hEnd;
    }
  }

  const eligibleHour = (operator_id: string, job_number: string, hour: UtcMs): boolean =>
    (work.get(`${operator_id}|${job_number}|${hour}`) ?? 0) >= settings.eligibility_minutes;

  // --- Step 1: sample filter.
  const lookbackStart = now - settings.std_lookback_days * DAY_MS;
  const maxDuration = settings.std_max_unit_minutes * MINUTE_MS;
  const sampled: UnitStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const complete = s.complete_ts;
    if (complete === null || complete === undefined) continue;
    if (complete < lookbackStart) continue;
    if (complete <= s.start_ts) continue;
    if (complete - s.start_ts > maxDuration) continue;
    if (complete >= currentHour) continue;
    if (rework_flag_mapped && s.rework_flag === true) continue;
    if (!eligibleHour(s.operator_id, s.job_number, hourStartUtc(complete, tz))) continue;
    sampled.push(s);
  }

  // --- Step 3: sessions per operator (across jobs of this product/operation).
  const byOperator = new Map<string, UnitStep[]>();
  for (const s of sampled) {
    let list = byOperator.get(s.operator_id);
    if (list === undefined) {
      list = [];
      byOperator.set(s.operator_id, list);
    }
    list.push(s);
  }

  const gapMs = settings.session_gap_minutes * MINUTE_MS;
  const perUnitMinutes: number[] = [];
  const operators = new Set<string>();
  let sampleUnits = 0;
  let sampleFrom: UtcMs | null = null;
  let sampleTo: UtcMs | null = null;

  const flushSession = (session: UnitStep[]): void => {
    if (session.length === 0) return;
    const union = mergeIntervals(
      session.map((s) => ({ start_utc: s.start_ts, end_utc: s.complete_ts as number })),
    );
    let busyMs = 0;
    for (const iv of union) {
      busyMs += iv.end_utc - iv.start_utc - overlapWithMerged(iv.start_utc, iv.end_utc, mergedBreaks);
    }
    if (busyMs <= 0) return; // entirely inside a break: skip these units
    const per = busyMs / MINUTE_MS / session.length;
    for (const s of session) {
      perUnitMinutes.push(per);
      operators.add(s.operator_id);
      sampleUnits++;
      const c = s.complete_ts as number;
      if (sampleFrom === null || c < sampleFrom) sampleFrom = c;
      if (sampleTo === null || c > sampleTo) sampleTo = c;
    }
  };

  for (const list of byOperator.values()) {
    list.sort((a, b) => a.start_ts - b.start_ts || (a.complete_ts ?? 0) - (b.complete_ts ?? 0));
    let session: UnitStep[] = [];
    let sessionEnd = -Infinity;
    for (const s of list) {
      if (session.length > 0 && s.start_ts > sessionEnd + gapMs) {
        flushSession(session);
        session = [];
        sessionEnd = -Infinity;
      }
      session.push(s);
      const c = s.complete_ts as number;
      if (c > sessionEnd) sessionEnd = c;
    }
    flushSession(session);
  }

  // --- Steps 4-6.
  const med = median(perUnitMinutes);
  const sampleOperators = operators.size;
  const enough =
    sampleUnits >= settings.std_min_units && sampleOperators >= settings.std_min_operators;

  let computed_std_hr: number | null = null;
  let median_minutes_per_unit: number | null = null;
  if (enough && med !== null && med > 0) {
    median_minutes_per_unit = med;
    computed_std_hr = round1(60 / med);
  }

  let fallback_source: Standard['fallback_source'];
  if (computed_std_hr !== null) fallback_source = 'computed';
  else if (typeof fl_std_hr === 'number' && fl_std_hr > 0) fallback_source = 'fl_std_hr';
  else fallback_source = 'none';

  return {
    product_number,
    operation,
    computed_std_hr,
    median_minutes_per_unit,
    sample_units: sampleUnits,
    sample_operators: sampleOperators,
    sample_from: sampleFrom,
    sample_to: sampleTo,
    computed_at: now,
    fallback_source,
    fl_std_hr,
  };
}

// ---------------------------------------------------------------------------
// 7.2 effective standard
// ---------------------------------------------------------------------------

const ADJUSTMENT_SPECIFICITY: Record<string, number> = {
  product_operation: 4,
  operation: 3,
  product: 2,
  global: 1,
};

function pickAdjustment(
  adjustments: StandardAdjustment[],
  product_number: string,
  operation: string,
): StandardAdjustment | null {
  let best: StandardAdjustment | null = null;
  let bestRank = 0;
  for (const a of adjustments) {
    let rank = 0;
    switch (a.scope) {
      case 'product_operation':
        if (a.product_number === product_number && a.operation === operation) rank = 4;
        break;
      case 'operation':
        if (a.operation === operation) rank = 3;
        break;
      case 'product':
        if (a.product_number === product_number) rank = 2;
        break;
      case 'global':
        rank = 1;
        break;
      default:
        rank = 0;
        break;
    }
    if (rank === 0) continue;
    if (
      best === null ||
      rank > bestRank ||
      (rank === bestRank && (a.created_at > best.created_at || (a.created_at === best.created_at && a.id > best.id)))
    ) {
      best = a;
      bestRank = rank;
    }
  }
  return best;
}

function pickOverride(
  overrides: StandardOverride[],
  product_number: string,
  operation: string,
): StandardOverride | null {
  let best: StandardOverride | null = null;
  let bestRank = 0;
  for (const o of overrides) {
    if (o.active !== true) continue;
    let rank = 0;
    if (o.scope === 'product_operation') {
      if (o.product_number === product_number && o.operation === operation) rank = 2;
    } else if (o.scope === 'product') {
      if (o.product_number === product_number) rank = 1;
    }
    if (rank === 0) continue;
    if (
      best === null ||
      rank > bestRank ||
      (rank === bestRank && (o.created_at > best.created_at || (o.created_at === best.created_at && o.id > best.id)))
    ) {
      best = o;
      bestRank = rank;
    }
  }
  return best;
}

export function resolveEffectiveStandard(
  standard: Standard | null | undefined,
  adjustments: StandardAdjustment[],
  overrides: StandardOverride[],
  product_number: string,
  operation: string,
): EffectiveStandard {
  let base: number | null = null;
  let base_source: EffectiveStandard['base_source'] = 'none';
  if (standard) {
    if (standard.computed_std_hr !== null && standard.computed_std_hr !== undefined) {
      base = standard.computed_std_hr;
      base_source = 'computed';
    } else if (typeof standard.fl_std_hr === 'number' && standard.fl_std_hr > 0) {
      base = standard.fl_std_hr;
      base_source = 'fl_std_hr';
    }
  }

  const adjustment = pickAdjustment(adjustments, product_number, operation);
  const adjusted =
    adjustment !== null && base !== null ? round1(base * (1 + adjustment.percent / 100)) : null;

  const override = pickOverride(overrides, product_number, operation);

  let effective: number | null;
  let provenance: EffectiveStandard['provenance'];
  if (override !== null) {
    effective = override.std_hr;
    provenance =
      override.scope === 'product_operation' ? 'override_product_operation' : 'override_product';
  } else if (adjusted !== null) {
    effective = adjusted;
    provenance = 'adjusted';
  } else if (base !== null) {
    effective = base;
    provenance = base_source === 'computed' ? 'base_computed' : 'base_fl';
  } else {
    effective = null;
    provenance = 'none';
  }

  return {
    product_number,
    operation,
    base,
    base_source,
    adjustment,
    adjusted,
    override,
    effective,
    provenance,
  };
}

export function buildStandardsLookup(
  standards: Standard[],
  adjustments: StandardAdjustment[],
  overrides: StandardOverride[],
  extraKeys?: { product_number: string; operation: string }[],
): StandardsLookup {
  const lookup: StandardsLookup = new Map();
  for (const s of standards) {
    lookup.set(
      stdKey(s.product_number, s.operation),
      resolveEffectiveStandard(s, adjustments, overrides, s.product_number, s.operation),
    );
  }
  if (extraKeys) {
    for (const k of extraKeys) {
      const key = stdKey(k.product_number, k.operation);
      if (lookup.has(key)) continue;
      lookup.set(
        key,
        resolveEffectiveStandard(null, adjustments, overrides, k.product_number, k.operation),
      );
    }
  }
  return lookup;
}

export function effectiveStdHr(
  lookup: StandardsLookup,
  product_number: string,
  operation: string,
): number | null {
  return lookup.get(stdKey(product_number, operation))?.effective ?? null;
}
