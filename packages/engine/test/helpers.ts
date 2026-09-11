/** Small deterministic builders shared by the engine tests. */
import type {
  BreakDef,
  BreakInterval,
  CellColor,
  Defect,
  EffectiveStandard,
  EngineSettings,
  HourCell,
  Pin,
  ShiftDef,
  Standard,
  StandardAdjustment,
  StandardOverride,
  StandardsLookup,
  UnitStep,
  UtcMs,
  WorkOrder,
} from '@fld/shared';
import { DEFAULT_ENGINE_SETTINGS } from '@fld/shared';
import { colorForPace } from '../src/cells.js';

export const TZ = 'America/New_York';
export const KOLKATA = 'Asia/Kolkata';
export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** Parse an ISO 8601 instant (offset required for local wall times, e.g. '2025-06-10T15:20-04:00'). */
export function ms(iso: string): UtcMs {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`helpers.ms: unparseable ISO string ${iso}`);
  return t;
}

export function at(value: string | number): UtcMs {
  return typeof value === 'number' ? value : ms(value);
}

export function engineSettings(overrides: Partial<EngineSettings> = {}): EngineSettings {
  return { ...DEFAULT_ENGINE_SETTINGS, plant_timezone: TZ, ...overrides };
}

let unitSeq = 0;
export function resetUnitSeq(): void {
  unitSeq = 0;
}

export function step(
  operator: string,
  job: string,
  op: string,
  startIso: string | number,
  completeIso: string | number | null,
  extra: {
    product?: string;
    unit_id?: string;
    rework_flag?: boolean | null;
    operation_seq?: number | null;
    result?: string | null;
  } = {},
): UnitStep {
  unitSeq += 1;
  return {
    unit_id: extra.unit_id ?? `U${unitSeq}`,
    job_number: job,
    product_number: extra.product ?? 'Z1',
    operation: op,
    operation_seq: extra.operation_seq ?? null,
    operator_id: operator,
    start_ts: at(startIso),
    complete_ts: completeIso === null ? null : at(completeIso),
    result: extra.result ?? 'pass',
    rework_flag: extra.rework_flag ?? null,
  };
}

/** `n` back-to-back units of `minutes` each starting at `startIso`. */
export function stepRun(
  operator: string,
  job: string,
  op: string,
  startIso: string | number,
  minutes: number,
  n: number,
  extra: { product?: string; gapMinutes?: number } = {},
): UnitStep[] {
  const start = at(startIso);
  const gap = (extra.gapMinutes ?? 0) * MINUTE;
  const out: UnitStep[] = [];
  for (let i = 0; i < n; i++) {
    const s = start + i * (minutes * MINUTE + gap);
    out.push(step(operator, job, op, s, s + minutes * MINUTE, { product: extra.product }));
  }
  return out;
}

export function breakInterval(
  id: number,
  startIso: string | number,
  endIso: string | number,
  name = 'Break',
): BreakInterval {
  return { break_id: id, name, start_utc: at(startIso), end_utc: at(endIso) };
}

export function shiftDef(o: Partial<ShiftDef> & { id: number; name: string }): ShiftDef {
  return {
    start_local: '07:00',
    end_local: '19:00',
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    effective_from: '2000-01-01',
    effective_to: null,
    ...o,
  };
}

export function breakDef(o: Partial<BreakDef> & { id: number; name: string }): BreakDef {
  return {
    start_local: '10:00',
    duration_minutes: 15,
    days_of_week: [0, 1, 2, 3, 4, 5, 6],
    shift_ids: null,
    effective_from: '2000-01-01',
    effective_to: null,
    ...o,
  };
}

export function pin(o: Partial<Pin> & { operator_id: string; job_number: string; mode: Pin['mode'] }): Pin {
  return {
    id: 1,
    operation: null,
    created_by: 'tester',
    created_at: 0,
    expires_at: null,
    ...o,
  };
}

/** Minimal effective-standard lookup: `[product, operation, effective StdHr]`. */
export function stdLookup(entries: [string, string, number | null][]): StandardsLookup {
  const map: StandardsLookup = new Map();
  for (const [product_number, operation, hr] of entries) {
    const eff: EffectiveStandard = {
      product_number,
      operation,
      base: hr,
      base_source: hr === null ? 'none' : 'computed',
      adjustment: null,
      adjusted: null,
      override: null,
      effective: hr,
      provenance: hr === null ? 'none' : 'base_computed',
    };
    map.set(`${product_number} ${operation}`, eff);
  }
  return map;
}

export function standard(o: Partial<Standard> & { product_number: string; operation: string }): Standard {
  return {
    computed_std_hr: null,
    median_minutes_per_unit: null,
    sample_units: 0,
    sample_operators: 0,
    sample_from: null,
    sample_to: null,
    computed_at: 0,
    fallback_source: 'none',
    fl_std_hr: null,
    ...o,
  };
}

export function adjustment(o: Partial<StandardAdjustment> & { id: number; scope: StandardAdjustment['scope']; percent: number }): StandardAdjustment {
  return {
    product_number: null,
    operation: null,
    created_by: 'tester',
    created_at: o.id,
    note: null,
    ...o,
  };
}

export function override(o: Partial<StandardOverride> & { id: number; scope: StandardOverride['scope']; product_number: string; std_hr: number }): StandardOverride {
  return {
    operation: null,
    created_by: 'tester',
    created_at: o.id,
    note: null,
    active: true,
    ...o,
  };
}

export function workOrder(o: Partial<WorkOrder> & { job_number: string }): WorkOrder {
  return {
    product_number: 'Z1',
    product_name: 'PCBA, EXAMPLE BOARD',
    qty_released: 500,
    qty_complete: null,
    status: 'active',
    fl_created_at: null,
    fl_modified_at: null,
    ...o,
  };
}

export function defect(
  o: Omit<Partial<Defect>, 'found_ts'> & {
    unit_id: string;
    job_number: string;
    operation: string;
    found_ts: string | number;
  },
): Defect {
  return {
    operator_id: null,
    defect_code: 'D1',
    description: null,
    status: 'open',
    ...o,
    found_ts: at(o.found_ts),
  };
}

/** Build an HourCell directly (target/pace/color derived unless overridden). */
export function hourCell(o: {
  hour: string | number;
  job?: string;
  product?: string;
  op?: string;
  operator?: string;
  units?: number;
  charged?: number;
  window?: number;
  work?: number;
  break_minutes?: number;
  std?: number | null;
  eligible?: boolean;
  provisional?: boolean;
  color?: CellColor;
  settings?: EngineSettings;
}): HourCell {
  const settings = o.settings ?? engineSettings();
  const eligible = o.eligible ?? true;
  const units = o.units ?? 0;
  const charged = eligible ? o.charged ?? 60 : 0;
  const std = o.std === undefined ? 30 : o.std;
  const target_units = std === null ? 0 : (std * charged) / 60;
  const pace = std !== null && target_units > 0 ? units / target_units : null;
  const color: CellColor = o.color ?? (!eligible ? 'visitor' : std === null ? 'neutral' : charged === 0 ? 'neutral' : colorForPace(pace, settings));
  return {
    hour_start_utc: at(o.hour),
    job_number: o.job ?? 'JA',
    product_number: o.product ?? 'Z1',
    operation: o.op ?? 'Weld',
    operator_id: o.operator ?? 'OP1',
    units,
    work_minutes: o.work ?? charged,
    window_minutes: o.window ?? charged,
    break_minutes: o.break_minutes ?? 0,
    charged_minutes: charged,
    eligible,
    provisional: o.provisional ?? false,
    std_hr: std,
    target_units,
    pace,
    color,
  };
}

export function findCell(
  cells: HourCell[],
  q: { hour?: string | number; job?: string; op?: string; operator?: string },
): HourCell | undefined {
  const hour = q.hour === undefined ? undefined : at(q.hour);
  return cells.find(
    (c) =>
      (hour === undefined || c.hour_start_utc === hour) &&
      (q.job === undefined || c.job_number === q.job) &&
      (q.op === undefined || c.operation === q.op) &&
      (q.operator === undefined || c.operator_id === q.operator),
  );
}

export function close(actual: number | null | undefined, expected: number, epsilon = 1e-9): boolean {
  return actual !== null && actual !== undefined && Math.abs(actual - expected) <= epsilon;
}
