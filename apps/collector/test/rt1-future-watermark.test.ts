/**
 * Red team (data integrity): one future-dated row moves the stored watermark ahead of real time.
 *
 * Poller.pollDataset persists the maximum value of the watermark field it saw, and the next poll asks
 * FactoryLogix for rows `>= watermark - overlap`. Nothing limits that maximum to "now". A single row
 * whose timestamp is in the future (a station or handheld with a wrong clock) therefore leaves the
 * watermark in the future, and every normal row after it is filtered out by FactoryLogix until real
 * time catches up. The guard against moving the watermark backwards makes it impossible to recover.
 *
 * The fake FactoryLogix below applies the `ge` / `lt` filter the collector sends, like the real
 * service does; the database is a small in-memory stand-in for sync_state, sync_log and operations.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

type Row = Record<string, unknown>;

function memoryDb() {
  const state = new Map<string, Row>();
  const operations = new Map<string, number>();
  const stepKeys: string[] = [];
  let logId = 0;
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.includes('FROM sync_state WHERE source')) {
      const found = state.get(params[0] as string);
      return ok(found ? [{ ...found }] : []);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_success_at')) {
      const [source, watermark] = params as [string, string | null];
      const previous = state.get(source) ?? {};
      state.set(source, { source, consecutive_failures: 0, ...previous, watermark: watermark ?? previous.watermark ?? null });
      return ok([], 1);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_error')) {
      const source = params[0] as string;
      const previous = state.get(source) ?? {};
      state.set(source, { source, ...previous, last_error: params[1], consecutive_failures: Number(previous.consecutive_failures ?? 0) + 1 });
      return ok([], 1);
    }
    if (text.startsWith('INSERT INTO sync_log')) return ok([{ id: (logId += 1) }]);
    if (text.startsWith('UPDATE sync_log')) return ok([], 1);
    if (text.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return ok();
    }
    if (text.startsWith('SELECT id, name FROM operations WHERE name = ANY')) {
      return ok((params[0] as string[]).filter((n) => operations.has(n)).map((name) => ({ id: operations.get(name), name })));
    }
    if (text.startsWith('INSERT INTO raw_event_hashes')) {
      const changed: Row[] = [];
      for (let i = 0; i < params.length; i += 3) changed.push({ source: params[i], natural_key: params[i + 1] });
      return ok(changed);
    }
    if (text.startsWith('INSERT INTO unit_steps')) {
      // unit_id, job_number, product_number, operation_id, operator_id, start_ts, complete_ts, result, rework_flag, fl_modified_at, natural_key
      for (let i = 0; i < params.length; i += 11) stepKeys.push(params[i + 10] as string);
      return ok([], params.length / 11);
    }
    return ok(); // every other statement succeeds and returns nothing
  };

  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, state, stepKeys };
}

/** Serves fixed rows per entity set and applies `field ge/lt <iso>` terms from $filter, as OData does. */
function factoryLogix(rows: Record<string, Row[]>) {
  const matches = (row: Row, filter: string | null | undefined): boolean => {
    if (!filter) return true;
    for (const term of filter.matchAll(/(\w+) (ge|gt|le|lt) (\S+?)\)?(?= and |$)/g)) {
      const [, field, op, literal] = term as unknown as [string, string, 'ge' | 'gt' | 'le' | 'lt', string];
      const left = Date.parse(String(row[field]));
      const right = Date.parse(literal.replace(/^\(+/, ''));
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      if (op === 'ge' && !(left >= right)) return false;
      if (op === 'gt' && !(left > right)) return false;
      if (op === 'le' && !(left <= right)) return false;
      if (op === 'lt' && !(left < right)) return false;
    }
    return true;
  };
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
    describe: () => '',
    fetchPage: async (req: SourceRequest) => {
      const all = (rows[req.entitySet] ?? []).filter((r) => matches(r, req.filter));
      const skip = req.skip ?? 0;
      return { rows: all.slice(skip, skip + (req.top ?? 500)), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, rows };
}

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'Modified',
    key: ['Job'],
    fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty', modified_at: 'Modified' },
  },
  unit_steps: {
    entity_set: 'UnitSteps',
    watermark_field: 'Done',
    key: ['StepId'],
    fields: { unit_id: 'Unit', job_number: 'Job', product_number: 'Product', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
  },
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC' }; // default 90 s poll, 10 min overlap, hourly 24 h late-data pull

const step = (id: string, done: string): Row => ({ StepId: id, Unit: `U-${id}`, Job: 'J-1', Product: 'P-1', Op: 'Weld', User: 'ann', Start: done.replace(/:\d\dZ$/, ':00Z'), Done: done });

function harness(steps: Row[]) {
  const db = memoryDb();
  const fl = factoryLogix({ UnitSteps: steps });
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, fl.source);
  return { db, fl, poller };
}

const T0 = Date.parse('2026-06-02T12:00:00Z');

describe('watermark after a row with a timestamp in the future', () => {
  it('control: a normal row completed a minute later is ingested by the next poll', async () => {
    const { db, fl, poller } = harness([step('S-1', '2026-06-02T11:58:00Z')]);
    expect((await poller.pollOnce(mapping, settings, T0)).ok).toBe(true);

    fl.rows.UnitSteps!.push(step('S-3', '2026-06-02T12:01:00Z'));
    expect((await poller.pollOnce(mapping, settings, T0 + 90_000)).ok).toBe(true);
    expect(db.stepKeys).toContain('S-3');
  });

  it('a handheld whose clock is a day ahead does not stop the next poll from seeing normal rows', async () => {
    const { db, fl, poller } = harness([step('S-1', '2026-06-02T11:58:00Z'), step('S-2', '2026-06-03T11:59:00Z')]);
    expect((await poller.pollOnce(mapping, settings, T0)).ok).toBe(true);

    // One minute later an ordinary step completes at a normal station.
    fl.rows.UnitSteps!.push(step('S-3', '2026-06-02T12:01:00Z'));
    const second = await poller.pollOnce(mapping, settings, T0 + 90_000);

    expect(second.ok).toBe(true);
    const watermark = Date.parse(String(db.state.get('unit_steps')?.watermark));
    expect.soft(db.stepKeys, 'S-3 was ingested by the poll that followed it').toContain('S-3');
    expect.soft(watermark, 'stored unit_steps watermark is not ahead of the poll time').toBeLessThanOrEqual(T0 + 90_000);
  });
});
