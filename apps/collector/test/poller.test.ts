import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
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

/** Serves fixed rows per entity set; a window pull (`lt` upper bound) on UnitSteps fails when asked. */
function fakeSource(rows: Record<string, Record<string, unknown>[]>, opts: { failLatePull: boolean }) {
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

function harness(rows: Record<string, Record<string, unknown>[]> = {}, opts = { failLatePull: false }) {
  const db = fakePool();
  const src = fakeSource(rows, opts);
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);
  return { poller, db, src };
}

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
