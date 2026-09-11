/**
 * Hour cell / defect cell recompute (spec 3.3, 7.3-7.7).
 * After every successful poll the hours touched by the ingested rows (plus the current and
 * previous hour) are recomputed from scratch inside a transaction and broadcast on
 * `fld_data_updated`.
 */
import {
  buildStandardsLookup,
  computeDefectHourCells,
  computeHourCells,
  expandBreaks,
  hourStartUtc,
} from '@fld/engine';
import { pickEngineSettings, type BreakDef, type Settings, type ShiftDef } from '@fld/shared';
import { bulkUpsert, exec, notify, tx, type Pool } from '../db.js';
import type { Logger } from '../logger.js';
import type { OperationCache } from '../ingest/operations.js';
import { HOUR_MS, mergeHourRanges, hoursInRange, type HourRange } from './hours.js';
import { loadAdjustments, loadBreakDefs, loadDefects, loadOverrides, loadPins, loadShiftDefs, loadStandards, loadUnitSteps } from './load.js';

export interface RecomputeResult {
  hours: number[];
  ranges: number;
  cells: number;
  durationMs: number;
}

export class Recomputer {
  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly operations: OperationCache,
  ) {}

  /** Recompute every hour bucket in `hourStarts` (merged into contiguous ranges). */
  async recomputeHours(hourStarts: Iterable<number>, settings: Settings, now: number, opts: { notify?: boolean } = {}): Promise<RecomputeResult> {
    const started = Date.now();
    const ranges = mergeHourRanges(hourStarts);
    if (ranges.length === 0) return { hours: [], ranges: 0, cells: 0, durationMs: 0 };

    const [shifts, breakDefs, standards, adjustments, overrides, pins] = await Promise.all([
      loadShiftDefs(this.pool),
      loadBreakDefs(this.pool),
      loadStandards(this.pool),
      loadAdjustments(this.pool),
      loadOverrides(this.pool),
      loadPins(this.pool),
    ]);

    const hours: number[] = [];
    let cells = 0;
    for (const range of ranges) {
      cells += await this.recomputeRange(range, { settings, now, shifts, breakDefs, standards, adjustments, overrides, pins });
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
    },
  ): Promise<number> {
    const tz = ctx.settings.plant_timezone;
    const engineSettings = pickEngineSettings(ctx.settings);
    const lookbackMs = Math.max(3 * HOUR_MS, ctx.settings.idle_timeout_minutes * 60_000 + HOUR_MS);

    const [steps, defects] = await Promise.all([
      loadUnitSteps(this.pool, { from: range.from, to: range.to, lookbackMs }),
      loadDefects(this.pool, range.from, range.to),
    ]);

    const breaks = expandBreaks(ctx.breakDefs, ctx.shifts, range.from - lookbackMs, range.to, tz);
    const extraKeys = [...new Set(steps.map((s) => `${s.product_number}\u0001${s.operation}`))].map((key) => {
      const [product_number, operation] = key.split('\u0001');
      return { product_number: product_number as string, operation: operation as string };
    });
    const lookup = buildStandardsLookup(ctx.standards, ctx.adjustments, ctx.overrides, extraKeys);

    const result = computeHourCells({
      steps,
      breaks,
      standards: lookup,
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

    const currentHour = hourStartUtc(ctx.now, tz);
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
        rows: result.cells
          .filter((cell) => operationIds.has(cell.operation))
          .map((cell) => [
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

    return result.cells.length;
  }
}
