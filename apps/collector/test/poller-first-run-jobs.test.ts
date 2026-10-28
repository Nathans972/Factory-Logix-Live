import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = Record<string, unknown> & { at: number };

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/**
 * Just enough Postgres for the poller and the real Ingestor: sync_state, operations, the
 * work_orders product lookup, and the rows written to work_orders / unit_steps.
 */
function fakeDb() {
  const state = new Map<string, string | null>();
  const operations = new Map<string, number>();
  const workOrders = new Map<string, string>();
  const unitSteps: { unit_id: string; job_number: string }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    const none = { rows: [] as unknown[], rowCount: 0 };
    if (sql.includes('FROM sync_state WHERE source')) {
      const source = params[0] as string;
      if (!state.has(source)) return none;
      const row = {
        source,
        watermark: state.get(source) ?? null,
        last_success_at: null,
        last_error: null,
        consecutive_failures: 0,
        rows_last_poll: null,
        duration_ms_last_poll: null,
        backfill_progress: null,
      };
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO sync_state')) {
      const source = params[0] as string;
      const watermark = (sql.includes('last_success_at') ? params[1] : params[3]) as string | null;
      state.set(source, watermark ?? state.get(source) ?? null);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return none;
    }
    if (sql.startsWith('SELECT id, name FROM operations')) {
      const names = (params[0] as string[] | undefined) ?? [...operations.keys()];
      return { rows: names.filter((n) => operations.has(n)).map((n) => ({ id: operations.get(n), name: n })), rowCount: 1 };
    }
    if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.startsWith('SELECT job_number, product_number FROM work_orders')) {
      const jobs = params[0] as string[];
      return { rows: jobs.filter((j) => workOrders.has(j)).map((j) => ({ job_number: j, product_number: workOrders.get(j) })), rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO work_orders')) {
      for (let i = 0; i < params.length; i += 8) workOrders.set(params[i] as string, params[i + 1] as string);
      return { rows: [], rowCount: params.length / 8 };
    }
    if (sql.startsWith('INSERT INTO unit_steps')) {
      const width = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').length;
      for (let i = 0; i < params.length; i += width) unitSteps.push({ unit_id: params[i] as string, job_number: params[i + 1] as string });
      return { rows: [], rowCount: params.length / width };
    }
    return none;
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as unknown as Pool, state, workOrders, unitSteps };
}

/** FactoryLogix: rows exist from `at` on; `<field> ge <ts>` (and `lt`), ordered ascending, $top/$skip. */
function flSource(tables: Record<string, Row[]>, clock: { now: number }): Source {
  return {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => 'Edm.DateTimeOffset',
    literal: (_set, _field, value) => {
      if (value.kind !== 'timestamp') throw new Error('timestamp literal expected');
      return new Date(value.ms).toISOString();
    },
    describe: () => '',
    fetchPage: async (req) => {
      let rows = (tables[req.entitySet] ?? []).filter((r) => r.at <= clock.now);
      for (const m of (req.filter ?? '').matchAll(/(\w+) (ge|lt) ([0-9T:.\-Z]+)/g)) {
        const [, field, op, literal] = m as unknown as [string, string, string, string];
        const bound = Date.parse(literal);
        rows = rows.filter((r) => (op === 'ge' ? Date.parse(String(r[field])) >= bound : Date.parse(String(r[field])) < bound));
      }
      const orderField = (req.orderBy ?? '').split(' ')[0] as string;
      if (orderField) rows.sort((a, b) => Date.parse(String(a[orderField])) - Date.parse(String(b[orderField])));
      const skip = req.skip ?? 0;
      return { rows: rows.slice(skip, skip + (req.top ?? rows.length)).map(({ at: _at, ...r }) => r), nextLink: null };
    },
    close: async () => undefined,
  };
}

/** UnitProcessHistory carries no part number, so unit_steps.product_number comes from the work order. */
const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'ModifiedDate',
    key: ['WorkOrderNumber'],
    fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', qty_released: 'QuantityReleased', modified_at: 'ModifiedDate' },
  },
  unit_steps: {
    entity_set: 'UnitProcessHistory',
    watermark_field: 'CompletedDate',
    key: ['UnitSerial', 'WorkOrderNumber', 'OperationName', 'StartedDate'],
    fields: {
      unit_id: 'UnitSerial',
      job_number: 'WorkOrderNumber',
      product_number: null,
      operation: 'OperationName',
      operator: 'OperatorName',
      start_ts: 'StartedDate',
      complete_ts: 'CompletedDate',
    },
  },
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC' };
const iso = (ms: number) => new Date(ms).toISOString();

describe('first run: live polling before the first backfill', () => {
  it('counts the units of a job that was released before the last 2 hours and is still running', async () => {
    const yesterday = Date.parse('2026-10-27T14:00:00Z');
    const install = Date.parse('2026-10-28T09:00:00Z');
    const workOrders: Row[] = [
      // Released yesterday afternoon, running all day today; FactoryLogix does not touch it again.
      { WorkOrderNumber: 'J-100', PartNumber: 'Z-100', QuantityReleased: 500, ModifiedDate: iso(yesterday), at: yesterday },
      // Released this morning, inside the 2 h first-run lookback.
      { WorkOrderNumber: 'J-200', PartNumber: 'Z-200', QuantityReleased: 100, ModifiedDate: iso(install - 30 * 60_000), at: install - 30 * 60_000 },
    ];
    const steps: Row[] = [];
    for (let t = Date.parse('2026-10-28T07:00:00Z'); t < Date.parse('2026-10-28T12:00:00Z'); t += 60_000) {
      for (const job of ['J-100', 'J-200']) {
        steps.push({
          UnitSerial: `${job}-SN-${t}`,
          WorkOrderNumber: job,
          OperationName: 'SMT',
          OperatorName: job === 'J-100' ? 'alice' : 'bob',
          StartedDate: iso(t - 50_000),
          CompletedDate: iso(t),
          at: t,
        });
      }
    }
    const clock = { now: install };
    const source = flSource({ WorkOrders: workOrders, UnitProcessHistory: steps }, clock);
    const db = fakeDb();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);

    // Mapping saved at 09:00; the backfill is scheduled for tonight's 22:00 window (wizard default).
    // Live polling every 90 s until noon.
    for (; clock.now < Date.parse('2026-10-28T12:00:00Z'); clock.now += 90_000) {
      const outcome = await poller.pollOnce(mapping, settings, clock.now);
      expect(outcome.ok).toBe(true);
    }

    const counted = (job: string) => new Set(db.unitSteps.filter((s) => s.job_number === job).map((s) => s.unit_id)).size;
    expect(counted('J-200')).toBeGreaterThan(250);
    // The first work_orders poll only asks for ModifiedDate >= 06:50 (now - 2 h - 10 min), so
    // J-100 is never fetched, and every J-100 unit step is skipped as "work order not ingested yet".
    expect(db.workOrders.has('J-100')).toBe(true);
    expect(counted('J-100')).toBeGreaterThan(250);
  });
});
