/**
 * Hour-cell cache for the demo simulator.
 *
 * `computeHourCells` is the expensive part of the engine, so completed hour buckets are
 * computed once and kept. The current and previous hour are always recomputed because
 * open scans are clipped at `now` (spec 7.7).
 */
import type {
  BreakDef,
  BreakInterval,
  HourCell,
  OperatorAssignment,
  Pin,
  ShiftDef,
  StandardsLookup,
  UnitStep,
  UtcMs,
} from '@fld/shared';
import type { EngineSettings } from '@fld/shared';
import { computeHourCells, expandBreaks, hourStartUtc } from '@fld/engine';
import { MAX_STEP_SPAN_MS } from './history';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Longest run of hours computed in one `computeHourCells` call. */
const MAX_RUN_HOURS = 48;

export interface CellCacheDeps {
  steps(): UnitStep[];
  shifts(): ShiftDef[];
  breakDefs(): BreakDef[];
  standards(): StandardsLookup;
  pins(): Pin[];
  settings(): EngineSettings;
  now(): UtcMs;
}

export class CellCache {
  private byHour = new Map<number, HourCell[]>();
  private assignments: OperatorAssignment[] = [];
  private assignmentsAt = 0;

  constructor(private deps: CellCacheDeps) {}

  /** Drop everything (settings / standards / shift changes). */
  clear(): void {
    this.byHour.clear();
    this.assignments = [];
    this.assignmentsAt = 0;
  }

  /** Drop cached buckets at or after `from` (new steps arrived). */
  invalidateFrom(from: UtcMs): void {
    for (const key of [...this.byHour.keys()]) {
      if (key >= from) this.byHour.delete(key);
    }
  }

  currentAssignments(): OperatorAssignment[] {
    return this.assignments;
  }

  /** Steps overlapping [a, b), using the sorted-by-start index. */
  private stepsOverlapping(a: UtcMs, b: UtcMs): UnitStep[] {
    const steps = this.deps.steps();
    const now = this.deps.now();
    const floor = a - MAX_STEP_SPAN_MS;
    let lo = 0;
    let hi = steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid]!.start_ts < floor) lo = mid + 1;
      else hi = mid;
    }
    const out: UnitStep[] = [];
    for (let i = lo; i < steps.length; i++) {
      const s = steps[i]!;
      if (s.start_ts >= b) break;
      const end = s.complete_ts ?? now;
      if (end > a) out.push(s);
    }
    return out;
  }

  private lookbackMs(): number {
    const settings = this.deps.settings();
    return Math.max(2 * HOUR, (settings.idle_timeout_minutes + 60) * MINUTE) + MAX_STEP_SPAN_MS;
  }

  private compute(fromHour: UtcMs, toExclusive: UtcMs, store: boolean): HourCell[] {
    const settings = this.deps.settings();
    const tz = settings.plant_timezone;
    const now = this.deps.now();
    const lookback = this.lookbackMs();
    const steps = this.stepsOverlapping(fromHour - lookback, toExclusive);
    const breaks: BreakInterval[] = expandBreaks(
      this.deps.breakDefs(),
      this.deps.shifts(),
      fromHour - lookback,
      toExclusive + HOUR,
      tz,
    );
    const out = computeHourCells({
      steps,
      breaks,
      standards: this.deps.standards(),
      pins: this.deps.pins(),
      settings,
      from_utc: fromHour,
      to_utc: toExclusive,
      now,
    });
    if (toExclusive >= hourStartUtc(now, tz)) {
      this.assignments = out.assignments;
      this.assignmentsAt = now;
    }
    if (store) {
      const buckets = new Map<number, HourCell[]>();
      for (let h = fromHour; h < toExclusive; h += HOUR) buckets.set(h, []);
      for (const c of out.cells) {
        const list = buckets.get(c.hour_start_utc);
        if (list) list.push(c);
      }
      for (const [h, list] of buckets) this.byHour.set(h, list);
    }
    return out.cells;
  }

  /**
   * All cells whose hour bucket starts in [from, to). Completed hours come from (and
   * populate) the cache; the current and previous hour are recomputed every call.
   */
  cellsInRange(from: UtcMs, to: UtcMs): HourCell[] {
    const settings = this.deps.settings();
    const tz = settings.plant_timezone;
    const now = this.deps.now();
    const currentHour = hourStartUtc(now, tz);
    const volatileFrom = currentHour - HOUR;

    const startHour = hourStartUtc(from, tz);
    const endExclusive = Math.min(to, currentHour + HOUR);
    if (endExclusive <= startHour) return [];

    const out: HourCell[] = [];

    // Cached (completed) hours.
    const cacheEnd = Math.min(endExclusive, volatileFrom);
    if (cacheEnd > startHour) {
      // Group the missing buckets into contiguous runs and compute each run in one go.
      const runs: { from: number; to: number }[] = [];
      let runStart: number | null = null;
      for (let h = startHour; h < cacheEnd; h += HOUR) {
        if (this.byHour.has(h)) {
          if (runStart !== null) {
            runs.push({ from: runStart, to: h });
            runStart = null;
          }
          continue;
        }
        if (runStart === null) runStart = h;
        else if ((h - runStart) / HOUR >= MAX_RUN_HOURS) {
          runs.push({ from: runStart, to: h });
          runStart = h;
        }
      }
      if (runStart !== null) runs.push({ from: runStart, to: cacheEnd });
      for (const run of runs) this.compute(run.from, run.to, true);

      for (let h = startHour; h < cacheEnd; h += HOUR) {
        const list = this.byHour.get(h);
        if (list) out.push(...list);
      }
    }

    // Volatile hours: always recomputed against the live `now`.
    const volStart = Math.max(startHour, volatileFrom);
    if (endExclusive > volStart) {
      out.push(...this.compute(volStart, endExclusive, false));
    }
    return out;
  }

  /** Recompute the current + previous hour so `assignments` tracks the live state. */
  refreshCurrent(): void {
    const settings = this.deps.settings();
    const tz = settings.plant_timezone;
    const currentHour = hourStartUtc(this.deps.now(), tz);
    this.compute(currentHour - HOUR, currentHour + HOUR, false);
  }

  get assignmentsTimestamp(): UtcMs {
    return this.assignmentsAt;
  }
}
