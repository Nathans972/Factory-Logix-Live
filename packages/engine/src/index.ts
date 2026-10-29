/**
 * @fld/engine — pure, dependency-free calculation engine (spec section 7).
 *
 * THIS FILE IS THE PUBLIC API CONTRACT. The implementation lives in ./time.ts, ./standards.ts,
 * ./cells.ts, ./rollups.ts, ./views.ts and is re-exported here. Every function is pure:
 * no I/O, no Date.now() (callers pass `now`), no timers.
 *
 * Time zone handling uses only Intl.DateTimeFormat (available in Node 20+ and all modern browsers).
 */
import type {
  BreakDef,
  BreakInterval,
  CellColor,
  Defect,
  DefectHourCell,
  EffectiveStandard,
  GroupedHourCell,
  HourCell,
  LocalDate,
  LocalTime,
  ShiftDef,
  ShiftInstance,
  Standard,
  StandardAdjustment,
  StandardOverride,
  UtcMs,
} from '@fld/shared';
import type {
  ComputeHourCellsInput,
  ComputeHourCellsOutput,
  ComputeStandardInput,
  EngineSettings,
  FloorView,
  FloorViewInput,
  JobDetail,
  JobDetailInput,
  OperatorDetail,
  OperatorDetailInput,
  ProductView,
  ProductViewInput,
  Rollups,
  ShiftView,
  ShiftViewInput,
  StandardsLookup,
  StdKey,
  TvDashboard,
  TvDashboardInput,
  WindowColumn,
} from '@fld/shared';

export * from './time.js';
export * from './standards.js';
export * from './cells.js';
export * from './rollups.js';
export * from './views.js';

// The declarations below document the required exports of each module. They are re-declared here as
// types only so that the contract is visible in one place; the real exports come from the modules above.

export interface EngineTimeApi {
  /** Offset of `tz` from UTC at the given instant, in ms (positive east of UTC). */
  getTzOffsetMs(tz: string, utcMs: UtcMs): number;
  /** Local wall-clock parts at an instant. weekday: 0 = Sunday. */
  utcToLocalParts(utcMs: UtcMs, tz: string): LocalParts;
  /** Convert local wall-clock to UTC ms. Ambiguous (fall-back) times resolve per `ambiguous` (default 'earlier'); non-existent (spring-forward) times shift forward by the gap. */
  localToUtc(tz: string, parts: LocalPartsInput, opts?: { ambiguous?: 'earlier' | 'later' }): UtcMs;
  /** Start of the local clock hour containing `utcMs`, as UTC ms. Works for half-hour zones. */
  hourStartUtc(utcMs: UtcMs, tz: string): UtcMs;
  /** Two-digit local hour label for an hour start, e.g. "09", "13". */
  hourLabel(hourStartUtc: UtcMs, tz: string): string;
  /** 'YYYY-MM-DD' of the local calendar day containing the instant. */
  localDateString(utcMs: UtcMs, tz: string): LocalDate;
  /** Add n calendar days to a 'YYYY-MM-DD' string. */
  addDays(date: LocalDate, n: number): LocalDate;
  /** 0 = Sunday for a 'YYYY-MM-DD' string (calendar, tz-independent). */
  dayOfWeek(date: LocalDate): number;
  /** Parse 'HH:MM' into minutes since midnight. */
  parseLocalTime(t: LocalTime): number;
  /** Concrete instance of a shift starting on `date` (end may be next day; if end <= start it is next day). Ignores days_of_week/effective range. */
  expandShiftInstance(shift: ShiftDef, date: LocalDate, tz: string): ShiftInstance;
  /** The version of `shift` in effect on `date`: itself if its effective range covers the date, else the same-named version whose range does (a versioned edit gives the new version a new id). Null if none. */
  resolveShiftVersion(shifts: ShiftDef[], shift: ShiftDef, date: LocalDate): ShiftDef | null;
  /** All shift instances (respecting days_of_week and effective_from/to) whose [start,end) overlaps [fromUtc,toUtc). Sorted by start. */
  listShiftInstances(shifts: ShiftDef[], fromUtc: UtcMs, toUtc: UtcMs, tz: string): ShiftInstance[];
  /** The instance in progress at `now`, or null. */
  findCurrentShift(shifts: ShiftDef[], now: UtcMs, tz: string): ShiftInstance | null;
  /** The instance in progress at `now`, else the most recently ended one (searching back up to 14 days), or null. */
  findCurrentOrMostRecentShift(shifts: ShiftDef[], now: UtcMs, tz: string): ShiftInstance | null;
  /** Expand break definitions into concrete UTC intervals overlapping [fromUtc,toUtc). Breaks with shift_ids apply only when one of those shifts is in progress at the break start. */
  expandBreaks(breaks: BreakDef[], shifts: ShiftDef[], fromUtc: UtcMs, toUtc: UtcMs, tz: string): BreakInterval[];
  /** The 12 (or n) hour columns ending with the current hour: [now-11h .. now], each labeled with the local hour. Computed in UTC so DST never creates gaps/overlaps. */
  rollingWindowColumns(now: UtcMs, tz: string, hours?: number): WindowColumn[];
  /** Hour columns covering [fromUtc, toUtc) (used for shift/operator views). */
  hourColumns(fromUtc: UtcMs, toUtc: UtcMs, tz: string): WindowColumn[];
  /** Next occurrence of local 'HH:MM' strictly after `afterUtc`. */
  nextLocalTime(tz: string, time: LocalTime, afterUtc: UtcMs): UtcMs;
  /** True if `utcMs` falls inside the local daily window [start,end) (end may be past midnight). */
  inLocalWindow(tz: string, utcMs: UtcMs, start: LocalTime, end: LocalTime): boolean;
  /** Total ms of overlap between [aStart,aEnd) and the union of the given intervals. */
  overlapWithIntervals(aStart: UtcMs, aEnd: UtcMs, intervals: { start_utc: UtcMs; end_utc: UtcMs }[]): number;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

export interface LocalPartsInput {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute?: number;
  second?: number;
}

export interface EngineStandardsApi {
  stdKey(product_number: string, operation: string): StdKey;
  /** Spec 7.1: sessions/batching correction, median, min sample, fallback. */
  computeStandard(input: ComputeStandardInput): Standard;
  /** Spec 7.2: base -> single most specific adjustment -> hard override. */
  resolveEffectiveStandard(
    standard: Standard | null | undefined,
    adjustments: StandardAdjustment[],
    overrides: StandardOverride[],
    product_number: string,
    operation: string,
  ): EffectiveStandard;
  /** Build a lookup for every (product, operation) present in `standards` plus any extra keys requested. */
  buildStandardsLookup(
    standards: Standard[],
    adjustments: StandardAdjustment[],
    overrides: StandardOverride[],
    extraKeys?: { product_number: string; operation: string }[],
  ): StandardsLookup;
  /** Effective StdHr or null from a lookup. */
  effectiveStdHr(lookup: StandardsLookup, product_number: string, operation: string): number | null;
}

export interface EngineCellsApi {
  /** Spec 7.3–7.5, 7.7: hour cells for every (operator, job, operation, hour) touched in [from_utc,to_utc). */
  computeHourCells(input: ComputeHourCellsInput): ComputeHourCellsOutput;
  /** Spec 7.5 color bands. `current` + charged < neutral_minutes => neutral. std null => neutral. */
  colorForPace(pace: number | null, settings: EngineSettings): CellColor;
  /** Spec 7.6 grouped-operator aggregation per (hour, job, operation). */
  groupCells(cells: HourCell[], settings: EngineSettings, now: UtcMs): GroupedHourCell[];
  /** Spec 7.9 defect counts per (hour, job, operation) for defects with found_ts in [from_utc,to_utc). */
  computeDefectHourCells(defects: Defect[], from_utc: UtcMs, to_utc: UtcMs, tz: string): DefectHourCell[];
}

export interface EngineRollupsApi {
  /** Spec 7.11 earned-hours roll-ups over a set of per-operator cells (visitors contribute units to visitor_units only). */
  computeRollups(cells: HourCell[], settings: EngineSettings, labels?: { operator_names?: Record<string, string | null> }): Rollups;
  /** Efficiency color uses the same bands as pace. */
  colorForEfficiency(efficiency: number | null, settings: EngineSettings): CellColor;
}

export interface EngineViewsApi {
  buildTvDashboard(input: TvDashboardInput): TvDashboard;
  buildShiftView(input: ShiftViewInput): ShiftView;
  buildFloorView(input: FloorViewInput): FloorView;
  buildOperatorDetail(input: OperatorDetailInput): OperatorDetail;
  buildJobDetail(input: JobDetailInput): JobDetail;
  buildProductView(input: ProductViewInput): ProductView;
}

export type { EffectiveStandard, StandardsLookup };
