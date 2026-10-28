import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = { WorkOrderNumber: string; PartNumber: string; QuantityReleased: number; Status: string; ModifiedDate: string; ms: number };

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

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
 * A spec-compliant service: `$filter=ModifiedDate ge <ts>`, `$orderby=ModifiedDate asc` with a
 * stable tie-break on the key, `$top`/`$skip`, no server paging. Rows are kept sorted so the
 * 100k-row table stays fast.
 */
function workOrderSource(table: Row[]) {
  const requests: SourceRequest[] = [];
  const sorted = () => table.sort((a, b) => a.ms - b.ms || a.WorkOrderNumber.localeCompare(b.WorkOrderNumber));
  sorted();
  const source: Source = {
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
      requests.push(req);
      const m = /^ModifiedDate ge (\S+)$/.exec(req.filter ?? '');
      if (!m) throw new Error(`unexpected filter ${req.filter}`);
      const since = Date.parse(m[1] as string);
      let lo = 0;
      let hi = table.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((table[mid] as Row).ms < since) lo = mid + 1;
        else hi = mid;
      }
      const skip = req.skip ?? 0;
      const rows = table.slice(lo + skip, lo + skip + (req.top ?? 0)).map(({ ms: _ms, ...r }) => r);
      return { rows, nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests, add: (row: Row) => (table.push(row), sorted()) };
}

function countingIngestor() {
  const jobs = new Set<unknown>();
  let rows = 0;
  const ingestor = {
    ingest: async (_dataset: DatasetName, batch: Record<string, unknown>[]) => {
      rows += batch.length;
      for (const r of batch) jobs.add(r.WorkOrderNumber);
      return { received: batch.length, ingested: batch.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  return { ingestor, jobs, rows: () => rows };
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'ModifiedDate',
    key: ['WorkOrderNumber'],
    fields: { job_number: 'WorkOrderNumber', product_number: 'PartNumber', qty_released: 'QuantityReleased', status: 'Status', modified_at: 'ModifiedDate' },
  },
  unit_steps: null,
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const iso = (ms: number) => new Date(ms).toISOString();

describe('an overlap window holding more rows than one poll may read', () => {
  it('a bulk update of 120,000 work orders with one ModifiedDate does not stop the work_orders poll for good', async () => {
    // FactoryLogix maintenance at 02:00 touches every historical work order in one statement.
    const bulkAt = Date.parse('2026-10-28T02:00:00Z');
    const table: Row[] = Array.from({ length: 120_000 }, (_, i) => ({
      WorkOrderNumber: `J${String(i).padStart(8, '0')}`,
      PartNumber: 'Z-1',
      QuantityReleased: 10,
      Status: 'Closed',
      ModifiedDate: iso(bulkAt),
      ms: bulkAt,
    }));
    const fl = workOrderSource(table);
    const db = fakePool();
    db.state.set('work_orders', '2026-10-28T01:58:00.000Z');
    const counter = countingIngestor();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: db.pool, log, ingestor: counter.ingestor, timestamps }, fl.source);

    const t0 = Date.parse('2026-10-28T02:01:00Z');
    for (let i = 0; i < 4; i += 1) {
      if (i === 1) {
        // The morning's first new job, released after the bulk update.
        const at = Date.parse('2026-10-28T06:30:00Z');
        fl.add({ WorkOrderNumber: 'J-NEW', PartNumber: 'Z-9', QuantityReleased: 40, Status: 'Released', ModifiedDate: iso(at), ms: at });
      }
      const outcome = await poller.pollOnce(mapping, settings, t0 + i * 3 * 3_600_000);
      expect(outcome.ok).toBe(true);
    }

    // Each poll reads 200 pages x 500 rows of the bulk group (all at 02:00), the watermark stays
    // at 02:00, the next poll starts at 01:50 and reads the same 100,000 rows again.
    expect(db.state.get('work_orders')).not.toBe('2026-10-28T02:00:00.000Z');
    expect(counter.jobs.has('J-NEW')).toBe(true);
    expect(counter.jobs.size).toBe(120_001);
  });
});
