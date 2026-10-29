/**
 * Hour cell / defect cell recompute (spec 3.3, 7.3-7.7).
 * After every successful poll the hours touched by the ingested rows (plus the current and
 * previous hour) are recomputed from scratch inside a transaction and broadcast on
 * `fld_data_updated`. An hour that has ended keeps the StdHr it was last judged against
 * (`Recomputer.judged`).
 */
import {
  buildStandardsLookup,
  computeDefectHourCells,
  computeHourCells,
  expandBreaks,
  hourStartUtc,
  stdKey,
} from '@fld/engine';
import { pickEngineSettings, type BreakDef, type Settings, type ShiftDef, type StdKey } from '@fld/shared';
import { bulkUpsert, exec, notify, q, toMs, tx, type Pool } from '../db.js';
import type { Logger } from '../logger.js';
import type { OperationCache } from '../ingest/operations.js';
import { HOUR_MS, mergeHourRanges, hoursInRange, type HourRange } from './hours.js';
import { loadAdjustments, loadBreakDefs, loadDefects, loadOverrides, loadPins, loadShiftDefs, loadStandards, loadUnitSteps } from './load.js';

/** How long `Recomputer.judged` remembers an hour; an older one is read back from its cells when computed again. */
const JUDGED_MEMORY_MS = 3 * 24 * HOUR_MS;

/** How far before a range the engine reads steps and breaks, for the ownership windows. */
function lookbackMs(settings: Settings): number {
  return Math.max(3 * HOUR_MS, settings.idle_timeout_minutes * 60_000 + HOUR_MS);
}

export interface RecomputeResult {
  hours: number[];
  ranges: number;
  cells: number;
  durationMs: number;
}

export class Recomputer {
  /**
   * The StdHr each product and operation was judged against in each hour the last time its cells
   * were computed, by hour start: as this collector wrote them, or read back from the cells of an
   * hour it has not computed since it started. Once an hour has ended, computing it again (once
   * more when it ends, the previous hour after every poll, late rows, `recompute_cells`) keeps that
   * StdHr: a standards change applies to the running hour and the ones after it (spec 7.7,
   * docs/CALCULATIONS.md), not also to whichever ended hour happens to be computed again next.
   */
  private readonly judged = new Map<number, Map<StdKey, number | null>>();

  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly operations: OperationCache,
  ) {}

  /**
   * Recompute every hour bucket in `hourStarts` (merged into contiguous ranges). `currentStandards`:
   * judge the hours that already ended against today's standards too, instead of the StdHr they
   * keep (the backfill's recoloring, which gives the history its standards).
   */
  async recomputeHours(
    hourStarts: Iterable<number>,
    settings: Settings,
    now: number,
    opts: { notify?: boolean; currentStandards?: boolean } = {},
  ): Promise<RecomputeResult> {
    const started = Date.now();
    const ranges = mergeHourRanges(hourStarts);
    if (ranges.length === 0) return { hours: [], ranges: 0, cells: 0, durationMs: 0 };

    const [shifts, breakDefs, standards, adjustments, overrides, pins] = await Promise.all([
      loadShiftDefs(this.pool),
      loadBreakDefs(this.pool),
      loadStandards(this.pool),
      loadAdjustments(this.pool),
      loadOverrides(this.pool),
      loadPins(this.pool, ranges[0]!.from - lookbackMs(settings)),
    ]);

    const hours: number[] = [];
    let cells = 0;
    for (const range of ranges) {
      cells += await this.recomputeRange(range, {
        settings,
        now,
        shifts,
        breakDefs,
        standards,
        adjustments,
        overrides,
        pins,
        currentStandards: opts.currentStandards === true,
      });
      hours.push(...hoursInRange(range));
    }

    if (opts.notify !== false && hours.length > 0) {
      await notify(this.pool, 'fld_data_updated', { hours });
    }
    const durationMs = Date.now() - started;
    this.log.debug({ hours: hours.length, ranges: ranges.length, cells, durationMs }, 'hour cells recomputed');
    return { hours, ranges: ranges.length, cells, durationMs };
  }

  /** Convenience: recompute the current and previous hour only. */
  async recomputeCurrentHours(settings: Settings, now: number): Promise<RecomputeResult> {
    const current = hourStartUtc(now, settings.plant_timezone);
    return this.recomputeHours([current - HOUR_MS, current], settings, now);
  }

  private async recomputeRange(
    range: HourRange,
    ctx: {
      settings: Settings;
      now: number;
      shifts: ShiftDef[];
      breakDefs: BreakDef[];
      standards: Awaited<ReturnType<typeof loadStandards>>;
      adjustments: Awaited<ReturnType<typeof loadAdjustments>>;
      overrides: Awaited<ReturnType<typeof loadOverrides>>;
      pins: Awaited<ReturnType<typeof loadPins>>;
      currentStandards: boolean;
    },
  ): Promise<number> {
    const tz = ctx.settings.plant_timezone;
    const engineSettings = pickEngineSettings(ctx.settings);
    const lookback = lookbackMs(ctx.settings);
    const currentHour = hourStartUtc(ctx.now, tz);

    const [steps, defects, kept] = await Promise.all([
      loadUnitSteps(this.pool, { from: range.from, to: range.to, lookbackMs: lookback }),
      loadDefects(this.pool, range.from, range.to),
      ctx.currentStandards ? undefined : this.keptStdHr(range, currentHour),
    ]);

    const breaks = expandBreaks(ctx.breakDefs, ctx.shifts, range.from - lookback, range.to, tz);
    const extraKeys = [...new Set(steps.map((s) => `${s.product_number}\u0001${s.operation}`))].map((key) => {
      const [product_number, operation] = key.split('\u0001');
      return { product_number: product_number as string, operation: operation as string };
    });
    const lookup = buildStandardsLookup(ctx.standards, ctx.adjustments, ctx.overrides, extraKeys);

    const result = computeHourCells({
      steps,
      breaks,
      standards: lookup,
      kept_std_hr: kept,
      pins: ctx.pins,
      settings: engineSettings,
      from_utc: range.from,
      to_utc: range.to,
      now: ctx.now,
    });
    const defectCells = computeDefectHourCells(defects, range.from, range.to, tz);

    const operationNames = new Set<string>();
    for (const cell of result.cells) operationNames.add(cell.operation);
    for (const cell of defectCells) operationNames.add(cell.operation);
    for (const assignment of result.assignments) {
      if (assignment.operation) operationNames.add(assignment.operation);
    }
    const operationIds = await this.operations.resolveMany(operationNames);
    const written = result.cells.filter((cell) => operationIds.has(cell.operation));

    const includesCurrentHour = currentHour >= range.from && currentHour < range.to;

    await tx(this.pool, async (client) => {
      await exec(client, 'DELETE FROM hour_cells WHERE hour_start_utc >= $1 AND hour_start_utc < $2', [
        new Date(range.from),
        new Date(range.to),
      ]);
      await bulkUpsert(client, {
        table: 'hour_cells',
        columns: [
          'hour_start_utc',
          'job_number',
          'product_number',
          'operation_id',
          'operator_id',
          'units',
          'work_minutes',
          'window_minutes',
          'break_minutes',
          'charged_minutes',
          'eligible',
          'provisional',
          'std_hr',
          'target_units',
          'pace',
          'color',
        ],
        rows: written.map((cell) => [
          new Date(cell.hour_start_utc),
          cell.job_number,
          cell.product_number,
          operationIds.get(cell.operation),
          cell.operator_id,
          Math.trunc(cell.units),
          cell.work_minutes,
          cell.window_minutes,
          cell.break_minutes,
          cell.charged_minutes,
          cell.eligible,
          cell.provisional,
          cell.std_hr,
          cell.target_units,
          cell.pace,
          cell.color,
        ]),
        conflict: ['hour_start_utc', 'job_number', 'operation_id', 'operator_id'],
        update: [
          'product_number',
          'units',
          'work_minutes',
          'window_minutes',
          'break_minutes',
          'charged_minutes',
          'eligible',
          'provisional',
          'std_hr',
          'target_units',
          'pace',
          'color',
        ],
        extraSet: ['computed_at = now()'],
      });

      await exec(client, 'DELETE FROM defect_hour_cells WHERE hour_start_utc >= $1 AND hour_start_utc < $2', [
        new Date(range.from),
        new Date(range.to),
      ]);
      await bulkUpsert(client, {
        table: 'defect_hour_cells',
        columns: ['hour_start_utc', 'job_number', 'operation_id', 'count'],
        rows: defectCells
          .filter((cell) => operationIds.has(cell.operation))
          .map((cell) => [new Date(cell.hour_start_utc), cell.job_number, operationIds.get(cell.operation), Math.trunc(cell.count)]),
        conflict: ['hour_start_utc', 'job_number', 'operation_id'],
        update: ['count'],
      });

      if (includesCurrentHour && result.assignments.length > 0) {
        await bulkUpsert(client, {
          table: 'operator_assignment_state',
          columns: ['operator_id', 'job_number', 'operation_id', 'assigned_since', 'last_scan_at'],
          rows: result.assignments.map((a) => [
            a.operator_id,
            a.job_number,
            a.operation ? (operationIds.get(a.operation) ?? null) : null,
            a.assigned_since === null ? null : new Date(a.assigned_since),
            a.last_scan_at === null ? null : new Date(a.last_scan_at),
          ]),
          conflict: ['operator_id'],
          update: ['job_number', 'operation_id', 'assigned_since', 'last_scan_at'],
          extraSet: ['updated_at = now()'],
        });
      }
    });

    // Written: what each hour was judged against, kept the next time it is computed once it has ended.
    for (const hour of hoursInRange(range)) this.judged.set(hour, new Map());
    for (const cell of written) {
      this.judged.get(cell.hour_start_utc)?.set(stdKey(cell.product_number, cell.operation), cell.std_hr);
    }
    for (const hour of this.judged.keys()) if (hour < ctx.now - JUDGED_MEMORY_MS) this.judged.delete(hour);

    return result.cells.length;
  }

  /**
   * The StdHr the hours of `range` that have ended keep, by hour start (see `judged`). Those this
   * collector has not computed since it started are read from their cells.
   */
  private async keptStdHr(range: HourRange, currentHour: number): Promise<Map<number, Map<StdKey, number | null>>> {
    const ended = hoursInRange(range).filter((hour) => hour < currentHour);
    const unread = ended.filter((hour) => !this.judged.has(hour));
    if (unread.length > 0) {
      const read = new Map(unread.map((hour) => [hour, new Map<StdKey, number | null>()]));
      const rows = await q<{ hour_start_utc: Date; product_number: string; operation: string; std_hr: string | null }>(
        this.pool,
        `SELECT DISTINCT c.hour_start_utc, c.product_number, o.name AS operation, c.std_hr
           FROM hour_cells c JOIN operations o ON o.id = c.operation_id
          WHERE c.hour_start_utc >= $1 AND c.hour_start_utc < $2`,
        [new Date(unread[0] as number), new Date((unread[unread.length - 1] as number) + HOUR_MS)],
      );
      for (const row of rows) {
        const std = row.std_hr === null ? null : Number(row.std_hr);
        read.get(toMs(row.hour_start_utc) ?? 0)?.set(stdKey(row.product_number, row.operation), std);
      }
      for (const [hour, std] of read) this.judged.set(hour, std);
    }
    return new Map(ended.map((hour) => [hour, this.judged.get(hour) ?? new Map<StdKey, number | null>()]));
  }
}
