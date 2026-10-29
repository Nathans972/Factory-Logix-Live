import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BackfillProgress, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Backfill } from '../src/sync/backfill.js';
import { Poller } from '../src/sync/poller.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** sync_state('backfill') and sync_log in memory. */
function fakePool() {
  let stored: BackfillProgress | null = null;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO sync_state')) {
        stored = JSON.parse(params[0] as string) as BackfillProgress;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM sync_state')) {
        return { rows: stored ? [{ source: 'backfill', consecutive_failures: 0, backfill_progress: structuredClone(stored) }] : [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.startsWith('UPDATE sync_log')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, stored: () => stored };
}

/** A service whose UnitSteps hold `total` rows for the day, served by $top/$skip. */
function fakeSource(total: number): Source {
  return {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
    describe: () => '',
    fetchPage: async (req: SourceRequest) => {
      if (req.entitySet !== 'UnitSteps') return { rows: [], nextLink: null };
      const skip = req.skip ?? 0;
      const count = Math.max(0, Math.min(req.top ?? 500, total - skip));
      return { rows: Array.from({ length: count }, (_, i) => ({ Id: skip + i })), nextLink: null };
    },
    close: async () => undefined,
  };
}

const mapping = {
  work_orders: { entity_set: 'WorkOrders', watermark_field: null, key: ['Job'], fields: { job_number: 'Job', modified_at: 'Modified' } },
  unit_steps: { entity_set: 'UnitSteps', watermark_field: null, key: ['Id'], fields: { unit_id: 'Id', complete_ts: 'Done' } },
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

describe('window pulls (backfill days, late-data re-pull) against the page cap', () => {
  it('does not mark a backfill day complete after reading only part of it', async () => {
    const TOTAL = 60_000;
    const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', backfill_days: 1, poll_page_size: 50 };
    const db = fakePool();
    let ingestedUnitSteps = 0;
    const ingestor = {
      ingest: async (dataset: string, rows: unknown[]) => {
        if (dataset === 'unit_steps') ingestedUnitSteps += rows.length;
        return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] as number[] };
      },
    } as unknown as Ingestor;
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, fakeSource(TOTAL));
    const recomputer = { recomputeHours: async () => ({}) as never };
    const backfill = new Backfill(db.pool, log, poller, recomputer as never, async () => undefined);

    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    await backfill.tick(mapping, settings, Date.parse('2025-10-11T12:00:00Z'));

    // 60,000 rows at 50 per page need 1,200 requests; the window pull stops after 1,000 (50,000 rows).
    // Either every row of the day is read, or the day must not be recorded as downloaded.
    const daysDone = db.stored()?.days_done ?? 0;
    const outcome =
      ingestedUnitSteps === TOTAL
        ? 'all rows read'
        : daysDone === 0
          ? 'day not marked downloaded'
          : `read ${ingestedUnitSteps} of ${TOTAL} rows and marked the day downloaded (days_done ${daysDone})`;
    expect(['all rows read', 'day not marked downloaded']).toContain(outcome);
  });
});
