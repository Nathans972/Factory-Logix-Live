/**
 * Standards recompute (spec 7.1): nightly at `std_recompute_time` plant time and on demand.
 * Each (product, operation) is processed sequentially to bound memory.
 */
import { computeStandard, expandBreaks } from '@fld/engine';
import { pickEngineSettings, type MappingConfig, type Settings } from '@fld/shared';
import { bulkUpsert, q, type Pool } from '../db.js';
import type { Logger } from '../logger.js';
import type { OperationCache } from '../ingest/operations.js';
import { loadBreakDefs, loadShiftDefs, loadStepsForStandard } from './load.js';

const DAY_MS = 86_400_000;

export interface StandardsRunOptions {
  settings: Settings;
  mapping: MappingConfig | null;
  now: number;
  /** null = every (product, operation); otherwise restrict to this product. */
  productNumber?: string | null;
  /** Only recompute pairs that received rows after this instant (null = all). */
  since: number | null;
}

export interface StandardsRunResult {
  pairs: number;
  computed: number;
  durationMs: number;
}

interface TargetRow {
  product_number: string;
  operation_id: number;
}

export class StandardsRecomputer {
  constructor(
    private readonly pool: Pool,
    private readonly log: Logger,
    private readonly operations: OperationCache,
  ) {}

  private async targets(opts: StandardsRunOptions, lookbackStart: number): Promise<TargetRow[]> {
    const params: unknown[] = [new Date(lookbackStart)];
    let sql = `SELECT DISTINCT product_number, operation_id FROM unit_steps
                WHERE complete_ts IS NOT NULL AND complete_ts >= $1`;
    if (opts.productNumber) {
      params.push(opts.productNumber);
      sql += ` AND product_number = $${params.length}`;
    }
    if (opts.since !== null) {
      params.push(new Date(opts.since));
      sql += ` AND updated_at > $${params.length}`;
    }
    const rows = await q<Record<string, unknown>>(this.pool, sql, params);
    return rows.map((r) => ({ product_number: String(r.product_number), operation_id: Number(r.operation_id) }));
  }

  async run(opts: StandardsRunOptions): Promise<StandardsRunResult> {
    const started = Date.now();
    const { settings, now } = opts;
    const lookbackStart = now - settings.std_lookback_days * DAY_MS;
    const tz = settings.plant_timezone;

    await this.operations.preload();
    const targets = await this.targets(opts, lookbackStart);
    if (targets.length === 0) return { pairs: 0, computed: 0, durationMs: Date.now() - started };

    const [shifts, breakDefs, flStandards] = await Promise.all([
      loadShiftDefs(this.pool),
      loadBreakDefs(this.pool),
      q<Record<string, unknown>>(this.pool, 'SELECT product_number, operation_id, std_hr FROM fl_standards'),
    ]);
    const breaks = expandBreaks(breakDefs, shifts, lookbackStart, now, tz);
    const flByKey = new Map<string, number | null>();
    for (const row of flStandards) {
      flByKey.set(`${String(row.product_number)}\u0001${Number(row.operation_id)}`, row.std_hr === null ? null : Number(row.std_hr));
    }

    const engineSettings = pickEngineSettings(settings);
    const reworkMapped = Boolean(opts.mapping?.unit_steps.fields.rework_flag);
    let computed = 0;

    for (const target of targets) {
      const operation = this.operations.nameOf(target.operation_id);
      if (!operation) continue;
      const steps = await loadStepsForStandard(this.pool, {
        product_number: target.product_number,
        operation_id: target.operation_id,
        since: lookbackStart,
      });
      if (steps.length === 0) continue;

      const standard = computeStandard({
        product_number: target.product_number,
        operation,
        steps,
        breaks,
        settings: engineSettings,
        now,
        fl_std_hr: flByKey.get(`${target.product_number}\u0001${target.operation_id}`) ?? null,
        rework_flag_mapped: reworkMapped,
      });

      const row = [
        target.product_number,
        target.operation_id,
        standard.computed_std_hr,
        standard.median_minutes_per_unit,
        Math.trunc(standard.sample_units),
        Math.trunc(standard.sample_operators),
        standard.sample_from === null ? null : new Date(standard.sample_from),
        standard.sample_to === null ? null : new Date(standard.sample_to),
        new Date(standard.computed_at || now),
        standard.fallback_source,
        standard.fl_std_hr,
      ];
      const columns = [
        'product_number',
        'operation_id',
        'computed_std_hr',
        'median_minutes_per_unit',
        'sample_units',
        'sample_operators',
        'sample_from',
        'sample_to',
        'computed_at',
        'fallback_source',
        'fl_std_hr',
      ];
      await bulkUpsert(this.pool, {
        table: 'standards',
        columns,
        rows: [row],
        conflict: ['product_number', 'operation_id'],
        update: columns.slice(2),
      });
      await bulkUpsert(this.pool, { table: 'standards_history', columns, rows: [row], conflict: [] });
      computed += 1;
    }

    const durationMs = Date.now() - started;
    this.log.info({ pairs: targets.length, computed, durationMs }, 'standards recomputed');
    return { pairs: targets.length, computed, durationMs };
  }
}
