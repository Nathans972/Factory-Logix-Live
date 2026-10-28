/**
 * Per-dataset ingestion: mapped rows -> normalized tables (spec 4.4, 4.8, 6.1).
 * Every write is idempotent by natural key, so overlap re-pulls and backfill are harmless.
 */
import type { DatasetMapping, DatasetName, MappingConfig } from '@fld/shared';
import { bulkUpsert, q, q1, toMs, tx, type Pool, type PoolClient, type Queryable } from '../db.js';
import type { Logger } from '../logger.js';
import { extractRecord, num, str, bool, type TimestampResolver } from '../mapping/extract.js';
import { upsertOperators, upsertProducts, upsertRoutesDerived, upsertRoutesMapped, type RouteEntry } from './derive.js';
import { insertRawEvents } from './raw.js';
import type { OperationCache } from './operations.js';

export interface IngestOutcome {
  received: number;
  ingested: number;
  skipped: number;
  /** Instants whose hour buckets must be recomputed. */
  touched: number[];
}

const EMPTY: IngestOutcome = { received: 0, ingested: 0, skipped: 0, touched: [] };

/**
 * How far either side of a page's times `deleteMovedRows` looks for stale copies. Fixing the
 * timestamp mode or plant time zone moves a time by at most 26 hours. The bound keeps the delete
 * to the chunks around the page instead of every chunk of the hypertable, old compressed ones
 * included; a time corrected in FactoryLogix by more than this keeps its old copy.
 */
const MOVED_ROW_WINDOW_MS = 2 * 86_400_000;

export interface IngestorDeps {
  pool: Pool;
  log: Logger;
  operations: OperationCache;
  timestamps: TimestampResolver;
}

/** Fetches from FactoryLogix the work orders of `jobs` it has: raw rows of `mapping`'s entity set. */
export type WorkOrderFetcher = (jobs: string[], mapping: DatasetMapping) => Promise<Record<string, unknown>[]>;

export class Ingestor {
  private mapping: MappingConfig;
  private readonly jobProducts = new Map<string, string>();
  /** unit_steps.operation_seq arrives with migration 0002; tolerate it not being applied yet. */
  private operationSeqColumn: boolean | null = null;
  private operationSeqCheckedAt = 0;

  constructor(
    private readonly deps: IngestorDeps,
    mapping: MappingConfig,
  ) {
    this.mapping = mapping;
  }

  setMapping(mapping: MappingConfig): void {
    this.mapping = mapping;
    this.jobProducts.clear();
  }

  /**
   * Route a page of source rows to the right ingest routine. `fetchJobs` lets unit_steps fetch the
   * work orders of its jobs that are not in the database yet (see `fetchMissingJobs`).
   */
  async ingest(dataset: DatasetName, rows: Record<string, unknown>[], fetchJobs?: WorkOrderFetcher): Promise<IngestOutcome> {
    if (rows.length === 0) return { ...EMPTY };
    switch (dataset) {
      case 'work_orders':
        return this.workOrders(rows);
      case 'unit_steps':
        return this.unitSteps(rows, fetchJobs);
      case 'defects':
        return this.defects(rows);
      case 'operators':
        return this.operators(rows);
      case 'routes':
        return this.routes(rows);
      case 'standards':
        return this.standards(rows);
      default:
        return { ...EMPTY };
    }
  }

  private async hasOperationSeqColumn(db: PoolClient): Promise<boolean> {
    const now = Date.now();
    if (this.operationSeqColumn === true) return true;
    if (this.operationSeqColumn === false && now - this.operationSeqCheckedAt < 300_000) return false;
    const row = await q1(
      db,
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_name = 'unit_steps' AND column_name = 'operation_seq'`,
    );
    this.operationSeqColumn = row !== null;
    this.operationSeqCheckedAt = now;
    return this.operationSeqColumn;
  }

  private async lookupJobProducts(db: Queryable, jobNumbers: string[]): Promise<void> {
    const missing = jobNumbers.filter((j) => j && !this.jobProducts.has(j));
    if (missing.length === 0) return;
    const rows = await q<{ job_number: string; product_number: string }>(
      db,
      'SELECT job_number, product_number FROM work_orders WHERE job_number = ANY($1::text[])',
      [[...new Set(missing)]],
    );
    if (this.jobProducts.size > 50_000) this.jobProducts.clear();
    for (const row of rows) this.jobProducts.set(row.job_number, row.product_number);
  }

  /**
   * The work_orders poll reads the jobs changed since its watermark (on the first run, since the
   * start of the late-data window). A job still running that FactoryLogix has not changed since
   * then is not in the database until the backfill reaches it (never with `backfill_days` 0): it
   * is missing from the job lists, and the steps that take their product from the work order are
   * skipped every time they are read. Fetch the work orders of these jobs that are not in the
   * database, before the transaction that writes the steps.
   */
  private async fetchMissingJobs(jobs: string[], fetchJobs: WorkOrderFetcher): Promise<void> {
    const mapping = this.mapping.work_orders;
    if (!mapping || jobs.length === 0) return;
    await this.lookupJobProducts(this.deps.pool, jobs);
    const missing = [...new Set(jobs)].filter((job) => !this.jobProducts.has(job));
    if (missing.length === 0) return;
    const rows = await fetchJobs(missing, mapping);
    if (rows.length > 0) await this.workOrders(rows);
  }

  /**
   * tx() for the routines that resolve operation names on its client. A name seen for the first
   * time is inserted by that transaction and its id cached at once; if the transaction rolls back
   * the row is gone but the id stays cached, and every later write using it fails the operation_id
   * foreign key. Clear the cache then, as the restart command does, so the retry inserts it again.
   */
  private async txWithOperations(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    try {
      await tx(this.deps.pool, fn);
    } catch (err) {
      this.deps.operations.clear();
      throw err;
    }
  }

  private async workOrders(rows: Record<string, unknown>[]): Promise<IngestOutcome> {
    const mapping = this.mapping.work_orders;
    const { timestamps } = this.deps;
    const qtyCompleteMapped = Boolean(mapping.fields.qty_complete);
    const out: IngestOutcome = { received: rows.length, ingested: 0, skipped: 0, touched: [] };

    const products: { product_number: string; name: string | null }[] = [];
    const orders: unknown[][] = [];
    const raw: { source: string; natural_key: string; payload: unknown }[] = [];

    for (const row of rows) {
      const rec = extractRecord('work_orders', row, mapping, { timestamps });
      raw.push({ source: 'work_orders', natural_key: rec.natural_key, payload: row });
      const job = str(rec.values, 'job_number');
      const product = str(rec.values, 'product_number');
      if (!job || !product) {
        out.skipped += 1;
        continue;
      }
      const name = str(rec.values, 'product_name');
      products.push({ product_number: product, name });
      this.jobProducts.set(job, product);
      orders.push([
        job,
        product,
        name,
        Math.trunc(num(rec.values, 'qty_released') ?? 0),
        qtyCompleteMapped ? roundOrNull(num(rec.values, 'qty_complete')) : null,
        str(rec.values, 'status'),
        tsOrNull(num(rec.values, 'created_at')),
        tsOrNull(num(rec.values, 'modified_at')),
      ]);
      out.ingested += 1;
    }

    await tx(this.deps.pool, async (client) => {
      await upsertProducts(client, products);
      await bulkUpsert(client, {
        table: 'work_orders',
        columns: ['job_number', 'product_number', 'product_name', 'qty_released', 'qty_complete', 'status', 'fl_created_at', 'fl_modified_at'],
        rows: orders,
        conflict: ['job_number'],
        update: [
          'product_number',
          'product_name',
          'qty_released',
          ...(qtyCompleteMapped ? ['qty_complete'] : []),
          'status',
          'fl_created_at',
          'fl_modified_at',
        ],
        extraSet: ['updated_at = now()'],
        // Re-reads (overlap, late data, backfill) return mostly unchanged rows; leaving them alone
        // keeps updated_at meaning "last changed", which the nightly standards job relies on.
        onlyIfChanged: true,
      });
      await insertRawEvents(client, raw);
    });

    return out;
  }

  private async unitSteps(rows: Record<string, unknown>[], fetchJobs?: WorkOrderFetcher): Promise<IngestOutcome> {
    const mapping = this.mapping.unit_steps;
    const { timestamps } = this.deps;
    const routesMapped = this.mapping.routes !== null;
    const out: IngestOutcome = { received: rows.length, ingested: 0, skipped: 0, touched: [] };

    interface Staged {
      natural_key: string;
      unit_id: string;
      job_number: string;
      product_number: string | null;
      operation: string;
      operation_seq: number | null;
      operator_id: string;
      start_ts: number;
      complete_ts: number | null;
      result: string | null;
      rework_flag: boolean | null;
      modified_at: number | null;
    }

    const staged: Staged[] = [];
    const raw: { source: string; natural_key: string; payload: unknown }[] = [];

    for (const row of rows) {
      const rec = extractRecord('unit_steps', row, mapping, { timestamps });
      raw.push({ source: 'unit_steps', natural_key: rec.natural_key, payload: row });
      const unit = str(rec.values, 'unit_id');
      const job = str(rec.values, 'job_number');
      const operation = str(rec.values, 'operation');
      const operator = str(rec.values, 'operator');
      const start = num(rec.values, 'start_ts');
      if (!unit || !job || !operation || !operator || start === null) {
        out.skipped += 1;
        continue;
      }
      staged.push({
        natural_key: rec.natural_key,
        unit_id: unit,
        job_number: job,
        product_number: str(rec.values, 'product_number'),
        operation,
        operation_seq: num(rec.values, 'operation_seq'),
        operator_id: operator,
        start_ts: start,
        complete_ts: num(rec.values, 'complete_ts'),
        result: str(rec.values, 'result'),
        rework_flag: bool(rec.values, 'rework_flag'),
        modified_at: num(rec.values, 'modified_at'),
      });
    }

    if (fetchJobs) await this.fetchMissingJobs(staged.map((s) => s.job_number), fetchJobs);

    await this.txWithOperations(async (client) => {
      await this.lookupJobProducts(
        client,
        staged.filter((s) => !s.product_number).map((s) => s.job_number),
      );

      const operationIds = await this.deps.operations.resolveMany(
        staged.map((s) => s.operation),
        client,
      );
      const withSeq = await this.hasOperationSeqColumn(client);

      const stepRows: unknown[][] = [];
      const keys: StoredKey[] = [];
      const products: { product_number: string; name: string | null }[] = [];
      const operators: { operator_id: string; display_name: string | null }[] = [];
      const routes: RouteEntry[] = [];
      let unknownProduct = 0;

      for (const s of staged) {
        const product = s.product_number ?? this.jobProducts.get(s.job_number) ?? null;
        const operationId = operationIds.get(s.operation);
        if (!product || operationId === undefined) {
          if (!product) unknownProduct += 1;
          out.skipped += 1;
          continue;
        }
        const stepRow: unknown[] = [
          s.unit_id,
          s.job_number,
          product,
          operationId,
          s.operator_id,
          new Date(s.start_ts),
          s.complete_ts === null ? null : new Date(s.complete_ts),
          s.result,
          s.rework_flag,
          s.modified_at === null ? null : new Date(s.modified_at),
          s.natural_key,
        ];
        if (withSeq) stepRow.push(s.operation_seq === null ? null : Math.trunc(s.operation_seq));
        stepRows.push(stepRow);
        keys.push({ natural_key: s.natural_key, at: s.start_ts });
        products.push({ product_number: product, name: null });
        operators.push({ operator_id: s.operator_id, display_name: null });
        routes.push({ product_number: product, operation_id: operationId, sequence: s.operation_seq });
        out.touched.push(s.start_ts);
        if (s.complete_ts !== null) out.touched.push(s.complete_ts);
        out.ingested += 1;
      }

      if (unknownProduct > 0) {
        this.deps.log.warn(
          { rows: unknownProduct },
          'unit_steps rows skipped: product_number is not mapped and the work order is not ingested yet',
        );
      }

      await upsertProducts(client, products);
      await upsertOperators(client, operators);
      out.touched.push(...(await deleteMovedRows(client, 'unit_steps', 'start_ts', keys, ['start_ts', 'complete_ts'])));
      await bulkUpsert(client, {
        table: 'unit_steps',
        columns: [
          'unit_id',
          'job_number',
          'product_number',
          'operation_id',
          'operator_id',
          'start_ts',
          'complete_ts',
          'result',
          'rework_flag',
          'fl_modified_at',
          'natural_key',
          ...(withSeq ? ['operation_seq'] : []),
        ],
        rows: stepRows,
        conflict: ['natural_key', 'start_ts'],
        update: [
          'unit_id',
          'job_number',
          'product_number',
          'operation_id',
          'operator_id',
          'complete_ts',
          'result',
          'rework_flag',
          'fl_modified_at',
          ...(withSeq ? ['operation_seq'] : []),
        ],
        extraSet: ['updated_at = now()'],
        onlyIfChanged: true,
      });
      if (!routesMapped) await upsertRoutesDerived(client, routes);
      await insertRawEvents(client, raw);
    });

    return out;
  }

  private async defects(rows: Record<string, unknown>[]): Promise<IngestOutcome> {
    const mapping = this.mapping.defects;
    const out: IngestOutcome = { received: rows.length, ingested: 0, skipped: 0, touched: [] };
    if (!mapping) return out;
    const { timestamps } = this.deps;

    const staged: {
      natural_key: string;
      unit_id: string;
      job_number: string;
      operation: string;
      operator_id: string | null;
      defect_code: string | null;
      description: string | null;
      found_ts: number;
      status: string | null;
      modified_at: number | null;
    }[] = [];
    const raw: { source: string; natural_key: string; payload: unknown }[] = [];

    for (const row of rows) {
      const rec = extractRecord('defects', row, mapping, { timestamps });
      raw.push({ source: 'defects', natural_key: rec.natural_key, payload: row });
      const unit = str(rec.values, 'unit_id');
      const job = str(rec.values, 'job_number');
      const operation = str(rec.values, 'operation');
      const found = num(rec.values, 'found_ts');
      if (!unit || !job || !operation || found === null) {
        out.skipped += 1;
        continue;
      }
      staged.push({
        natural_key: rec.natural_key,
        unit_id: unit,
        job_number: job,
        operation,
        operator_id: str(rec.values, 'operator'),
        defect_code: str(rec.values, 'defect_code'),
        description: str(rec.values, 'description'),
        found_ts: found,
        status: str(rec.values, 'status'),
        modified_at: num(rec.values, 'modified_at'),
      });
    }

    await this.txWithOperations(async (client) => {
      const operationIds = await this.deps.operations.resolveMany(
        staged.map((s) => s.operation),
        client,
      );
      const defectRows: unknown[][] = [];
      const keys: StoredKey[] = [];
      const operators: { operator_id: string; display_name: string | null }[] = [];
      for (const s of staged) {
        const operationId = operationIds.get(s.operation);
        if (operationId === undefined) {
          out.skipped += 1;
          continue;
        }
        defectRows.push([
          s.unit_id,
          s.job_number,
          operationId,
          s.operator_id,
          s.defect_code,
          s.description,
          new Date(s.found_ts),
          s.status,
          s.modified_at === null ? null : new Date(s.modified_at),
          s.natural_key,
        ]);
        keys.push({ natural_key: s.natural_key, at: s.found_ts });
        if (s.operator_id) operators.push({ operator_id: s.operator_id, display_name: null });
        out.touched.push(s.found_ts);
        out.ingested += 1;
      }
      await upsertOperators(client, operators);
      out.touched.push(...(await deleteMovedRows(client, 'defects', 'found_ts', keys, ['found_ts'])));
      await bulkUpsert(client, {
        table: 'defects',
        columns: [
          'unit_id',
          'job_number',
          'operation_id',
          'operator_id',
          'defect_code',
          'description',
          'found_ts',
          'status',
          'fl_modified_at',
          'natural_key',
        ],
        rows: defectRows,
        conflict: ['natural_key', 'found_ts'],
        update: ['unit_id', 'job_number', 'operation_id', 'operator_id', 'defect_code', 'description', 'status', 'fl_modified_at'],
        extraSet: ['updated_at = now()'],
        onlyIfChanged: true,
      });
      await insertRawEvents(client, raw);
    });

    return out;
  }

  private async operators(rows: Record<string, unknown>[]): Promise<IngestOutcome> {
    const mapping = this.mapping.operators;
    const out: IngestOutcome = { received: rows.length, ingested: 0, skipped: 0, touched: [] };
    if (!mapping) return out;
    const { timestamps } = this.deps;

    const entries: { operator_id: string; display_name: string | null }[] = [];
    const raw: { source: string; natural_key: string; payload: unknown }[] = [];
    for (const row of rows) {
      const rec = extractRecord('operators', row, mapping, { timestamps });
      raw.push({ source: 'operators', natural_key: rec.natural_key, payload: row });
      const id = str(rec.values, 'operator_id');
      if (!id) {
        out.skipped += 1;
        continue;
      }
      entries.push({ operator_id: id, display_name: str(rec.values, 'display_name') });
      out.ingested += 1;
    }

    await tx(this.deps.pool, async (client) => {
      await upsertOperators(client, entries);
      await insertRawEvents(client, raw);
    });
    return out;
  }

  private async routes(rows: Record<string, unknown>[]): Promise<IngestOutcome> {
    const mapping = this.mapping.routes;
    const out: IngestOutcome = { received: rows.length, ingested: 0, skipped: 0, touched: [] };
    if (!mapping) return out;
    const { timestamps } = this.deps;

    const staged: { product_number: string; operation: string; sequence: number }[] = [];
    const raw: { source: string; natural_key: string; payload: unknown }[] = [];
    for (const row of rows) {
      const rec = extractRecord('routes', row, mapping, { timestamps });
      raw.push({ source: 'routes', natural_key: rec.natural_key, payload: row });
      const product = str(rec.values, 'product_number');
      const operation = str(rec.values, 'operation');
      const sequence = num(rec.values, 'sequence');
      if (!product || !operation || sequence === null) {
        out.skipped += 1;
        continue;
      }
      staged.push({ product_number: product, operation, sequence: Math.trunc(sequence) });
      out.ingested += 1;
    }

    await this.txWithOperations(async (client) => {
      const operationIds = await this.deps.operations.resolveMany(
        staged.map((s) => s.operation),
        client,
      );
      await upsertProducts(
        client,
        staged.map((s) => ({ product_number: s.product_number, name: null })),
      );
      await upsertRoutesMapped(
        client,
        staged
          .map((s) => ({ product_number: s.product_number, operation_id: operationIds.get(s.operation) ?? -1, sequence: s.sequence }))
          .filter((r) => r.operation_id > 0),
      );
      await insertRawEvents(client, raw);
    });
    return out;
  }

  private async standards(rows: Record<string, unknown>[]): Promise<IngestOutcome> {
    const mapping = this.mapping.standards;
    const out: IngestOutcome = { received: rows.length, ingested: 0, skipped: 0, touched: [] };
    if (!mapping) return out;
    const { timestamps } = this.deps;

    const staged: { product_number: string; operation: string; std_hr: number }[] = [];
    const raw: { source: string; natural_key: string; payload: unknown }[] = [];
    for (const row of rows) {
      const rec = extractRecord('standards', row, mapping, { timestamps });
      raw.push({ source: 'standards', natural_key: rec.natural_key, payload: row });
      const product = str(rec.values, 'product_number');
      const operation = str(rec.values, 'operation');
      const stdHr = num(rec.values, 'std_hr');
      if (!product || !operation || stdHr === null) {
        out.skipped += 1;
        continue;
      }
      staged.push({ product_number: product, operation, std_hr: stdHr });
      out.ingested += 1;
    }

    await this.txWithOperations(async (client) => {
      const operationIds = await this.deps.operations.resolveMany(
        staged.map((s) => s.operation),
        client,
      );
      await upsertProducts(
        client,
        staged.map((s) => ({ product_number: s.product_number, name: null })),
      );
      await bulkUpsert(client, {
        table: 'fl_standards',
        columns: ['product_number', 'operation_id', 'std_hr'],
        rows: staged
          .map((s) => [s.product_number, operationIds.get(s.operation) ?? -1, s.std_hr])
          .filter((r) => (r[1] as number) > 0),
        conflict: ['product_number', 'operation_id'],
        update: ['std_hr'],
        extraSet: ['ingested_at = now()'],
      });
      await insertRawEvents(client, raw);
    });
    return out;
  }
}

/** A row about to be upserted into unit_steps / defects: its natural key and its time column. */
interface StoredKey {
  natural_key: string;
  at: number;
}

/**
 * unit_steps and defects are hypertables, so the unique key the upsert relies on must include the
 * time column: (natural_key, start_ts / found_ts). A record read again with a different parsed
 * time (timestamp mode or plant time zone fixed, time corrected in FactoryLogix) does not conflict
 * with its stored row and would become a second one. Delete the stored copies of these keys at
 * other times (within MOVED_ROW_WINDOW_MS of the page) and return their `instants`, so the hours
 * they were counted in get recomputed.
 */
async function deleteMovedRows(
  db: PoolClient,
  table: 'unit_steps' | 'defects',
  time: 'start_ts' | 'found_ts',
  keys: StoredKey[],
  instants: string[],
): Promise<number[]> {
  // A key whose fields were all empty identifies nothing: leave those rows alone.
  const keyed = keys.filter((k) => /[^|]/.test(k.natural_key));
  if (keyed.length === 0) return [];
  const ats = keyed.map((k) => k.at);
  const deleted = await q<Record<string, Date | null>>(
    db,
    `DELETE FROM ${table}
      WHERE natural_key = ANY($1::text[]) AND ${time} BETWEEN $3 AND $4
        AND (natural_key, ${time}) NOT IN (SELECT * FROM unnest($1::text[], $2::timestamptz[]))
      RETURNING ${instants.join(', ')}`,
    [
      keyed.map((k) => k.natural_key),
      ats.map((at) => new Date(at)),
      new Date(Math.min(...ats) - MOVED_ROW_WINDOW_MS),
      new Date(Math.max(...ats) + MOVED_ROW_WINDOW_MS),
    ],
  );
  return deleted.flatMap((row) => instants.map((column) => toMs(row[column])).filter((ms): ms is number => ms !== null));
}

function tsOrNull(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.trunc(value);
}
