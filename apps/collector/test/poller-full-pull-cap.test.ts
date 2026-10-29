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

/** sync_state / sync_log in memory; nothing else is stored. */
function fakePool(): Pool {
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return pool as unknown as Pool;
}

/** Plain client-driven paging: honours $top/$skip over a fixed table, no server paging. */
function tableSource(tables: Record<string, Row[]>) {
  const requests: SourceRequest[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: () => {
      throw new Error('no filter expected for a full pull');
    },
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      const rows = tables[req.entitySet] ?? [];
      const skip = req.skip ?? 0;
      return { rows: rows.slice(skip, skip + (req.top ?? rows.length)), nextLink: null };
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

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };

/** FactoryLogix standard hours: one row per product and operation, no timestamp (spec 4.4 item 6). */
const mapping = {
  work_orders: null,
  unit_steps: null,
  defects: null,
  operators: null,
  routes: null,
  standards: {
    entity_set: 'StandardHours',
    watermark_field: null,
    key: ['PartNumber', 'OperationName'],
    fields: { product_number: 'PartNumber', operation: 'OperationName', std_hr: 'UnitsPerHour' },
  },
} as unknown as MappingConfig;

describe('full pull of a data source with no watermark or timestamp', () => {
  it('reaches every row over successive polls once the data source has more than 20 x poll_page_size rows', async () => {
    // 1,000 products x 12 operations = 12,000 rows, in the service's natural (key) order: the
    // newest products come last.
    const operations = ['KIT', 'SMT-TOP', 'SMT-BOT', 'AOI', 'THT', 'WAVE', 'WASH', 'ICT', 'FCT', 'COAT', 'PACK', 'SHIP'];
    const table: Row[] = [];
    for (let p = 0; p < 1000; p += 1) {
      for (const op of operations) table.push({ PartNumber: `Z-${String(p).padStart(5, '0')}`, OperationName: op, UnitsPerHour: 40 });
    }
    const { source, requests } = tableSource({ StandardHours: table });
    const { ingestor, seen } = recordingIngestor();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: fakePool(), log, ingestor, timestamps }, source);

    const t0 = Date.parse('2026-10-28T12:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      const outcome = await poller.pollOnce(mapping, settings, t0 + i * 90_000);
      expect(outcome.ok).toBe(true);
    }

    // "page cap reached; the rest arrives on the next poll": every poll starts again at $skip=0.
    const maxSkip = Math.max(...requests.map((r) => r.skip ?? 0));
    const products = new Set((seen.standards ?? []).map((r) => r.PartNumber));
    expect(maxSkip).toBeGreaterThanOrEqual(11_500);
    expect(products.has('Z-00999')).toBe(true);
    expect(products.size).toBe(1000);
  });
});
