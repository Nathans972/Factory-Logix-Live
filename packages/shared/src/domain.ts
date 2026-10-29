/**
 * Core domain types shared by the engine, API, collector and web app.
 * All timestamps are UTC epoch milliseconds (`UtcMs`) unless the name ends in `_local`.
 * Local times are 'HH:MM' strings; local dates are 'YYYY-MM-DD' strings.
 */

export type UtcMs = number;
export type LocalTime = string; // 'HH:MM'
export type LocalDate = string; // 'YYYY-MM-DD'

export type Role = 'admin' | 'manager' | 'viewer';

export type CellColor = 'blank' | 'neutral' | 'red' | 'yellow' | 'green' | 'blue' | 'visitor';

export type FallbackSource = 'computed' | 'fl_std_hr' | 'none';

export type AdjustmentScope = 'global' | 'product' | 'operation' | 'product_operation';

export type OverrideScope = 'product' | 'product_operation';

export type PinMode = 'force_eligible' | 'force_visitor';

export type SyncStatus = 'ok' | 'degraded' | 'down' | 'never';

export type FlTimestampMode = 'offset_present' | 'utc' | 'local_no_offset';

/** Work order header (job). */
export interface WorkOrder {
  job_number: string;
  product_number: string;
  product_name: string | null;
  qty_released: number;
  /** null when not mapped; the API derives it from unit_steps in that case. */
  qty_complete: number | null;
  status: string | null;
  fl_created_at: UtcMs | null;
  fl_modified_at: UtcMs | null;
}

export interface Product {
  product_number: string;
  name: string | null;
  first_seen_at: UtcMs | null;
  last_seen_at: UtcMs | null;
}

export interface Operator {
  operator_id: string;
  display_name: string | null;
  first_seen_at: UtcMs | null;
  last_seen_at: UtcMs | null;
}

/** One unit at one operation: the fundamental ingested record. */
export interface UnitStep {
  unit_id: string;
  job_number: string;
  product_number: string;
  /** Operation name (e.g. "Selective Solder - Top"). The engine keys by name. */
  operation: string;
  operation_seq: number | null;
  operator_id: string;
  start_ts: UtcMs;
  complete_ts: UtcMs | null;
  result: string | null;
  /** null when the rework flag is not mapped. */
  rework_flag: boolean | null;
}

export interface Defect {
  unit_id: string;
  job_number: string;
  operation: string;
  operator_id: string | null;
  defect_code: string | null;
  description: string | null;
  found_ts: UtcMs;
  status: string | null;
}

export interface ProductRoute {
  product_number: string;
  /** Ordered operation names. */
  operations: string[];
}

/** Plant-wide shift definition (local times; end may be past midnight). */
export interface ShiftDef {
  id: number;
  name: string;
  start_local: LocalTime;
  end_local: LocalTime;
  /** 0 = Sunday ... 6 = Saturday. Refers to the local day the shift STARTS on. */
  days_of_week: number[];
  effective_from: LocalDate;
  effective_to: LocalDate | null;
}

/** Plant-wide break definition. */
export interface BreakDef {
  id: number;
  name: string;
  start_local: LocalTime;
  duration_minutes: number;
  days_of_week: number[];
  /** null = applies to all shifts. */
  shift_ids: number[] | null;
  effective_from: LocalDate;
  effective_to: LocalDate | null;
}

/** A concrete occurrence of a shift on a calendar day. */
export interface ShiftInstance {
  shift_id: number;
  name: string;
  /** Local calendar date the shift starts on. */
  date: LocalDate;
  start_utc: UtcMs;
  end_utc: UtcMs;
}

/** A concrete break occurrence expanded to a UTC interval. */
export interface BreakInterval {
  break_id: number;
  name: string;
  start_utc: UtcMs;
  end_utc: UtcMs;
}

export interface Standard {
  product_number: string;
  operation: string;
  computed_std_hr: number | null;
  median_minutes_per_unit: number | null;
  sample_units: number;
  sample_operators: number;
  sample_from: UtcMs | null;
  sample_to: UtcMs | null;
  computed_at: UtcMs;
  fallback_source: FallbackSource;
  fl_std_hr: number | null;
}

export interface StandardAdjustment {
  id: number;
  scope: AdjustmentScope;
  product_number: string | null;
  operation: string | null;
  /** e.g. +20 or -10 */
  percent: number;
  created_by: string | null;
  created_at: UtcMs;
  note: string | null;
}

export interface StandardOverride {
  id: number;
  scope: OverrideScope;
  product_number: string;
  operation: string | null;
  std_hr: number;
  created_by: string | null;
  created_at: UtcMs;
  note: string | null;
  active: boolean;
}

export type StdProvenance =
  | 'override_product_operation'
  | 'override_product'
  | 'adjusted'
  | 'base_computed'
  | 'base_fl'
  | 'none';

/** Result of resolving base -> adjustment -> override (spec 7.2). */
export interface EffectiveStandard {
  product_number: string;
  operation: string;
  base: number | null;
  base_source: FallbackSource;
  adjustment: StandardAdjustment | null;
  adjusted: number | null;
  override: StandardOverride | null;
  effective: number | null;
  provenance: StdProvenance;
}

export interface Pin {
  id: number;
  operator_id: string;
  job_number: string;
  /** null = any operation on the job */
  operation: string | null;
  mode: PinMode;
  created_by: string | null;
  created_at: UtcMs;
  expires_at: UtcMs | null;
}

/** One (operator, job, operation, clock hour) bucket (spec 6.2). */
export interface HourCell {
  hour_start_utc: UtcMs;
  job_number: string;
  product_number: string;
  operation: string;
  operator_id: string;
  units: number;
  work_minutes: number;
  window_minutes: number;
  break_minutes: number;
  charged_minutes: number;
  eligible: boolean;
  provisional: boolean;
  std_hr: number | null;
  target_units: number;
  pace: number | null;
  color: CellColor;
  /**
   * Where in the hour the cell's units, work, window and breaks fall, so a shift that changes
   * mid-hour (06:30) takes only its part of the hour (`clipHourCell`). Absent on cells written
   * before it was recorded: those go whole to the shift their hour starts in.
   */
  spans?: CellSpans;
}

/** Offsets in ms from the cell's hour start; intervals are [from, to). */
export interface CellSpans {
  /** one per unit completed */
  completes: number[];
  work: [number, number][];
  window: [number, number][];
  /** the part of the window charged as break */
  breaks: [number, number][];
}

/** Aggregation of HourCells per (job, operation, hour): grouped-operator mode (spec 7.6). */
export interface GroupedHourCell {
  hour_start_utc: UtcMs;
  job_number: string;
  product_number: string;
  operation: string;
  /** all units including visitors */
  units: number;
  eligible_units: number;
  visitor_units: number;
  eligible_operators: string[];
  visitor_operators: string[];
  charged_minutes: number;
  std_hr: number | null;
  target_units: number;
  pace: number | null;
  color: CellColor;
  provisional: boolean;
}

export interface DefectHourCell {
  hour_start_utc: UtcMs;
  job_number: string;
  operation: string;
  count: number;
}

/** Carried-forward "what is this operator currently on" state. */
export interface OperatorAssignment {
  operator_id: string;
  job_number: string | null;
  operation: string | null;
  assigned_since: UtcMs | null;
  last_scan_at: UtcMs | null;
}

export interface Display {
  id: number;
  pairing_code: string;
  name: string | null;
  claimed_at: UtcMs | null;
  job_number: string | null;
  group_operators: boolean;
  show_std_day: boolean;
  show_gauge: boolean;
  shift_length_hours: number;
  last_seen_at: UtcMs | null;
  created_at: UtcMs;
  /** true if seen within 3 poll intervals */
  online: boolean;
}

export interface User {
  id: number;
  username: string;
  role: Role;
  active: boolean;
  created_at: UtcMs;
  last_login_at: UtcMs | null;
}

export interface AuditEntry {
  id: number;
  at: UtcMs;
  user_id: number | null;
  username: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}
