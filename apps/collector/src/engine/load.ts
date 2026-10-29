/** Database -> engine input loading (all timestamps become UTC epoch ms). */
import type { BreakDef, Defect, Pin, ShiftDef, Standard, StandardAdjustment, StandardOverride, UnitStep } from '@fld/shared';
import { q, toMs, type Queryable } from '../db.js';

export async function loadShiftDefs(db: Queryable): Promise<ShiftDef[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT id, name,
            to_char(start_local, 'HH24:MI') AS start_local,
            to_char(end_local, 'HH24:MI')   AS end_local,
            days_of_week,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(effective_to, 'YYYY-MM-DD')   AS effective_to
       FROM shifts ORDER BY id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    start_local: String(r.start_local),
    end_local: String(r.end_local),
    days_of_week: ((r.days_of_week as number[] | null) ?? []).map(Number),
    effective_from: String(r.effective_from),
    effective_to: (r.effective_to as string | null) ?? null,
  }));
}

export async function loadBreakDefs(db: Queryable): Promise<BreakDef[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT id, name,
            to_char(start_local, 'HH24:MI') AS start_local,
            duration_minutes, days_of_week, shift_ids,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
            to_char(effective_to, 'YYYY-MM-DD')   AS effective_to
       FROM breaks ORDER BY id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    start_local: String(r.start_local),
    duration_minutes: Number(r.duration_minutes),
    days_of_week: ((r.days_of_week as number[] | null) ?? []).map(Number),
    shift_ids: r.shift_ids === null || r.shift_ids === undefined ? null : (r.shift_ids as number[]).map(Number),
    effective_from: String(r.effective_from),
    effective_to: (r.effective_to as string | null) ?? null,
  }));
}

export async function loadStandards(db: Queryable, productNumber?: string | null): Promise<Standard[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT s.product_number, o.name AS operation, s.computed_std_hr, s.median_minutes_per_unit,
            s.sample_units, s.sample_operators, s.sample_from, s.sample_to, s.computed_at,
            s.fallback_source, s.fl_std_hr
       FROM standards s JOIN operations o ON o.id = s.operation_id
      WHERE ($1::text IS NULL OR s.product_number = $1)`,
    [productNumber ?? null],
  );
  return rows.map((r) => ({
    product_number: String(r.product_number),
    operation: String(r.operation),
    computed_std_hr: r.computed_std_hr === null ? null : Number(r.computed_std_hr),
    median_minutes_per_unit: r.median_minutes_per_unit === null ? null : Number(r.median_minutes_per_unit),
    sample_units: Number(r.sample_units ?? 0),
    sample_operators: Number(r.sample_operators ?? 0),
    sample_from: toMs(r.sample_from as Date | null),
    sample_to: toMs(r.sample_to as Date | null),
    computed_at: toMs(r.computed_at as Date | null) ?? 0,
    fallback_source: r.fallback_source as Standard['fallback_source'],
    fl_std_hr: r.fl_std_hr === null ? null : Number(r.fl_std_hr),
  }));
}

export async function loadAdjustments(db: Queryable): Promise<StandardAdjustment[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT a.id, a.scope, a.product_number, o.name AS operation, a.percent, a.created_by, a.created_at, a.note
       FROM standard_adjustments a LEFT JOIN operations o ON o.id = a.operation_id
      WHERE a.active`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    scope: r.scope as StandardAdjustment['scope'],
    product_number: (r.product_number as string | null) ?? null,
    operation: (r.operation as string | null) ?? null,
    percent: Number(r.percent),
    created_by: (r.created_by as string | null) ?? null,
    created_at: toMs(r.created_at as Date | null) ?? 0,
    note: (r.note as string | null) ?? null,
  }));
}

export async function loadOverrides(db: Queryable): Promise<StandardOverride[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT v.id, v.scope, v.product_number, o.name AS operation, v.std_hr, v.created_by, v.created_at, v.note, v.active
       FROM standard_overrides v LEFT JOIN operations o ON o.id = v.operation_id
      WHERE v.active`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    scope: r.scope as StandardOverride['scope'],
    product_number: String(r.product_number),
    operation: (r.operation as string | null) ?? null,
    std_hr: Number(r.std_hr),
    created_by: (r.created_by as string | null) ?? null,
    created_at: toMs(r.created_at as Date | null) ?? 0,
    note: (r.note as string | null) ?? null,
    active: Boolean(r.active),
  }));
}

/**
 * Pins in force at some time since `since`, expired and removed ones included: an hour that has
 * ended keeps the pins that were in force when it ended (spec 7.3), whenever it is computed again.
 */
export async function loadPins(db: Queryable, since: number): Promise<Pin[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT p.id, p.operator_id, p.job_number, o.name AS operation, p.mode, p.created_by, p.created_at, p.expires_at
       FROM operator_pins p LEFT JOIN operations o ON o.id = p.operation_id
      WHERE p.expires_at IS NULL OR p.expires_at > $1`,
    [new Date(since)],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    operator_id: String(r.operator_id),
    job_number: String(r.job_number),
    operation: (r.operation as string | null) ?? null,
    mode: r.mode as Pin['mode'],
    created_by: (r.created_by as string | null) ?? null,
    created_at: toMs(r.created_at as Date | null) ?? 0,
    expires_at: toMs(r.expires_at as Date | null),
  }));
}

/**
 * Steps overlapping [from - lookback, to) that started at or after from - lookback - 24 h, plus
 * every step completed inside [from - lookback, to) however long it ran, so its unit is counted
 * (spec 7.5, 7.7 / ComputeHourCellsInput). An older step that is still open, or completed after
 * `to`, is left out: those are mostly forgotten scan-outs and would count as work in every hour
 * they span.
 */
export async function loadUnitSteps(db: Queryable, opts: { from: number; to: number; lookbackMs: number }): Promise<UnitStep[]> {
  const windowStart = new Date(opts.from - opts.lookbackMs);
  const hardStart = new Date(opts.from - opts.lookbackMs - 24 * 3_600_000);
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT us.unit_id, us.job_number, us.product_number, o.name AS operation, us.operator_id,
            us.start_ts, us.complete_ts, us.result, us.rework_flag
       FROM unit_steps us JOIN operations o ON o.id = us.operation_id
      WHERE us.start_ts >= $1 AND us.start_ts < $2
        AND (us.complete_ts IS NULL OR us.complete_ts >= $3)
      ORDER BY us.start_ts`,
    [hardStart, new Date(opts.to), windowStart],
  );
  // Started before hardStart, so none of these is in `rows`. complete_ts is bounded on both sides
  // so the lookup stays on the complete_ts index.
  const longSteps = await q<Record<string, unknown>>(
    db,
    `SELECT us.unit_id, us.job_number, us.product_number, o.name AS operation, us.operator_id,
            us.start_ts, us.complete_ts, us.result, us.rework_flag
       FROM unit_steps us JOIN operations o ON o.id = us.operation_id
      WHERE us.start_ts < $1 AND us.complete_ts >= $2 AND us.complete_ts < $3
      ORDER BY us.start_ts`,
    [hardStart, windowStart, new Date(opts.to)],
  );
  return [...longSteps, ...rows].map(toUnitStep);
}

/** All steps for one (product, operation) inside the standards lookback. */
export async function loadStepsForStandard(
  db: Queryable,
  opts: { product_number: string; operation_id: number; since: number },
): Promise<UnitStep[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT us.unit_id, us.job_number, us.product_number, o.name AS operation, us.operator_id,
            us.start_ts, us.complete_ts, us.result, us.rework_flag
       FROM unit_steps us JOIN operations o ON o.id = us.operation_id
      WHERE us.product_number = $1 AND us.operation_id = $2 AND us.complete_ts >= $3
      ORDER BY us.start_ts`,
    [opts.product_number, opts.operation_id, new Date(opts.since)],
  );
  return rows.map(toUnitStep);
}

function toUnitStep(r: Record<string, unknown>): UnitStep {
  return {
    unit_id: String(r.unit_id),
    job_number: String(r.job_number),
    product_number: String(r.product_number),
    operation: String(r.operation),
    operation_seq: null,
    operator_id: String(r.operator_id),
    start_ts: toMs(r.start_ts as Date) ?? 0,
    complete_ts: toMs(r.complete_ts as Date | null),
    result: (r.result as string | null) ?? null,
    rework_flag: r.rework_flag === null || r.rework_flag === undefined ? null : Boolean(r.rework_flag),
  };
}

export async function loadDefects(db: Queryable, from: number, to: number): Promise<Defect[]> {
  const rows = await q<Record<string, unknown>>(
    db,
    `SELECT d.unit_id, d.job_number, o.name AS operation, d.operator_id, d.defect_code, d.description, d.found_ts, d.status
       FROM defects d JOIN operations o ON o.id = d.operation_id
      WHERE d.found_ts >= $1 AND d.found_ts < $2`,
    [new Date(from), new Date(to)],
  );
  return rows.map((r) => ({
    unit_id: String(r.unit_id),
    job_number: String(r.job_number),
    operation: String(r.operation),
    operator_id: (r.operator_id as string | null) ?? null,
    defect_code: (r.defect_code as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    found_ts: toMs(r.found_ts as Date) ?? 0,
    status: (r.status as string | null) ?? null,
  }));
}
