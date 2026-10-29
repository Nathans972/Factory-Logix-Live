import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetMapping, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { ODataSource } from '../src/sources/ODataSource.js';
import { pullPages } from '../src/sync/paging.js';
import { Poller } from '../src/sync/poller.js';

/**
 * An OData service with server-driven paging (ASP.NET OData `PageSize`, WCF Data Services
 * `SetEntitySetPageSize`, ...). Per the OData spec, `$top` still limits the whole result: the
 * nextLink carries the remaining `$top`, and once `$top` rows have been returned there is no
 * nextLink, even when more rows match the filter.
 */
const BASE = 'http://fl:6065/odata';
const SERVER_PAGE_SIZE = 100;

type Row = Record<string, unknown>;

function serverWith(tables: Record<string, Row[]>) {
  const urls: string[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    const u = new URL(url);
    const entitySet = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    let rows = [...(tables[entitySet] ?? [])];
    const filter = u.searchParams.get('$filter');
    if (filter) {
      for (const m of filter.matchAll(/(\w+) (ge|lt) ([0-9][0-9T:.\-Z]*)/g)) {
        const [, field, op, literal] = m as unknown as [string, string, string, string];
        const bound = Date.parse(literal);
        rows = rows.filter((r) => {
          const v = Date.parse(String(r[field]));
          return op === 'ge' ? v >= bound : v < bound;
        });
      }
    }
    const orderBy = u.searchParams.get('$orderby');
    if (orderBy) {
      const field = orderBy.split(' ')[0] as string;
      rows.sort((a, b) => Date.parse(String(a[field])) - Date.parse(String(b[field])));
    }
    const skip = Number(u.searchParams.get('$skip') ?? '0');
    const topParam = u.searchParams.get('$top');
    const top = topParam === null ? Infinity : Number(topParam);
    const limited = rows.slice(skip, skip + top);
    const page = limited.slice(0, SERVER_PAGE_SIZE);
    const body: Record<string, unknown> = { value: page };
    if (limited.length > SERVER_PAGE_SIZE) {
      const next = new URL(url);
      next.searchParams.set('$skip', String(skip + SERVER_PAGE_SIZE));
      if (topParam !== null) next.searchParams.set('$top', String(top - SERVER_PAGE_SIZE));
      body['@odata.nextLink'] = next.toString();
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const source = new ODataSource({ baseUrl: BASE, username: 'u', password: 'p', timeoutSeconds: 5, fetchImpl });
  return { source, urls };
}

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** sync_state / sync_log in memory. */
function fakePool() {
  const state = new Map<string, string | null>();
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM sync_state WHERE source')) {
        const source = params[0] as string;
        if (!state.has(source)) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              source,
              watermark: state.get(source) ?? null,
              last_success_at: null,
              last_error: null,
              consecutive_failures: 0,
              rows_last_poll: null,
              duration_ms_last_poll: null,
              backfill_progress: null,
            },
          ],
          rowCount: 1,
        };
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

/** Records every row handed to the ingestor, keyed by dataset. */
function recordingIngestor() {
  const seen: Record<string, Row[]> = {};
  const ingestor = {
    ingest: async (dataset: DatasetName, rows: Row[]) => {
      (seen[dataset] ??= []).push(...rows);
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  return { ingestor, seen };
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };

const unitSteps: DatasetMapping = {
  entity_set: 'UnitProcessHistory',
  watermark_field: null,
  key: ['UnitSerial', 'OperationName', 'StartedDate'],
  fields: {
    unit_id: 'UnitSerial',
    job_number: 'WorkOrderNumber',
    operation: 'OperationName',
    operator: 'OperatorName',
    start_ts: 'StartedDate',
    complete_ts: 'CompletedDate',
  },
};

const workOrders: DatasetMapping = {
  entity_set: 'WorkOrders',
  watermark_field: 'ModifiedDate',
  key: ['WorkOrderNumber'],
  fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', qty_released: 'QuantityReleased', modified_at: 'ModifiedDate' },
};

const iso = (ms: number) => new Date(ms).toISOString();

describe('server-driven paging that honours $top', () => {
  it('pullPages reads every matching row, not just the first poll_page_size', async () => {
    const t0 = Date.parse('2026-10-27T06:00:00Z');
    const rows = Array.from({ length: 1200 }, (_, i) => ({ UnitSerial: `SN-${i}`, CompletedDate: iso(t0 + i * 36_000) }));
    const { source } = serverWith({ UnitProcessHistory: rows });

    const summary = await pullPages(
      source,
      { entitySet: 'UnitProcessHistory', filter: null, orderBy: 'CompletedDate asc', select: null, pageSize: 500, maxPages: 1000 },
      () => undefined,
    );

    // Today the chain of nextLinks for the first $top=500 request ends and the loop stops:
    // 500 rows, truncated=false, and the other 700 rows are never requested.
    expect(summary.truncated).toBe(false);
    expect(summary.rows).toBe(1200);
  });

  it('a backfill day with 1,200 unit steps ingests all of them, not 500 reported as ok', async () => {
    const dayStart = Date.parse('2026-10-27T00:00:00Z');
    const rows = Array.from({ length: 1200 }, (_, i) => {
      const start = dayStart + 6 * 3_600_000 + i * 36_000;
      return {
        UnitSerial: `SN-${i}`,
        WorkOrderNumber: 'J-1',
        OperationName: 'SMT',
        OperatorName: 'op1',
        StartedDate: iso(start - 30_000),
        CompletedDate: iso(start),
      };
    });
    const { source } = serverWith({ UnitProcessHistory: rows });
    const db = fakePool();
    const { ingestor, seen } = recordingIngestor();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);

    await poller.pullWindow('unit_steps', unitSteps, settings, {
      from: dayStart,
      to: dayStart + 86_400_000,
      logSource: 'unit_steps:backfill',
    });

    expect(seen.unit_steps?.length ?? 0).toBe(1200);
  });

  it('a bulk update of 600 work orders inside the overlap does not stop the work_orders poll for good', async () => {
    // 600 jobs closed by one bulk action at 09:00, then a new job released at 09:30.
    const bulkAt = Date.parse('2026-10-28T09:00:00Z');
    const table: Row[] = Array.from({ length: 600 }, (_, i) => ({
      WorkOrderNumber: `J-OLD-${i}`,
      PartNumber: 'Z-1',
      QuantityReleased: 10,
      ModifiedDate: iso(bulkAt + i * 100),
    }));
    const { source } = serverWith({ WorkOrders: table });
    const db = fakePool();
    db.state.set('work_orders', '2026-10-28T08:55:00.000Z');
    const { ingestor, seen } = recordingIngestor();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);
    const mapping = { work_orders: workOrders, unit_steps: null, defects: null, operators: null, routes: null, standards: null } as unknown as MappingConfig;

    let now = Date.parse('2026-10-28T09:05:00Z');
    for (; now < Date.parse('2026-10-28T09:30:00Z'); now += 90_000) await poller.pollOnce(mapping, settings, now);
    table.push({ WorkOrderNumber: 'J-NEW', PartNumber: 'Z-2', QuantityReleased: 25, ModifiedDate: iso(Date.parse('2026-10-28T09:30:00Z')) });
    for (; now < Date.parse('2026-10-28T10:30:00Z'); now += 90_000) await poller.pollOnce(mapping, settings, now);

    const jobs = new Set((seen.work_orders ?? []).map((r) => r.WorkOrderNumber));
    expect(jobs.has('J-OLD-599')).toBe(true);
    expect(jobs.has('J-NEW')).toBe(true);
    expect(Date.parse(db.state.get('work_orders') ?? '')).toBeGreaterThanOrEqual(Date.parse('2026-10-28T09:30:00Z'));
  });
});
