/**
 * Input/output contracts for the pure calculation engine (packages/engine).
 * The engine has no I/O: the server feeds it from the database, the demo from an in-browser simulator.
 */
import type {
  BreakInterval,
  CellColor,
  Defect,
  DefectHourCell,
  EffectiveStandard,
  GroupedHourCell,
  HourCell,
  OperatorAssignment,
  Pin,
  ShiftInstance,
  Standard,
  StandardAdjustment,
  StandardOverride,
  UnitStep,
  UtcMs,
  WorkOrder,
} from './domain.js';
import type { EngineSettings } from './settings.js';

/** Key helper format for (product_number, operation) maps: `${product} ${operation}` (space-separated; see `stdKey` in @fld/engine) */
export type StdKey = string;

export type StandardsLookup = Map<StdKey, EffectiveStandard>;

export interface ComputeStandardInput {
  product_number: string;
  operation: string;
  /**
   * All unit steps for this product/operation within the lookback window (all jobs, all operators).
   * The engine derives per-hour eligibility from these rows alone (eligibility on a job/operation
   * only depends on that job/operation's steps).
   */
  steps: UnitStep[];
  /** Expanded break intervals covering the lookback window. */
  breaks: BreakInterval[];
  settings: EngineSettings;
  now: UtcMs;
  /** FactoryLogix StdHr if mapped (fallback), else null. */
  fl_std_hr: number | null;
  /** Whether `rework_flag` is mapped (when false, no rework exclusion is attempted). */
  rework_flag_mapped: boolean;
}

export interface ComputeHourCellsInput {
  /**
   * Unit steps for ALL operators/jobs that overlap [from_utc - lookback, to_utc].
   * Provide at least 2 hours (or idle_timeout + 1 hour, whichever is larger) of steps before
   * `from_utc` so that carried assignments and previous-hour eligibility are correct.
   */
  steps: UnitStep[];
  /** Expanded break intervals covering the same range. */
  breaks: BreakInterval[];
  /** Effective standards lookup (see buildStandardsLookup). Missing => std_hr null => neutral. */
  standards: StandardsLookup;
  /**
   * StdHr some hours were already judged against (null = none), by hour start then StdKey: those
   * cells keep it instead of taking the one in `standards`. The collector passes it for the hours
   * that have ended, which stop changing (spec 7.7).
   */
  kept_std_hr?: Map<UtcMs, Map<StdKey, number | null>>;
  pins: Pin[];
  settings: EngineSettings;
  /** Emit cells for hour buckets whose start is in [from_utc, to_utc). */
  from_utc: UtcMs;
  to_utc: UtcMs;
  now: UtcMs;
}

export interface ComputeHourCellsOutput {
  cells: HourCell[];
  /** Assignment state of every operator seen, as of min(now, to_utc). */
  assignments: OperatorAssignment[];
}

export interface RollupRow {
  key: string;
  label: string;
  job_number: string | null;
  product_number: string | null;
  operation: string | null;
  operator_id: string | null;
  units: number;
  visitor_units: number;
  charged_minutes: number;
  charged_hours: number;
  earned_hours: number;
  /**
   * earned_hours over the charged hours of the cells with a StdHr (the others are left out);
   * null when those have no charged time
   */
  efficiency: number | null;
  color: CellColor;
  eligible_operators: number;
  /** count of contributing cells with null std_hr (flag in UI) */
  rows_without_std: number;
  /** charged hours of those cells: part of charged_hours, left out of efficiency */
  charged_hours_without_std: number;
}

export interface Rollups {
  overall: RollupRow;
  by_job: RollupRow[];
  by_operation: RollupRow[];
  by_operator: RollupRow[];
  by_job_operation: RollupRow[];
}

export interface StandardsInputs {
  standards: Standard[];
  adjustments: StandardAdjustment[];
  overrides: StandardOverride[];
}

export interface WindowColumn {
  hour_start_utc: UtcMs;
  /** local hour label, e.g. "10", "13", "01" */
  label: string;
}

// ---------- View builders (pure; used by API and mock alike) ----------

export interface PriorCount {
  operation: string;
  /** null in grouped/defect contexts */
  operator_id: string | null;
  units: number;
}

export interface TvDashboardInput {
  work_order: WorkOrder;
  /** ordered operation names for the product; unknown operations are appended in first-seen order */
  route: string[];
  /** per-operator cells for this job whose hour_start_utc is within the window columns */
  cells: HourCell[];
  /** units per (operation, operator) completed on this job before the window start */
  prior: PriorCount[];
  defect_cells: DefectHourCell[];
  /** defects per operation before the window start */
  prior_defects: { operation: string; count: number }[];
  columns: WindowColumn[];
  grouped: boolean;
  show_std_day: boolean;
  shift_length_hours: number;
  /** effective StdHr per operation for this product (null = unavailable) */
  std_hr_by_operation: Record<string, number | null>;
  operator_names: Record<string, string | null>;
  /** derived qty complete when the work order has null qty_complete */
  derived_qty_complete: number | null;
  settings: EngineSettings;
  now: UtcMs;
}

export interface TvCell {
  hour_start_utc: UtcMs;
  units: number;
  color: CellColor;
  pace: number | null;
  charged_minutes: number;
  eligible: boolean;
  visitor: boolean;
  provisional: boolean;
}

export interface TvRow {
  operation: string;
  operation_seq: number;
  /** the row's operator; in grouped mode set only when exactly one operator worked the step in the window */
  operator_id: string | null;
  operator_name: string | null;
  /** distinct operators contributing to the row inside the window (eligible ones when any, else visitors), sorted */
  operators: string[];
  std_hr: number | null;
  prior: number;
  cells: TvCell[];
  shift: number;
  std_day: number | null;
  /** true when the operator is a visitor in at least one window hour and eligible in none */
  visitor_row: boolean;
}

export interface TvDefectRow {
  operation: string;
  operation_seq: number;
  prior: number;
  cells: number[];
  shift_qty: number;
}

export interface TvDashboard {
  job: {
    job_number: string;
    product_number: string;
    product_name: string | null;
    qty_released: number;
    qty_complete: number;
    progress: number;
  };
  grouped: boolean;
  show_std_day: boolean;
  columns: WindowColumn[];
  rows: TvRow[];
  defect_rows: TvDefectRow[];
  generated_at: UtcMs;
}

export interface ShiftViewFilters {
  job?: string | null;
  product?: string | null;
  operation?: string | null;
  operator?: string | null;
}

export interface ShiftViewInput {
  shift: ShiftInstance;
  /** all per-operator cells with hour_start_utc within [shift.start_utc, shift.end_utc) */
  cells: HourCell[];
  work_orders: WorkOrder[];
  routes: Record<string, string[]>;
  /** jobs with at least one unit_step start or complete in the shift interval */
  active_job_numbers: string[];
  operator_names: Record<string, string | null>;
  derived_qty_complete: Record<string, number>;
  filters: ShiftViewFilters;
  settings: EngineSettings;
  now: UtcMs;
}

export interface ShiftOperatorRow {
  operator_id: string;
  operator_name: string | null;
  units: number;
  charged_minutes: number;
  target_units: number;
  pace: number | null;
  color: CellColor;
  eligible: boolean;
  visitor: boolean;
}

export interface ShiftOperationRow {
  operation: string;
  operation_seq: number;
  std_hr: number | null;
  eligible_operators: number;
  units: number;
  visitor_units: number;
  charged_minutes: number;
  target_units: number;
  pace: number | null;
  color: CellColor;
  operators: ShiftOperatorRow[];
}

export interface ShiftJobSection {
  job_number: string;
  product_number: string;
  product_name: string | null;
  qty_released: number;
  qty_complete: number;
  progress: number;
  units: number;
  charged_hours: number;
  earned_hours: number;
  efficiency: number | null;
  color: CellColor;
  /** charged hours without a StdHr, left out of efficiency (RollupRow) */
  charged_hours_without_std: number;
  operations: ShiftOperationRow[];
}

export interface ShiftView {
  shift: ShiftInstance;
  in_progress: boolean;
  summary: {
    efficiency: number | null;
    color: CellColor;
    total_units: number;
    total_charged_hours: number;
    total_earned_hours: number;
    active_jobs: number;
    eligible_operators: number;
    rows_without_std: number;
    charged_hours_without_std: number;
  };
  jobs: ShiftJobSection[];
  rollups: Rollups;
  generated_at: UtcMs;
}

export interface FloorViewInput {
  /** cells for the current hour (all jobs) */
  current_cells: HourCell[];
  /** cells for the previous 12 hours including current (for units_12h) */
  window_cells: HourCell[];
  assignments: OperatorAssignment[];
  operator_names: Record<string, string | null>;
  product_names: Record<string, string | null>;
  settings: EngineSettings;
  now: UtcMs;
}

export interface FloorRow {
  operator_id: string;
  operator_name: string | null;
  job_number: string;
  product_number: string;
  product_name: string | null;
  operation: string;
  units_hour: number;
  pace: number | null;
  color: CellColor;
  units_12h: number;
  last_scan_at: UtcMs | null;
  minutes_since_scan: number | null;
  idle_flag: boolean;
  visitor: boolean;
}

export interface FloorView {
  hour_start_utc: UtcMs;
  rows: FloorRow[];
  generated_at: UtcMs;
}

export interface OperatorDetailInput {
  operator_id: string;
  operator_name: string | null;
  cells: HourCell[];
  columns: WindowColumn[];
  assignment: OperatorAssignment | null;
  pins: Pin[];
  product_names: Record<string, string | null>;
  settings: EngineSettings;
  now: UtcMs;
  range: { from_utc: UtcMs; to_utc: UtcMs };
}

export interface OperatorStrip {
  job_number: string;
  product_number: string;
  operation: string;
  std_hr: number | null;
  cells: TvCell[];
  total_units: number;
}

export interface OperatorRangeRow {
  job_number: string;
  product_number: string;
  product_name: string | null;
  operation: string;
  std_hr: number | null;
  window_minutes: number;
  charged_minutes: number;
  /** units of the eligible hours: the pace numerator */
  units: number;
  /** units of the visitor hours: shown, never judged (spec 7.3) */
  visitor_units: number;
  target_units: number;
  pace: number | null;
  color: CellColor;
  eligible_hours: number;
  visitor_hours: number;
  pinned: PinModeOrNull;
}

export type PinModeOrNull = 'force_eligible' | 'force_visitor' | null;

export interface OperatorDetail {
  operator_id: string;
  operator_name: string | null;
  assignment: OperatorAssignment | null;
  strips: OperatorStrip[];
  rows: OperatorRangeRow[];
  range: { from_utc: UtcMs; to_utc: UtcMs };
  generated_at: UtcMs;
}

export interface JobShiftHistoryRow {
  shift: ShiftInstance;
  units: number;
  charged_hours: number;
  earned_hours: number;
  efficiency: number | null;
  color: CellColor;
  /** charged hours without a StdHr, left out of efficiency (RollupRow) */
  charged_hours_without_std: number;
}

export interface JobOperatorTotal {
  operator_id: string;
  operator_name: string | null;
  units: number;
  charged_minutes: number;
  operations: string[];
}

export interface JobDetailInput {
  dashboard_separate: TvDashboard;
  dashboard_grouped: TvDashboard;
  /** all cells for this job (whole life) */
  all_cells: HourCell[];
  shift_instances: ShiftInstance[];
  operator_names: Record<string, string | null>;
  displays_showing: { id: number; name: string | null }[];
  settings: EngineSettings;
  now: UtcMs;
}

export interface JobDetail {
  dashboard_separate: TvDashboard;
  dashboard_grouped: TvDashboard;
  operators: JobOperatorTotal[];
  shift_history: JobShiftHistoryRow[];
  displays_showing: { id: number; name: string | null }[];
  generated_at: UtcMs;
}

export interface ProductViewInput {
  product_number: string;
  product_name: string | null;
  route: string[];
  standards: Standard[];
  adjustments: StandardAdjustment[];
  overrides: StandardOverride[];
}

export interface ProductOperationRow {
  operation: string;
  operation_seq: number;
  standard: Standard | null;
  effective: EffectiveStandard;
}

export interface ProductView {
  product_number: string;
  product_name: string | null;
  rows: ProductOperationRow[];
  /** adjustments in scope for this product (global, product, operation-level for its ops, product_operation) */
  adjustments: StandardAdjustment[];
  overrides: StandardOverride[];
}

/** Helper types for defects view building. */
export type DefectInput = Defect;
export type GroupedCells = GroupedHourCell[];
