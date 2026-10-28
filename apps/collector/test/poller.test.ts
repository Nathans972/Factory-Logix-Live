import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetMapping, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { ODataError } from '../src/odata/client.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller, latePullWaitMs } from '../src/sync/poller.js';

const HOUR = 3_600_000;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

interface StateRow {
  source: string;
  watermark: string | null;
  last_success_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  rows_last_poll: number | null;
  duration_ms_last_poll: number | null;
  backfill_progress: null;
}

/** sync_state + sync_log in memory; every other statement (ingest writes) succeeds with no rows. */
function fakePool() {
  const state = new Map<string, StateRow>();
  const log: { id: number; source: string; status?: string; rows?: number; ingested?: number; skipped?: number; error?: string | null }[] = [];
  const row = (source: string): StateRow =>
    state.get(source) ?? {
      source,
      watermark: null,
      last_success_at: null,
      last_error: null,
      consecutive_failures: 0,
      rows_last_poll: null,
      duration_ms_last_poll: null,
      backfill_progress: null,
    };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sync_state WHERE source')) {
        const found = state.get(params[0] as string);
        return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO sync_state (source, watermark, last_success_at')) {
        const [source, watermark] = params as [string, string | null];
        const r = row(source);
        state.set(source, { ...r, watermark: watermark ?? r.watermark, last_success_at: new Date(), last_error: null, consecutive_failures: 0 });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO sync_state (source, watermark, last_error')) {
        const [source, error, , watermark] = params as [string, string, number, string | null];
        const r = row(source);
        state.set(source, { ...r, watermark: watermark ?? r.watermark, last_error: error, consecutive_failures: r.consecutive_failures + 1 });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) {
        log.push({ id: log.length + 1, source: params[0] as string });
        return { rows: [{ id: log.length }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE sync_log')) {
        const entry = log.find((e) => e.id === params[0]);
        if (entry) {
          entry.rows = params[1] as number;
          entry.status = params[2] as string;
          entry.error = params[3] as string | null;
          entry.ingested = params[4] as number;
          entry.skipped = params[5] as number;
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: pool.query, release: () => undefined }),
  };
  return { pool: pool as unknown as Pool, state, log };
}

/**
 * Serves fixed rows per entity set; a window pull (`lt` upper bound) on UnitSteps fails when asked,
 * and the entity sets in `fail` throw their error.
 */
function fakeSource(rows: Record<string, Record<string, unknown>[]>, opts: { failLatePull?: boolean; fail?: Record<string, Error> }) {
  const requests: SourceRequest[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      const error = opts.fail?.[req.entitySet];
      if (error) throw error;
      if (opts.failLatePull && req.entitySet === 'UnitSteps' && / lt /.test(req.filter ?? '')) throw new Error('HTTP 503');
      return { rows: (req.skip ?? 0) === 0 ? (rows[req.entitySet] ?? []) : [], nextLink: null };
    },
    close: async () => undefined,
  };
  const latePulls = () => requests.filter((r) => r.entitySet === 'UnitSteps' && / lt /.test(r.filter ?? '')).length;
  return { source, requests, latePulls };
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
    watermark_field: null,
    key: ['Id'],
    fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
  },
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 24 };

function harness(
  rows: Record<string, Record<string, unknown>[]> = {},
  opts: { failLatePull?: boolean; fail?: Record<string, Error> } = {},
  map: MappingConfig = mapping,
) {
  const db = fakePool();
  const src = fakeSource(rows, opts);
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, map);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);
  return { poller, db, src };
}

describe('sync_log row counts', () => {
  it('logs ingested and skipped for every pull; a row missing a required field shows skipped = 1', async () => {
    const { poller, db } = harness({
      WorkOrders: [
        { Job: 'J-1', Product: 'P-1', Qty: 10, Modified: '2025-03-04T11:00:00Z' },
        { Job: 'J-2', Product: null, Qty: 5, Modified: '2025-03-04T11:01:00Z' },
      ],
    });
    const outcome = await poller.pollOnce(mapping, { ...settings, late_data_hours: 0 }, Date.parse('2025-03-04T12:00:00Z'));
    expect(outcome.ok).toBe(true);
    expect(db.log.find((e) => e.source === 'work_orders')).toMatchObject({ status: 'ok', rows: 2, ingested: 1, skipped: 1 });
    expect(db.log.find((e) => e.source === 'unit_steps')).toMatchObject({ status: 'ok', rows: 0, ingested: 0, skipped: 0 });
  });

  it('window pulls (late data, backfill) log the counts too', async () => {
    const { poller, db } = harness({ WorkOrders: [{ Job: 'J-1', Product: null, Modified: '2025-03-04T11:00:00Z' }] });
    await poller.pullWindow('work_orders', mapping.work_orders, settings, { from: 0, to: 1, logSource: 'work_orders:backfill' });
    expect(db.log).toEqual([expect.objectContaining({ source: 'work_orders:backfill', rows: 1, ingested: 0, skipped: 1 })]);
  });
});

describe('a watermark ahead of the poll time', () => {
  const t0 = Date.parse('2025-03-04T12:00:00Z');
  const quiet = { ...settings, late_data_hours: 0 };

  it('is never stored, for a watermark field (work_orders) or a time window (unit_steps); the row is still ingested', async () => {
    const { poller, db } = harness({
      WorkOrders: [
        { Job: 'J-1', Product: 'P-1', Qty: 10, Modified: '2025-03-04T11:58:00Z' },
        { Job: 'J-2', Product: 'P-1', Qty: 5, Modified: '9999-12-31T00:00:00Z' },
      ],
      UnitSteps: [
        { Id: 'S-1', Unit: 'U-1', Job: 'J-1', Op: 'Weld', User: 'ann', Start: '2025-03-04T11:50:00Z', Done: '2025-03-04T11:55:00Z' },
        { Id: 'S-2', Unit: 'U-2', Job: 'J-1', Op: 'Weld', User: 'ann', Start: '2025-03-05T11:50:00Z', Done: '2025-03-05T11:59:00Z' },
      ],
    });
    expect((await poller.pollOnce(mapping, quiet, t0)).ok).toBe(true);
    expect(db.state.get('work_orders')?.watermark).toBe('2025-03-04T11:58:00.000Z');
    expect(db.state.get('unit_steps')?.watermark).toBe('2025-03-04T11:55:00.000Z');
    expect(db.log.find((e) => e.source === 'work_orders')).toMatchObject({ status: 'ok', rows: 2, ingested: 2 });
  });

  it('already stored (a 9999-12-31 placeholder) is replaced, polling again from the first-run lookback', async () => {
    const { poller, db, src } = harness({ WorkOrders: [{ Job: 'J-1', Product: 'P-1', Qty: 10, Modified: '2025-03-04T11:58:00Z' }] });
    for (const source of ['work_orders', 'unit_steps']) {
      db.state.set(source, {
        source,
        watermark: '9999-12-31T00:00:00.000Z',
        last_success_at: null,
        last_error: null,
        consecutive_failures: 0,
        rows_last_poll: null,
        duration_ms_last_poll: null,
        backfill_progress: null,
      });
    }
    expect((await poller.pollOnce(mapping, quiet, t0)).ok).toBe(true);

    const since = new Date(t0 - 2 * HOUR - 10 * 60_000).toISOString();
    expect(src.requests.map((r) => r.filter)).toEqual([`Modified ge ${since}`, `Done ge ${since}`]);
    // work_orders moves to the row it saw; unit_steps saw nothing and keeps the lookback start.
    expect(db.state.get('work_orders')?.watermark).toBe('2025-03-04T11:58:00.000Z');
    expect(db.state.get('unit_steps')?.watermark).toBe(new Date(t0 - 2 * HOUR).toISOString());
  });
});

describe('late-data re-pull backoff', () => {
  it('waits an hour, then doubles after each further failure up to 6 hours', () => {
    expect(latePullWaitMs(0)).toBe(HOUR);
    expect(latePullWaitMs(1)).toBe(HOUR);
    expect(latePullWaitMs(2)).toBe(2 * HOUR);
    expect(latePullWaitMs(3)).toBe(4 * HOUR);
    expect(latePullWaitMs(4)).toBe(6 * HOUR);
    expect(latePullWaitMs(100)).toBe(6 * HOUR);
  });

  it('records a failing re-pull in sync_state and does not retry it on the next poll', async () => {
    const { poller, db, src } = harness({}, { failLatePull: true });
    const t0 = Date.parse('2025-03-04T12:00:00Z');

    const first = await poller.pollOnce(mapping, settings, t0);
    expect(first.ok).toBe(true);
    expect(src.latePulls()).toBe(1);
    expect(db.state.get('late_data')).toMatchObject({
      last_error: 'HTTP 503',
      consecutive_failures: 1,
      watermark: new Date(t0).toISOString(),
    });

    // The next regular poll (90 s later) stays ok and does not start the 24 h re-pull again.
    const second = await poller.pollOnce(mapping, settings, t0 + 90_000);
    expect(second.ok).toBe(true);
    expect(src.latePulls()).toBe(1);
    await poller.pollOnce(mapping, settings, t0 + HOUR - 1);
    expect(src.latePulls()).toBe(1);

    // An hour after the attempt it tries again; after a second failure it waits two hours.
    await poller.pollOnce(mapping, settings, t0 + HOUR);
    expect(src.latePulls()).toBe(2);
    expect(db.state.get('late_data')?.consecutive_failures).toBe(2);
    await poller.pollOnce(mapping, settings, t0 + 2 * HOUR);
    expect(src.latePulls()).toBe(2);
    await poller.pollOnce(mapping, settings, t0 + 3 * HOUR);
    expect(src.latePulls()).toBe(3);
  });

  it('clears the error once a re-pull succeeds', async () => {
    const { poller, db, src } = harness();
    const t0 = Date.parse('2025-03-04T12:00:00Z');
    db.state.set('late_data', {
      source: 'late_data',
      watermark: new Date(t0 - HOUR).toISOString(),
      last_success_at: null,
      last_error: 'HTTP 503',
      consecutive_failures: 1,
      rows_last_poll: null,
      duration_ms_last_poll: null,
      backfill_progress: null,
    });
    await poller.pollOnce(mapping, settings, t0);
    expect(src.latePulls()).toBe(1);
    expect(db.state.get('late_data')).toMatchObject({ last_error: null, consecutive_failures: 0, watermark: new Date(t0).toISOString() });
  });
});

describe('a failing data source', () => {
  const t0 = Date.parse('2025-03-04T12:00:00Z');
  const full = {
    ...mapping,
    defects: { entity_set: 'Defects', watermark_field: null, key: ['Id'], fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', found_ts: 'Found' } },
    operators: { entity_set: 'Operators', watermark_field: null, key: ['Id'], fields: { operator_id: 'Id', display_name: 'Name' } },
    routes: { entity_set: 'Routes', watermark_field: null, key: ['Id'], fields: { product_number: 'Product', operation: 'Op', sequence: 'Seq' } },
  } as unknown as MappingConfig;
  const url = 'http://fl:6065/odata/WorkOrders';
  const http = (status: number) => new ODataError(`OData request failed with HTTP ${status}`, { status, url, body: '' });
  const timeout = new ODataError('OData request timed out after 20s', { isTimeout: true, url });

  it('stops the cycle at the first data source when FactoryLogix itself is down', async () => {
    for (const error of [timeout, new ODataError('OData request failed: fetch failed', { url }), http(401), http(503)]) {
      const everySet = Object.fromEntries(['WorkOrders', 'UnitSteps', 'Defects', 'Operators', 'Routes'].map((set) => [set, error]));
      const { poller, src, db } = harness({}, { fail: everySet }, full);
      const outcome = await poller.pollOnce(full, settings, t0);
      expect(outcome).toMatchObject({ ok: false, requiredOk: false, error: `work_orders: ${error.message}` });
      // One request, not one per data source, and no late-data re-pull either.
      expect(src.requests.map((r) => r.entitySet)).toEqual(['WorkOrders']);
      expect(db.state.has('late_data')).toBe(false);
    }
  });

  it('polls the rest when work_orders fails on its own, but unit_steps waits for it', async () => {
    const { poller, src, db } = harness({}, { fail: { WorkOrders: http(500) } }, full);
    const outcome = await poller.pollOnce(full, settings, t0);
    expect(outcome).toMatchObject({ ok: false, requiredOk: false });
    expect(outcome.datasets.map((d) => d.dataset)).toEqual(['work_orders', 'defects', 'operators', 'routes']);
    // unit_steps is not asked (nor re-pulled), so its watermark stays where it was.
    expect(src.requests.some((r) => r.entitySet === 'UnitSteps')).toBe(false);
    expect(db.state.has('unit_steps')).toBe(false);
  });

  it('keeps the cycle current when an optional data source fails, even on a timeout', async () => {
    const { poller, src, db } = harness({}, { fail: { Defects: timeout } }, full);
    const outcome = await poller.pollOnce(full, settings, t0);
    expect(outcome).toMatchObject({ ok: false, requiredOk: true, error: `defects: ${timeout.message}` });
    expect(outcome.datasets.map((d) => d.dataset)).toEqual(['work_orders', 'unit_steps', 'defects', 'operators', 'routes']);
    // The hourly late-data re-pull still runs for unit_steps and counts as done; defects, which
    // just failed, is left out instead of failing it and backing it off.
    expect(src.latePulls()).toBe(1);
    expect(src.requests.filter((r) => r.entitySet === 'Defects')).toHaveLength(1);
    expect(db.state.get('late_data')).toMatchObject({ last_error: null, consecutive_failures: 0 });
  });
});

describe('a data source with no watermark or timestamp', () => {
  /** Honours $top/$skip over fixed rows, with no paging of its own. */
  function tableSource(tables: Record<string, Record<string, unknown>[]>) {
    const requests: SourceRequest[] = [];
    const source: Source = {
      kind: 'odata',
      init: async () => undefined,
      getMetadata: () => null,
      version: () => '4.0',
      edmType: () => null,
      literal: () => {
        throw new Error('a whole-data-source pull has no filter');
      },
      describe: () => '',
      fetchPage: async (req) => {
        requests.push(req);
        const skip = req.skip ?? 0;
        return { rows: (tables[req.entitySet] ?? []).slice(skip, skip + (req.top ?? Infinity)), nextLink: null };
      },
      close: async () => undefined,
    };
    return { source, requests };
  }
  const table = (count: number) => Array.from({ length: count }, (_, i) => ({ Part: `Z-${i}`, Op: 'SMT', Rate: 40, Job: `J-${i}` }));
  const ingestor = { ingest: async (_dataset: string, rows: unknown[]) => ({ received: rows.length, ingested: rows.length, skipped: 0, touched: [] }) };

  function pollerFor(source: Source) {
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    return new Poller({ pool: fakePool().pool, log, ingestor: ingestor as unknown as Ingestor, timestamps }, source);
  }

  it('goes on where the last poll stopped at the page cap and starts over at the top once it reached the end', async () => {
    const { source, requests } = tableSource({ StdA: table(12_000), StdB: table(12_000) });
    const poller = pollerFor(source);
    const standards = (entitySet: string) =>
      ({
        ...mapping,
        work_orders: null,
        unit_steps: null,
        standards: { entity_set: entitySet, watermark_field: null, key: ['Part', 'Op'], fields: { product_number: 'Part', operation: 'Op', std_hr: 'Rate' } },
      }) as unknown as MappingConfig;

    const polls: { from: number; rows: number }[] = [];
    for (const entitySet of ['StdA', 'StdA', 'StdA', 'StdB']) {
      const first = requests.length;
      const outcome = await poller.pollOnce(standards(entitySet), settings, Date.parse('2025-03-04T12:00:00Z'));
      expect(outcome.ok).toBe(true);
      polls.push({ from: requests[first]?.skip ?? 0, rows: outcome.rows });
    }
    // 20 pages of 500, the other 2,000 rows, the top again; another entity set starts at its top.
    expect(polls).toEqual([
      { from: 0, rows: 10_000 },
      { from: 10_000, rows: 2_000 },
      { from: 0, rows: 10_000 },
      { from: 0, rows: 10_000 },
    ]);
  });

  it('a backfill pulls the whole of work_orders, not the first 20 pages', async () => {
    const { source } = tableSource({ Jobs: table(12_000) });
    const workOrders: DatasetMapping = { entity_set: 'Jobs', watermark_field: null, key: ['Job'], fields: { job_number: 'Job', product_number: 'Part' } };
    const from = Date.parse('2025-03-01T00:00:00Z');

    const result = await pollerFor(source).pullWindow('work_orders', workOrders, settings, { from, to: from + 3 * 86_400_000, logSource: 'work_orders:backfill' });

    expect(result).toMatchObject({ rows: 12_000, truncated: false });
  });
});
