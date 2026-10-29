/**
 * Red team (data integrity): fixing the timestamp mode leaves the stored watermark in the future.
 *
 * The usual install-day correction. A plant east of UTC runs the default `offset_present` mode against
 * an OData v2 service (Edm.DateTime) that returns plant wall-clock time with no offset. The collector
 * reads 14:05 Berlin time as 14:05Z, two hours in the future, and stores that as the watermark.
 * docs/OPERATIONS.md ("Hour labels look shifted") then says to fix the timestamp mode. The collector
 * now reads 14:05 Berlin time as 12:05Z, but the stored watermark stays at 14:05Z, and the guard in
 * Poller.pollDataset that stops a watermark from moving backwards keeps it there. The next poll asks
 * FactoryLogix for `Done ge datetime'15:55:00'` (formatLiteral in local_no_offset mode), so rows that
 * finish in the next two hours are not fetched by the regular poll.
 *
 * The fake FactoryLogix applies the `datetime'...'` literal the collector sends. The literal is built
 * by the collector's own formatLiteral, with the mode and zone it was last given (ODataSource does the
 * same in setTimestampMode / literal). The database is an in-memory stand-in for sync_state,
 * sync_log and operations.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type FlTimestampMode, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { formatLiteral } from '../src/odata/literals.js';
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

/** An OData v2 service (Edm.DateTime) storing plant wall-clock time with no offset. */
function localClockFactoryLogix(rows: Row[]) {
  let timestampOpts: { mode: FlTimestampMode; timezone: string } = { mode: 'offset_present', timezone: 'Europe/Berlin' };
  const wallClock = (text: string): number => Date.parse(`${text.replace(/Z$/, '')}Z`); // the digits, compared as numbers
  const matches = (row: Row, filter?: string | null): boolean => {
    for (const term of (filter ?? '').matchAll(/(\w+) (ge|lt) datetime'([^']+)'/g)) {
      const [, field, op, literal] = term as unknown as [string, 'ge' | 'lt', string, string];
      const left = wallClock(String(row[field]));
      const right = wallClock(literal);
      if (op === 'ge' ? !(left >= right) : !(left < right)) return false;
    }
    return true;
  };
  const source: Source & { setTimestampMode(mode: FlTimestampMode, timezone: string): void } = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '2.0',
    edmType: () => 'Edm.DateTime',
    literal: (_set, _field, value) => formatLiteral(value, 'Edm.DateTime', '2.0', timestampOpts),
    describe: () => '',
    fetchPage: async (req: SourceRequest) => {
      const all = rows.filter((r) => matches(r, req.filter));
      const skip = req.skip ?? 0;
      return { rows: all.slice(skip, skip + (req.top ?? 500)), nextLink: null };
    },
    close: async () => undefined,
    setTimestampMode: (mode, timezone) => {
      timestampOpts = { mode, timezone };
    },
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

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'Europe/Berlin' }; // default 90 s poll, 10 min overlap, hourly 24 h late-data pull

/** A step finished at `done`, plant wall-clock time with no offset (the service's own format). */
const step = (id: string, done: string): Row => ({
  StepId: id,
  Unit: `U-${id}`,
  Job: 'J-1',
  Product: 'P-1',
  Op: 'Weld',
  User: 'ann',
  Start: done.replace(/:\d\d$/, ':00'),
  Done: done,
});

const POLL_1 = Date.parse('2026-06-02T12:10:00Z'); // 14:10 in Berlin (CEST)
const POLL_2 = POLL_1 + 4 * 60_000;

function harness(initialMode: FlTimestampMode) {
  const db = memoryDb();
  const fl = localClockFactoryLogix([step('S-1', '2026-06-02T14:05:00')]); // finished 12:05Z
  fl.source.setTimestampMode(initialMode, 'Europe/Berlin');
  const timestamps = new TimestampResolver({ mode: initialMode, timezone: 'Europe/Berlin' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, fl.source);
  /** What Collector.reloadConfig does after Admin > Connection is saved. */
  const applyMode = (mode: FlTimestampMode) => {
    timestamps.configure(mode, 'Europe/Berlin');
    fl.source.setTimestampMode(mode, 'Europe/Berlin');
  };
  return { db, fl, poller, applyMode };
}

describe('watermark after the timestamp mode is fixed for a plant east of UTC', () => {
  it('control: a plant that was on local_no_offset from the start sees the next row', async () => {
    const { db, fl, poller } = harness('local_no_offset');
    expect((await poller.pollOnce(mapping, settings, POLL_1)).ok).toBe(true);

    fl.rows.push(step('S-2', '2026-06-02T14:12:00')); // 12:12Z
    expect((await poller.pollOnce(mapping, settings, POLL_2)).ok).toBe(true);
    expect(db.stepKeys).toContain('S-2');
  });

  it('after the mode is fixed from the default, the next poll still sees rows finished after the fix', async () => {
    const { db, fl, poller, applyMode } = harness('offset_present');
    expect((await poller.pollOnce(mapping, settings, POLL_1)).ok).toBe(true);
    applyMode('local_no_offset'); // the documented fix: Admin > Connection, timestamp mode

    fl.rows.push(step('S-2', '2026-06-02T14:12:00')); // 12:12Z, four minutes after the first poll
    const second = await poller.pollOnce(mapping, settings, POLL_2);

    expect(second.ok).toBe(true);
    const watermark = Date.parse(String(db.state.get('unit_steps')?.watermark));
    expect.soft(db.stepKeys, 'S-2 was ingested by the poll that followed it').toContain('S-2');
    expect.soft(watermark, 'stored unit_steps watermark is not ahead of the poll time').toBeLessThanOrEqual(POLL_2);
  });
});
