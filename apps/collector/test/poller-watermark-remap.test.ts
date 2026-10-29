/**
 * The watermark field of a data source changes while sync_state still holds a value of the old
 * one. work_orders with no created_at / modified_at mapped polls with a numeric id watermark and
 * stores the highest id it read. Once the admin changes the watermark to a timestamp field (or to
 * none, with modified_at mapped), that id is no timestamp: read as one, '1999' is the year 1999
 * and the poll pulls the whole history, '5000' the year 5000 and it gets nothing. The other way,
 * a stored timestamp is no id for a numeric watermark field.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { ODataError } from '../src/odata/client.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = Record<string, unknown>;

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2025-03-04T12:00:00Z');
const T1 = T0 + 5 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

/** sync_state / sync_log in memory. */
function fakePool() {
  const state = new Map<string, string | null>();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sync_state WHERE source')) {
        const source = params[0] as string;
        if (!state.has(source)) return { rows: [], rowCount: 0 };
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
      if (sql.includes('INSERT INTO sync_state (source, watermark')) {
        const [source, watermark] = params as [string, string | null];
        state.set(source, watermark ?? state.get(source) ?? null);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, state };
}

/**
 * FactoryLogix's WorkOrders behind `$filter=<field> ge <literal>&$orderby=<field> asc&$top&$skip`,
 * with `Id` an Edm.Int64 and `Modified` an Edm.DateTimeOffset in $metadata. Like a real service it
 * answers a literal of another type (`Id ge '2025-...'`, `Modified ge 5000`) with a 400.
 */
function workOrderService(table: Row[]) {
  const requests: SourceRequest[] = [];
  const types: Record<string, string> = { Id: 'Edm.Int64', Modified: 'Edm.DateTimeOffset' };
  const value = (row: Row, field: string) => (field === 'Modified' ? Date.parse(String(row.Modified)) : Number(row[field]));
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: (_set, field) => types[field] ?? null,
    literal: (_set, _field, v) => (v.kind === 'timestamp' ? iso(v.ms) : v.kind === 'string' ? `'${v.value}'` : String(v.value)),
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      let rows = [...table];
      if (req.filter) {
        const m = /^(\w+) ge (\S+)$/.exec(req.filter);
        if (!m) throw new Error(`unexpected filter ${req.filter}`);
        const [, field, literal] = m as unknown as [string, string, string];
        const typed = field === 'Modified' ? /^\d{4}-/.test(literal) : /^\d+$/.test(literal);
        if (!typed) throw new ODataError(`HTTP 400: ${req.filter}: ${types[field]} compared with ${literal}`, { status: 400, url: req.entitySet });
        const bound = field === 'Modified' ? Date.parse(literal) : Number(literal);
        rows = rows.filter((r) => value(r, field) >= bound);
      }
      const order = /^(\w+) asc$/.exec(req.orderBy ?? '')?.[1];
      if (order) rows.sort((a, b) => value(a, order) - value(b, order));
      const skip = req.skip ?? 0;
      return { rows: rows.slice(skip, skip + (req.top ?? rows.length)).map((r) => ({ ...r })), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

function harness(table: Row[]) {
  const db = fakePool();
  const src = workOrderService(table);
  const warnings: string[] = [];
  const log = { info: () => undefined, warn: (_obj: unknown, msg: string) => warnings.push(msg), error: () => undefined, debug: () => undefined } as unknown as Logger;
  /** Job numbers of the work orders read, in order. */
  const read: string[] = [];
  const ingestor = {
    ingest: async (_dataset: DatasetName, rows: Row[]) => {
      read.push(...rows.map((r) => String(r.Job)));
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);
  /** Polls at `now` and hands back what that poll asked for and read. */
  const poll = async (mapping: MappingConfig, now: number) => {
    src.requests.length = 0;
    read.length = 0;
    const outcome = await poller.pollOnce(mapping, settings, now);
    return { outcome, filters: [...new Set(src.requests.map((r) => r.filter ?? null))], read: [...read] };
  };
  return { db, poll, warnings };
}

/** work_orders on its own, with `watermark_field` and the extra fields given. */
function workOrders(watermarkField: string | null, fields: Record<string, string> = {}): MappingConfig {
  return {
    work_orders: {
      entity_set: 'WorkOrders',
      watermark_field: watermarkField,
      key: ['Job'],
      fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty', ...fields },
    },
    unit_steps: null,
    defects: null,
    operators: null,
    routes: null,
    standards: null,
  } as unknown as MappingConfig;
}

const byId = workOrders('Id');
const byModified = workOrders('Modified');
const byWindow = workOrders(null, { modified_at: 'Modified' });

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 }; // 10 min overlap

const wo = (id: number, job: string, modified: string): Row => ({ Id: id, Job: job, Product: 'Z-1', Qty: 10, Modified: modified });

/** Where a first run of work_orders reads from at `now` (2 h back with late_data_hours 0), with the overlap. */
const firstRunFilter = (now: number) => `Modified ge ${iso(now - 2 * HOUR - 10 * MIN)}`;

describe('changing the watermark field of a data source polled by a numeric id', () => {
  it.each([
    ['1999', 'a timestamp field', byModified],
    ['5000', 'a timestamp field', byModified],
    ['1999', 'none', byWindow],
    ['150', 'none', byWindow],
  ])('stored id %s, watermark now %s: the next poll reads as a first run and gets the new work order', async (lastId, _to, after) => {
    const table = [wo(1, 'J-0001', '2024-05-02T08:00:00Z'), wo(2, 'J-0002', '2024-06-10T08:00:00Z'), wo(Number(lastId), 'J-LAST', '2025-03-03T08:00:00Z')];
    const { db, poll, warnings } = harness(table);
    const first = await poll(byId, T0);
    expect(first.outcome.ok).toBe(true);
    expect(first.filters).toEqual([null]); // a numeric watermark's first run reads it all, in id order
    expect(db.state.get('work_orders')).toBe(lastId);

    // The admin changes the watermark field (Admin > Mapping, step 3); then a work order changes.
    table.push(wo(Number(lastId) + 1, 'J-NEW', iso(T1 - MIN)));
    const second = await poll(after, T1);

    expect(second.outcome.ok).toBe(true);
    expect(second.filters).toEqual([firstRunFilter(T1)]);
    expect(second.read).toEqual(['J-NEW']); // not the whole history, and not nothing
    expect(db.state.get('work_orders')).toBe(iso(T1 - MIN));
    expect(warnings.filter((w) => w.startsWith('stored watermark is not a timestamp'))).toHaveLength(1);
  });

  it('with nothing new, the start of that first run replaces the stored id: later polls read on from it, and it is said once', async () => {
    const { db, poll, warnings } = harness([wo(1, 'J-0001', '2024-05-02T08:00:00Z'), wo(1999, 'J-1999', '2025-03-03T08:00:00Z')]);
    expect((await poll(byId, T0)).outcome.ok).toBe(true);
    expect(db.state.get('work_orders')).toBe('1999');

    const second = await poll(byModified, T1);
    expect(second.outcome.ok).toBe(true);
    expect(second.read).toEqual([]);
    expect(db.state.get('work_orders')).toBe(iso(T1 - 2 * HOUR));

    const third = await poll(byModified, T1 + 90_000);
    expect(third.filters).toEqual([firstRunFilter(T1)]);
    expect(warnings.filter((w) => w.startsWith('stored watermark is not a timestamp'))).toHaveLength(1);
  });
});

describe('changing a timestamp watermark to a numeric id on a data source with no timestamp', () => {
  it('does not compare the id with the stored time: the data source is read again in id order, then from its highest id', async () => {
    const table = [wo(41, 'J-0041', iso(T0 - 30 * MIN)), wo(42, 'J-0042', iso(T0 - 20 * MIN))];
    const { db, poll } = harness(table);
    expect((await poll(byModified, T0)).read).toEqual(['J-0041', 'J-0042']);
    expect(db.state.get('work_orders')).toBe(iso(T0 - 20 * MIN));

    const second = await poll(byId, T1);
    expect(second.outcome.error).toBeNull(); // not a 400 for `Id ge '2025-03-04T11:40:00.000Z'`
    expect(second.filters).toEqual([null]);
    expect(second.read).toEqual(['J-0041', 'J-0042']);
    expect(db.state.get('work_orders')).toBe('42');

    table.push(wo(43, 'J-0043', iso(T1 + MIN)));
    const third = await poll(byId, T1 + 90_000);
    expect(third.filters).toEqual(['Id ge 42']);
    expect(third.read).toEqual(['J-0042', 'J-0043']);
  });
});
