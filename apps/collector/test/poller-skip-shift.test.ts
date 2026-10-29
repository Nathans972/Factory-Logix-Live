import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

type Row = Record<string, unknown>;

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
 * A live FactoryLogix table behind `$filter=<field> ge <ts>&$orderby=<field> asc&$top&$skip`.
 * Every request is evaluated against the table as it is at that moment; `beforeRequest` lets the
 * test change rows between two page requests of one pull, as FactoryLogix users do.
 */
function liveSource(table: Row[], beforeRequest: (req: SourceRequest, n: number) => void) {
  const requests: SourceRequest[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => {
      if (value.kind !== 'timestamp') throw new Error('timestamp literal expected');
      return new Date(value.ms).toISOString();
    },
    describe: () => '',
    fetchPage: async (req) => {
      beforeRequest(req, requests.length);
      requests.push(req);
      const m = /^(\w+) ge (\S+)$/.exec(req.filter ?? '');
      if (!m) throw new Error(`unexpected filter ${req.filter}`);
      const [, field, literal] = m as unknown as [string, string, string];
      const since = Date.parse(literal);
      const rows = table
        .filter((r) => Date.parse(String(r[field])) >= since)
        .sort((a, b) => Date.parse(String(a[field])) - Date.parse(String(b[field])));
      const skip = req.skip ?? 0;
      return { rows: rows.slice(skip, skip + (req.top ?? rows.length)).map((r) => ({ ...r })), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

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

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 24 };

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'ModifiedDate',
    key: ['WorkOrderNumber'],
    fields: {
      job_number: 'WorkOrderNumber',
      product_number: 'PartNumber',
      qty_released: 'QuantityReleased',
      status: 'Status',
      modified_at: 'ModifiedDate',
    },
  },
  unit_steps: null,
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const iso = (ms: number) => new Date(ms).toISOString();

describe('$top/$skip paging while FactoryLogix changes rows mid-pull', () => {
  it('a catch-up pull still delivers the job at a page boundary when an already-read job changes between pages', async () => {
    // The collector was stopped overnight (host reboot); the stored watermark is 18:00 the evening
    // before. During the night 1,200 jobs were updated (status changes, ERP sync).
    const evening = Date.parse('2026-10-26T18:00:00Z');
    const table: Row[] = Array.from({ length: 1200 }, (_, i) => ({
      WorkOrderNumber: `J-${String(i).padStart(4, '0')}`,
      PartNumber: 'Z-1',
      QuantityReleased: 50,
      Status: 'Closed',
      ModifiedDate: iso(evening + 60_000 + i * 30_000),
    }));
    const resume = Date.parse('2026-10-27T06:00:00Z');
    let changed = false;
    const { source, requests } = liveSource(table, (req) => {
      // Between our first and second page request an operator starts a unit on J-0100 (read on
      // page 1); FactoryLogix bumps its ModifiedDate, so it moves to the end of the ordering.
      if (!changed && (req.skip ?? 0) === 500) {
        const job = table.find((r) => r.WorkOrderNumber === 'J-0100') as Row;
        job.Status = 'In process';
        job.ModifiedDate = iso(resume + 5_000);
        changed = true;
      }
    });
    const db = fakePool();
    db.state.set('work_orders', iso(evening));
    const { ingestor, seen } = recordingIngestor();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);

    // The catch-up poll at 06:00, then a regular poll every 90 s for the next two hours.
    for (let now = resume; now < resume + 2 * 3_600_000; now += 90_000) {
      const outcome = await poller.pollOnce(mapping, settings, now);
      expect(outcome.ok).toBe(true);
    }

    expect(changed).toBe(true);
    expect(requests.length).toBeGreaterThan(3);
    const jobs = new Set((seen.work_orders ?? []).map((r) => r.WorkOrderNumber));
    // J-0500 sat at position 500 when page 1 was read; after J-0100 moved to the end it sat at
    // position 499, so `$skip=500` stepped over it. It never changes again, so no later poll
    // (since = watermark - 10 min) or late-data re-pull (unit_steps/defects only) reads it.
    expect(jobs.has('J-0500')).toBe(true);
    expect(jobs.size).toBe(1200);
  });
});
