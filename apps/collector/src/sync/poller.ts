/**
 * Incremental polling (spec 4.5) with overlap, paging, late-data re-pulls and per-source
 * sync_state / sync_log bookkeeping. Data sources are polled sequentially to keep the load
 * on FactoryLogix flat.
 */
import type { DatasetMapping, DatasetName, MappingConfig, Settings } from '@fld/shared';
import type { Pool } from '../db.js';
import type { Logger } from '../logger.js';
import { buildNaturalKey, selectFieldsFor, type TimestampResolver } from '../mapping/extract.js';
import type { Ingestor } from '../ingest/datasets.js';
import type { Source } from '../sources/Source.js';
import { ODataError } from '../odata/client.js';
import { andAll, cmp, type LiteralValue } from '../odata/literals.js';
import { pullPages, type PullRequest, type PullSummary } from './paging.js';
import { finishSyncLog, loadSyncState, recordSyncFailure, recordSyncSuccess, startSyncLog } from './state.js';
import { WatermarkTracker, parseStoredWatermark, watermarkKindFromEdm, type WatermarkKind } from './watermark.js';

/** Polling order (spec 4.5): dimensions first so unit_steps can resolve product numbers. */
export const DATASET_ORDER: DatasetName[] = ['work_orders', 'unit_steps', 'defects', 'operators', 'routes', 'standards'];

/** Target field used as the primary timestamp when a data source has no watermark field. */
const PRIMARY_TIMESTAMP: Record<DatasetName, string[]> = {
  work_orders: ['modified_at', 'created_at'],
  unit_steps: ['complete_ts', 'start_ts'],
  defects: ['found_ts'],
  operators: [],
  routes: [],
  standards: [],
};

/** Data sources small enough to pull whole when they have no timestamp at all. */
const FULL_PULL_ALLOWED = new Set<DatasetName>(['work_orders', 'operators', 'routes', 'standards']);

const MAX_PAGES_INCREMENTAL = 200;
const MAX_PAGES_FULL = 20;
const MAX_PAGES_WINDOW = 1000;
const FIRST_RUN_LOOKBACK_MS = 2 * 3_600_000;
const HOUR_MS = 3_600_000;
const LATE_PULL_MAX_WAIT_MS = 6 * HOUR_MS;

/** Wait between late-data re-pulls: hourly, doubling after each further failure, capped at 6 h. */
export function latePullWaitMs(consecutiveFailures: number): number {
  const extra = Math.max(0, consecutiveFailures - 1);
  return Math.min(LATE_PULL_MAX_WAIT_MS, HOUR_MS * 2 ** Math.min(extra, 10));
}

/** HTTP statuses that mean FactoryLogix as a whole refused or could not serve the request. */
const SERVICE_DOWN_STATUS = new Set([401, 408, 429, 502, 503, 504]);

/**
 * True when FactoryLogix itself is down or refusing us: no usable answer (unreachable, timed
 * out, not an OData service), a refused login, or "busy". Anything else (a 400/500 for one
 * entity set, a row the ingest rejects) belongs to that data source alone.
 */
function isServiceDown(err: unknown): boolean {
  return err instanceof ODataError && (err.status === null || SERVICE_DOWN_STATUS.has(err.status));
}

export interface DatasetOutcome {
  dataset: DatasetName;
  rows: number;
  ingested: number;
  skipped: number;
  durationMs: number;
  error: string | null;
  /** The error says FactoryLogix itself is down, not just this data source (see `isServiceDown`). */
  serviceDown: boolean;
  truncated: boolean;
}

export interface PollOutcome {
  /** Every mapped data source succeeded. */
  ok: boolean;
  /** work_orders and unit_steps succeeded: the numbers are current even if an optional data source failed. */
  requiredOk: boolean;
  rows: number;
  touched: number[];
  error: string | null;
  datasets: DatasetOutcome[];
  durationMs: number;
}

export interface PollerDeps {
  pool: Pool;
  log: Logger;
  ingestor: Ingestor;
  timestamps: TimestampResolver;
}

interface FieldPlan {
  /** Watermark field (source name) or null. */
  watermarkField: string | null;
  watermarkKind: WatermarkKind;
  /** Primary timestamp field (source name) used for window mode. */
  timestampField: string | null;
}

/** The field a pull is filtered and ordered on, for `Poller.pullOrdered`. */
interface PullOrder {
  /** Source field name and how its values compare. */
  field: string;
  kind: WatermarkKind;
  /** Timestamps after this do not count (see `WatermarkTracker`); null: no limit. */
  notAfter: number | null;
  /** The pull's sync source (`work_orders`, `unit_steps:late`, ...), for the logs and the timestamp cursor. */
  source: string;
  /** `$filter` for the rows from a watermark value on, as `WatermarkTracker.serialize` writes it. */
  filterFrom: (watermark: string) => string | null;
}

/** Where an ordered pull stopped at the page cap, for the next poll to go on from (see `Poller.pullOrdered`). */
interface ResumePoint {
  /** The `$filter` of the pass that stopped: the next poll asks for the same rows. */
  filter: string | null;
  /** `$skip` to go on from: a page before where the pass stopped. */
  skip: number;
  /** The last row the pass read (natural key and raw `field` value), to be found again. */
  key: string;
  value: string;
}

export class Poller {
  private source: Source;
  /**
   * Where the full pull of a data source with no watermark or timestamp stopped at the page cap.
   * The next poll goes on from there and starts over at the top once it has reached the end, so
   * a data source longer than the cap is read across successive polls instead of its first rows
   * over and over. In memory only: after a restart the pass starts again from the top.
   */
  private readonly fullPullCursors = new Map<DatasetName, { entitySet: string; skip: number }>();
  /**
   * Where the ordered pull of a data source stopped at the page cap. The next poll goes on from
   * there instead of from its watermark, as long as that watermark is still the one stored after
   * that pull: when more rows than the cap holds fall inside the overlap (a bulk update giving
   * every row one ModifiedDate), polling from the watermark would read the same rows every time
   * and never get past them. In memory only: after a restart the poll reads from its watermark.
   */
  private readonly resumePoints = new Map<DatasetName, { entitySet: string; field: string; watermark: string | null; point: ResumePoint }>();

  constructor(
    private readonly deps: PollerDeps,
    source: Source,
  ) {
    this.source = source;
  }

  setSource(source: Source): void {
    if (source !== this.source) {
      this.fullPullCursors.clear();
      this.resumePoints.clear();
    }
    this.source = source;
  }

  private plan(dataset: DatasetName, mapping: DatasetMapping, storedWatermark: string | null = null): FieldPlan {
    const watermarkField = mapping.watermark_field ?? null;
    let watermarkKind: WatermarkKind = 'timestamp';
    if (watermarkField) {
      const fromMetadata = watermarkKindFromEdm(this.source.edmType(mapping.entity_set, watermarkField));
      // Without $metadata, fall back to what the persisted watermark looks like.
      watermarkKind = fromMetadata ?? (storedWatermark && /^\d+$/.test(storedWatermark) ? 'number' : 'timestamp');
    }
    let timestampField: string | null = null;
    for (const target of PRIMARY_TIMESTAMP[dataset] ?? []) {
      const src = mapping.fields[target];
      if (src) {
        timestampField = src;
        break;
      }
    }
    return { watermarkField, watermarkKind, timestampField };
  }

  /**
   * The persisted timestamp watermark to poll from. Values after the poll time never count (see
   * `WatermarkTracker`), so a watermark ahead of the poll time was stored before that rule (a row
   * stamped in the future) or the clock went back. Polling from it would skip every new row, and
   * since a watermark never moves backwards it would stay; the start of the first-run lookback
   * replaces it.
   */
  private usableStoredMs(dataset: DatasetName, storedMs: number | null, now: number): number | null {
    if (storedMs === null || storedMs <= now) return storedMs;
    const restart = now - FIRST_RUN_LOOKBACK_MS;
    this.deps.log.warn(
      { dataset, watermark: new Date(storedMs).toISOString(), restart_from: new Date(restart).toISOString() },
      'stored watermark is ahead of the poll time; polling again from the first-run lookback',
    );
    return restart;
  }

  /**
   * One full pass over every mapped data source, in order. A data source that fails is recorded
   * in its own sync_state / sync_log row and the pass goes on with the next one, unless
   * FactoryLogix itself is down.
   */
  async pollOnce(mapping: MappingConfig, settings: Settings, now: number): Promise<PollOutcome> {
    const started = Date.now();
    const outcome: PollOutcome = { ok: true, requiredOk: false, rows: 0, touched: [], error: null, datasets: [], durationMs: 0 };
    const succeeded = new Set<DatasetName>();

    for (const dataset of DATASET_ORDER) {
      const datasetMapping = mapping[dataset];
      if (!datasetMapping) continue;
      if (dataset === 'unit_steps' && !succeeded.has('work_orders')) {
        // unit_steps finds products through the work orders: without this cycle's, the steps of
        // new jobs would be skipped while its watermark moves past them. It catches up from its
        // watermark once work_orders is back.
        this.deps.log.warn({ dataset }, 'work_orders failed; unit_steps waits until it is back');
        continue;
      }
      const result = await this.pollDataset(dataset, datasetMapping, settings, now, outcome.touched);
      outcome.datasets.push(result);
      outcome.rows += result.rows;
      if (!result.error) {
        succeeded.add(dataset);
        continue;
      }
      outcome.ok = false;
      outcome.error = outcome.error ?? `${dataset}: ${result.error}`;
      // Once anything came back this cycle FactoryLogix is up, and a failure belongs to that data
      // source. Before that, a failure that says the service itself is down ends the cycle: the
      // service is unhappy, stop hammering it.
      if (result.serviceDown && succeeded.size === 0) break;
    }
    outcome.requiredOk = succeeded.has('work_orders') && succeeded.has('unit_steps');

    try {
      await this.latePullIfDue(mapping, settings, now, outcome.touched, succeeded);
    } catch (err) {
      this.deps.log.warn({ err }, 'late-data re-pull failed');
    }

    outcome.durationMs = Date.now() - started;
    return outcome;
  }

  private async pollDataset(
    dataset: DatasetName,
    mapping: DatasetMapping,
    settings: Settings,
    now: number,
    touched: number[],
  ): Promise<DatasetOutcome> {
    const started = Date.now();
    const out: DatasetOutcome = { dataset, rows: 0, ingested: 0, skipped: 0, durationMs: 0, error: null, serviceDown: false, truncated: false };
    const logId = await startSyncLog(this.deps.pool, dataset);
    const state = await loadSyncState(this.deps.pool, dataset);
    const plan = this.plan(dataset, mapping, state?.watermark ?? null);

    try {
      const overlapMs = settings.poll_overlap_minutes * 60_000;
      let filter: string | null = null;
      let orderBy: string | null = null;
      let maxPages = MAX_PAGES_INCREMENTAL;
      let trackField: string | null = null;
      let trackKind: WatermarkKind = plan.watermarkKind;
      /** Full pull only: the `$skip` this poll starts from (see `fullPullCursors`). */
      let fullPullSkip: number | null = null;

      const stored = parseStoredWatermark(state?.watermark ?? null, plan.watermarkKind);
      /** The timestamp the persisted watermark represents, whichever mode produced it. */
      let storedMs: number | null = null;
      /** The persisted watermark was ahead of the poll time and `storedMs` replaces it. */
      let replaceStored = false;
      const useWatermark =
        plan.watermarkField !== null && (plan.watermarkKind !== 'number' || stored.numeric !== null || plan.timestampField === null);

      if (useWatermark && plan.watermarkField) {
        trackField = plan.watermarkField;
        orderBy = `${plan.watermarkField} asc`;
        if (plan.watermarkKind === 'timestamp') {
          storedMs = this.usableStoredMs(dataset, stored.ms, now);
          replaceStored = storedMs !== stored.ms;
          const since = (storedMs ?? now - FIRST_RUN_LOOKBACK_MS) - overlapMs;
          filter = cmp(
            plan.watermarkField,
            'ge',
            this.source.literal(mapping.entity_set, plan.watermarkField, { kind: 'timestamp', ms: since, lowerBound: true }),
          );
        } else if (plan.watermarkKind === 'number' && stored.numeric !== null) {
          filter = cmp(
            plan.watermarkField,
            'ge',
            this.source.literal(mapping.entity_set, plan.watermarkField, { kind: 'number', value: stored.numeric }),
          );
        } else if (stored.text) {
          filter = cmp(plan.watermarkField, 'ge', this.source.literal(mapping.entity_set, plan.watermarkField, { kind: 'string', value: stored.text }));
        }
      } else if (plan.timestampField) {
        trackField = plan.timestampField;
        trackKind = 'timestamp';
        orderBy = `${plan.timestampField} asc`;
        // Window mode always persists an ISO timestamp, even when the mapped watermark is an id.
        const persistedMs = parseStoredWatermark(state?.watermark ?? null, 'timestamp').ms;
        storedMs = this.usableStoredMs(dataset, persistedMs, now);
        replaceStored = storedMs !== persistedMs;
        const since = (storedMs ?? now - FIRST_RUN_LOOKBACK_MS) - overlapMs;
        filter = cmp(
          plan.timestampField,
          'ge',
          this.source.literal(mapping.entity_set, plan.timestampField, { kind: 'timestamp', ms: since, lowerBound: true }),
        );
      } else {
        if (!FULL_PULL_ALLOWED.has(dataset)) {
          throw new Error(`${dataset} has neither a watermark field nor a primary timestamp; refusing an unbounded pull`);
        }
        maxPages = MAX_PAGES_FULL;
        const cursor = this.fullPullCursors.get(dataset);
        fullPullSkip = cursor && cursor.entitySet === mapping.entity_set ? cursor.skip : 0;
        this.deps.log.warn(
          { dataset, entity_set: mapping.entity_set, from_row: fullPullSkip },
          'no watermark or timestamp mapped; pulling the whole data source',
        );
      }

      const select = selectFieldsFor(mapping, [plan.watermarkField, plan.timestampField]);
      this.deps.timestamps.setReadTime(now);

      const pull: PullRequest = {
        entitySet: mapping.entity_set,
        filter,
        orderBy,
        select,
        pageSize: settings.poll_page_size,
        maxPages,
        startSkip: fullPullSkip ?? 0,
      };
      const ingest = async (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return;
        const ingested = await this.deps.ingestor.ingest(dataset, rows);
        out.ingested += ingested.ingested;
        out.skipped += ingested.skipped;
        touched.push(...ingested.touched);
      };
      const field = trackField;
      const kind = trackKind;
      // Where the last poll stopped at the page cap, while the watermark it stored is still there.
      const saved = this.resumePoints.get(dataset);
      this.resumePoints.delete(dataset);
      const resume =
        saved && saved.entitySet === mapping.entity_set && saved.field === field && saved.watermark === (state?.watermark ?? null)
          ? saved.point
          : null;
      if (resume) this.deps.log.info({ dataset, from_row: resume.skip }, 'going on where the last poll stopped at the page cap');
      const summary = field
        ? await this.pullOrdered(
            mapping.key,
            pull,
            {
              field,
              kind,
              notAfter: now,
              source: dataset,
              filterFrom: (value) => this.watermarkFilter(mapping.entity_set, field, kind, value),
            },
            ingest,
            resume,
          )
        : { ...(await pullPages(this.source, pull, ingest)), watermark: null, resume: null };

      out.rows = summary.rows;
      out.truncated = summary.truncated;
      // No watermark moves a full pull on: the next poll goes on where this one stopped.
      if (fullPullSkip === null || summary.nextSkip === null) this.fullPullCursors.delete(dataset);
      else this.fullPullCursors.set(dataset, { entitySet: mapping.entity_set, skip: summary.nextSkip });
      if (summary.truncated) {
        this.deps.log.warn({ dataset, pages: summary.pages }, 'page cap reached; the rest arrives on the next poll');
      }

      out.durationMs = Date.now() - started;
      // The overlap re-pull can return only old rows; never let the watermark move backwards.
      let watermark = summary.watermark;
      const watermarkMs = trackKind === 'timestamp' ? parseStoredWatermark(watermark, 'timestamp').ms : null;
      if (watermarkMs !== null && storedMs !== null && watermarkMs < storedMs) watermark = null;
      // A watermark that was ahead of the poll time is replaced even when nothing newer came in.
      if (watermark === null && replaceStored && storedMs !== null) watermark = new Date(storedMs).toISOString();
      await recordSyncSuccess(this.deps.pool, dataset, {
        watermark,
        rows: out.rows,
        durationMs: out.durationMs,
      });
      if (field && summary.resume) {
        this.resumePoints.set(dataset, { entitySet: mapping.entity_set, field, watermark: watermark ?? state?.watermark ?? null, point: summary.resume });
      }
      await finishSyncLog(this.deps.pool, logId, { status: 'ok', rows: out.rows, ingested: out.ingested, skipped: out.skipped });
    } catch (err) {
      out.durationMs = Date.now() - started;
      out.error = err instanceof Error ? err.message : String(err);
      out.serviceDown = isServiceDown(err);
      await recordSyncFailure(this.deps.pool, dataset, out.error, out.durationMs);
      await finishSyncLog(this.deps.pool, logId, {
        status: 'error',
        rows: out.rows,
        ingested: out.ingested,
        skipped: out.skipped,
        error: out.error,
      });
      this.deps.log.error({ dataset, err: out.error }, 'poll failed');
    }
    return out;
  }

  /**
   * `pullPages` in the order of one field, read again where rows moved. FactoryLogix answers each
   * page request from the table as it is at that moment. A row read on one page that changes
   * before the next page is requested moves to the end of the order, every row behind its old
   * place moves up one, and the next `$skip` steps over a row. That row is behind the watermark
   * the pull ends with, so no later poll reads it. The changed row comes back on a later page of
   * the same pull (same natural key, another `field` value; a row inserted ahead instead brings
   * the last one read back unchanged, and nothing is lost); when one does, the pull reads again
   * from the watermark at the end of the page it was first read on, with no overlap, until a pass
   * gets through with nothing moving. The watermark is that pass's. If rows are still moving when
   * the page cap is reached, or the place to read again from has not moved on, the watermark stops
   * there and the next poll reads on from it.
   *
   * A pass that reaches the page cap with nothing moving says where it stopped (`resume`), and the
   * next poll goes on from there: the same `$filter`, from a page before that `$skip`. Rows read
   * before that point that changed since have moved to the end, and the rows behind them have
   * moved up, so the resumed pull first looks for the last row the pass read. Found unchanged
   * within the first two pages, nothing behind it is stepped over; otherwise (more than a page of
   * rows ahead of it changed, or that row did) the pull reads again from the start of `req`.
   */
  private async pullOrdered(
    keyFields: string[],
    req: PullRequest,
    order: PullOrder,
    onRows: (rows: Record<string, unknown>[]) => Promise<void>,
    resume: ResumePoint | null = null,
  ): Promise<PullSummary & { watermark: string | null; resume: ResumePoint | null }> {
    let filter = resume ? resume.filter : (req.filter ?? null);
    let skip = resume?.skip ?? 0;
    /** The row a resumed pull must find again before it reads on; null once found. */
    let anchor: { key: string; value: string } | null = resume;
    let rows = 0;
    let pages = 0;
    /** The watermark this pass reads from; null for the first pass. */
    let from: string | null = null;
    for (;;) {
      const tracker = new WatermarkTracker(order.kind, this.deps.timestamps, order.source, order.notAfter);
      /** Where each row was first read in this pass (page and `field` value), by natural key. */
      const firstRead = new Map<string, { page: number; value: string }>();
      /** The watermark at the end of each page of this pass. */
      const pageEnds: (string | null)[] = [];
      /** The earliest page a row that came back changed on a later page was first read on. */
      let movedFrom = Number.POSITIVE_INFINITY;
      /** Rows read while looking for `anchor`. */
      let searched = 0;
      /** The last row this pass read, for the next poll to find again. */
      let last = null as { key: string; value: string } | null;
      const summary = await pullPages(this.source, { ...req, filter, startSkip: skip, maxPages: req.maxPages - pages }, async (batch, page) => {
        for (const row of batch) {
          tracker.observe(row[order.field]);
          const key = buildNaturalKey(row, keyFields);
          const value = String(row[order.field]);
          if (anchor) {
            if (key === anchor.key && value === anchor.value) anchor = null;
            else searched += 1;
          }
          // A key whose fields are all empty identifies nothing.
          if (!/[^|]/.test(key)) continue;
          last = { key, value };
          const first = firstRead.get(key);
          if (first === undefined) firstRead.set(key, { page, value });
          else if (first.page < page && first.value !== value) movedFrom = Math.min(movedFrom, first.page);
        }
        if (anchor && searched >= 2 * req.pageSize) return false;
        pageEnds[page] = tracker.serialize();
        await onRows(batch);
      });
      rows += summary.rows;
      pages += summary.pages;

      if (anchor) {
        this.deps.log.warn({ source: order.source }, 'rows moved since the last poll stopped at the page cap; reading again from the watermark');
        anchor = null;
        filter = req.filter ?? null;
        skip = 0;
        continue;
      }
      const again = pageEnds[movedFrom] ?? null;
      if (again === null) {
        const stopped =
          summary.truncated && summary.nextSkip !== null && last
            ? { filter, skip: Math.max(0, summary.nextSkip - req.pageSize), ...last }
            : null;
        return { ...summary, rows, pages, watermark: tracker.serialize(), resume: stopped };
      }
      if (again === from || pages >= req.maxPages) {
        this.deps.log.warn({ source: order.source, from: again }, 'rows kept moving during the pull; the next poll reads again from where they were');
        return { ...summary, rows, pages, watermark: again, resume: null };
      }
      this.deps.log.info({ source: order.source, from: again }, 'rows moved during the pull; reading again from where they were');
      from = again;
      filter = order.filterFrom(again);
      skip = 0;
    }
  }

  /** `field ge <value>` for a watermark value as `WatermarkTracker.serialize` writes it. */
  private watermarkFilter(entitySet: string, field: string, kind: WatermarkKind, value: string): string {
    const parsed = parseStoredWatermark(value, kind);
    let literal: LiteralValue = { kind: 'string', value };
    if (parsed.ms !== null) literal = { kind: 'timestamp', ms: parsed.ms, lowerBound: true };
    else if (parsed.numeric !== null) literal = { kind: 'number', value: parsed.numeric };
    return cmp(field, 'ge', this.source.literal(entitySet, field, literal));
  }

  /**
   * Once per hour re-pull the last `late_data_hours` of unit_steps and defects so that late
   * updates (defect closed later, unit reworked) are not missed (spec 4.5).
   *
   * The `late_data` watermark is the last attempt, successful or not. A failure is recorded in
   * sync_state('late_data') and backs off (see `latePullWaitMs`); nothing is lost because every
   * re-pull covers the full window. It never fails the regular poll or feeds the main breaker.
   *
   * Only the data sources that came in this cycle (`polledOk`) are re-pulled: one that just
   * failed would fail again, and it catches up from its own watermark once it is back.
   */
  private async latePullIfDue(
    mapping: MappingConfig,
    settings: Settings,
    now: number,
    touched: number[],
    polledOk: ReadonlySet<DatasetName>,
  ): Promise<void> {
    if (settings.late_data_hours <= 0) return;
    const datasets = (['unit_steps', 'defects'] as const).filter((dataset) => polledOk.has(dataset));
    if (datasets.length === 0) return;
    const state = await loadSyncState(this.deps.pool, 'late_data');
    const last = state?.watermark ? Date.parse(state.watermark) : null;
    if (last !== null && !Number.isNaN(last) && now - last < latePullWaitMs(state?.consecutive_failures ?? 0)) return;

    const started = Date.now();
    let rows = 0;
    try {
      for (const dataset of datasets) {
        const datasetMapping = mapping[dataset];
        if (!datasetMapping) continue;
        const result = await this.pullWindow(dataset, datasetMapping, settings, {
          from: now - settings.late_data_hours * HOUR_MS,
          to: now + 60_000,
          now,
          logSource: `${dataset}:late`,
          touched,
        });
        rows += result.rows;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordSyncFailure(this.deps.pool, 'late_data', message, Date.now() - started, { watermark: new Date(now).toISOString() });
      const failures = (state?.consecutive_failures ?? 0) + 1;
      this.deps.log.warn(
        { err: message, failures, retry_in_minutes: latePullWaitMs(failures) / 60_000 },
        'late-data re-pull failed; backing off',
      );
      return;
    }
    await recordSyncSuccess(this.deps.pool, 'late_data', {
      watermark: new Date(now).toISOString(),
      rows,
      durationMs: Date.now() - started,
    });
    this.deps.log.info({ rows, hours: settings.late_data_hours }, 'late-data re-pull finished');
  }

  /**
   * Pull one time window on a data source's primary timestamp (used by the late-data re-pull
   * and by the backfill). A data source that carries no timestamp at all is pulled whole, under
   * the same page cap as a window: unlike a poll's full pull, no later pull goes on from where it
   * stopped. `to: null` leaves the window open at the end. `now` is the poll time when the window
   * reaches the present.
   */
  async pullWindow(
    dataset: DatasetName,
    mapping: DatasetMapping,
    settings: Settings,
    opts: { from: number; to: number | null; now?: number; logSource?: string; touched?: number[] },
  ): Promise<{ rows: number; ingested: number; skipped: number; truncated: boolean }> {
    const logSource = opts.logSource ?? `${dataset}:window`;
    const logId = await startSyncLog(this.deps.pool, logSource);
    const started = Date.now();
    const out = { rows: 0, ingested: 0, skipped: 0, truncated: false };
    const plan = this.plan(dataset, mapping);

    try {
      let filter: string | null = null;
      let orderBy: string | null = null;
      let order: PullOrder | null = null;

      if (plan.timestampField) {
        const field = plan.timestampField;
        const upTo = opts.to === null ? null : cmp(field, 'lt', this.source.literal(mapping.entity_set, field, { kind: 'timestamp', ms: opts.to }));
        filter = andAll([
          cmp(field, 'ge', this.source.literal(mapping.entity_set, field, { kind: 'timestamp', ms: opts.from, lowerBound: true })),
          upTo,
        ]);
        orderBy = `${field} asc`;
        order = {
          field,
          kind: 'timestamp',
          notAfter: opts.now ?? null,
          source: logSource,
          filterFrom: (value) => andAll([this.watermarkFilter(mapping.entity_set, field, 'timestamp', value), upTo]),
        };
      } else if (!FULL_PULL_ALLOWED.has(dataset)) {
        throw new Error(`${dataset} has no primary timestamp; cannot pull a time window`);
      }

      const select = selectFieldsFor(mapping, [plan.watermarkField, plan.timestampField]);
      this.deps.timestamps.setReadTime(opts.now ?? null);
      const pull: PullRequest = { entitySet: mapping.entity_set, filter, orderBy, select, pageSize: settings.poll_page_size, maxPages: MAX_PAGES_WINDOW };
      const ingest = async (rows: Record<string, unknown>[]) => {
        if (rows.length === 0) return;
        const ingested = await this.deps.ingestor.ingest(dataset, rows);
        out.ingested += ingested.ingested;
        out.skipped += ingested.skipped;
        if (opts.touched) opts.touched.push(...ingested.touched);
      };
      const summary = order ? await this.pullOrdered(mapping.key, pull, order, ingest) : await pullPages(this.source, pull, ingest);
      out.rows = summary.rows;
      out.truncated = summary.truncated;
      await finishSyncLog(this.deps.pool, logId, { status: 'ok', rows: out.rows, ingested: out.ingested, skipped: out.skipped });
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishSyncLog(this.deps.pool, logId, {
        status: 'error',
        rows: out.rows,
        ingested: out.ingested,
        skipped: out.skipped,
        error: message,
      });
      this.deps.log.error({ dataset, logSource, err: message, durationMs: Date.now() - started }, 'window pull failed');
      throw err;
    }
  }
}
