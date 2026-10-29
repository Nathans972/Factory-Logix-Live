import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { ODataError } from '../src/odata/client.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

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
  let logId = 0;
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
        logId += 1;
        return { rows: [{ id: logId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => ({ query: pool.query, release: () => undefined }),
  };
  return { pool: pool as unknown as Pool, state };
}

/** Serves fixed rows per entity set; entity sets listed in `broken` answer like a 500, or with `fail`. */
function fakeSource(
  rows: Record<string, Record<string, unknown>[]>,
  broken: string[],
  fail: () => Error = () => new Error('OData request failed with HTTP 500 Internal Server Error'),
) {
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
      if (broken.includes(req.entitySet)) throw fail();
      return { rows: (req.skip ?? 0) === 0 ? (rows[req.entitySet] ?? []) : [], nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
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
  defects: {
    entity_set: 'Defects',
    watermark_field: null,
    key: ['Id'],
    fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', found_ts: 'Found' },
  },
  operators: { entity_set: 'Operators', watermark_field: null, key: ['Id'], fields: { operator_id: 'Id', display_name: 'Name' } },
  routes: { entity_set: 'Routes', watermark_field: null, key: ['Id'], fields: { product_number: 'Product', operation: 'Op', sequence: 'Seq' } },
  standards: null,
} as unknown as MappingConfig;

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 24 };

const ROWS = {
  WorkOrders: [{ Job: 'J-1', Product: 'P-1', Qty: 10, Modified: '2025-03-04T11:58:00Z' }],
  UnitSteps: [{ Id: 1, Unit: 'U-1', Job: 'J-1', Op: 'Weld', User: 'jdoe', Start: '2025-03-04T11:50:00Z', Done: '2025-03-04T11:55:00Z' }],
  Operators: [{ Id: 'jdoe', Name: 'J Doe' }],
  Routes: [{ Product: 'P-1', Op: 'Weld', Seq: 10 }],
};

function harness(broken: string[], fail?: () => Error) {
  const db = fakePool();
  const src = fakeSource(ROWS, broken, fail);
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);
  const polled = (entitySet: string) => src.requests.some((r) => r.entitySet === entitySet);
  return { poller, db, src, polled };
}

describe('one failing data source', () => {
  const now = Date.parse('2025-03-04T12:00:00Z');

  it('control: with every data source healthy, all of them are polled', async () => {
    const { poller, polled } = harness([]);
    const outcome = await poller.pollOnce(mapping, settings, now);
    expect(outcome.ok).toBe(true);
    for (const set of ['WorkOrders', 'UnitSteps', 'Defects', 'Operators', 'Routes']) expect(polled(set)).toBe(true);
  });

  it('does not stop the independent data sources after it (operators, routes) from being polled', async () => {
    // FactoryLogix answers 500 for the Defects entity set only; Operators and Routes are fine.
    const { poller, polled, db } = harness(['Defects']);
    const outcome = await poller.pollOnce(mapping, settings, now);

    // The cycle as a whole may be reported as failed, but the work that can still be done must be done.
    expect(outcome.ok).toBe(false);
    expect(db.state.get('defects')?.consecutive_failures).toBe(1);
    expect(polled('Operators')).toBe(true);
    expect(polled('Routes')).toBe(true);
    expect(outcome.datasets.map((d) => d.dataset)).toEqual(['work_orders', 'unit_steps', 'defects', 'operators', 'routes']);
  });
});

describe('FactoryLogix refusing the login or the account', () => {
  const now = Date.parse('2025-03-04T12:00:00Z');
  const refuse = (status: 401 | 403) => () =>
    new ODataError(`OData request failed with HTTP ${status}`, { status, url: 'http://factorylogix.invalid/odata/x' });

  it('says so when nothing came back: a 401 ends the poll at its first request', async () => {
    const { poller, src } = harness(['WorkOrders', 'UnitSteps', 'Defects', 'Operators', 'Routes'], refuse(401));
    const outcome = await poller.pollOnce(mapping, settings, now);
    expect(outcome.loginRefused).toBe('work_orders: OData request failed with HTTP 401');
    expect(src.requests).toHaveLength(1);
  });

  it('says so for a 403 on every data source', async () => {
    const { poller } = harness(['WorkOrders', 'UnitSteps', 'Defects', 'Operators', 'Routes'], refuse(403));
    expect((await poller.pollOnce(mapping, settings, now)).loginRefused).toBe('work_orders: OData request failed with HTTP 403');
  });

  it('control: a 403 for one data source while others come back is that data source\'s error, not a refused login', async () => {
    const { poller } = harness(['Defects'], refuse(403));
    const outcome = await poller.pollOnce(mapping, settings, now);
    expect(outcome.requiredOk).toBe(true);
    expect(outcome.loginRefused).toBeNull();
    expect(outcome.error).toBe('defects: OData request failed with HTTP 403');
  });
});
