import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BackfillProgress, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Backfill, dayBounds } from '../src/sync/backfill.js';

const TZ = 'America/Chicago';
const HOUR = 3_600_000;
const NOW = Date.parse('2025-10-11T16:00:00Z');
const mapping = { work_orders: {}, unit_steps: {}, defects: null } as unknown as MappingConfig;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

/** The SPEC's volume: 20,000 units a day through 15 operations is 300,000 unit_steps a day. */
const ROWS_PER_HOUR = 12_500;
/** poller.ts MAX_PAGES_WINDOW: a window pull stops after this many pages and reports `truncated: true`. */
const MAX_PAGES_WINDOW = 1000;

/** sync_state('backfill') in memory: the two statements saveBackfillProgress / loadSyncState send. */
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
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, stored: () => stored };
}

describe('backfill of a day with more rows than one window pull can read', () => {
  it('does not count the day as downloaded while part of it was never read', async () => {
    // An admin lowered poll_page_size to 200 to be gentle on FactoryLogix (the allowed minimum is 50). One window pull then reads at
    // most 1000 pages x 200 rows = 200,000 rows, in complete_ts order, and reports the rest as `truncated`.
    const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: TZ, backfill_days: 1, poll_page_size: 200 };
    const read: { from: number; to: number }[] = [];
    const poller = {
      pullWindow: async (dataset: string, _m: unknown, s: Settings, opts: { from: number; to: number }) => {
        if (dataset !== 'unit_steps') return { rows: 0, ingested: 0, skipped: 0, truncated: false };
        const wanted = ((opts.to - opts.from) / HOUR) * ROWS_PER_HOUR;
        const cap = MAX_PAGES_WINDOW * s.poll_page_size;
        const rows = Math.min(wanted, cap);
        read.push({ from: opts.from, to: opts.from + (rows / ROWS_PER_HOUR) * HOUR });
        return { rows, ingested: rows, skipped: 0, truncated: wanted > cap };
      },
    };
    const recomputer = { recomputeHours: async () => ({}) as never };
    const db = fakePool();
    const backfill = new Backfill(db.pool, log, poller as never, recomputer as never, async () => undefined);

    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    await backfill.tick(mapping, settings, NOW);

    const progress = db.stored() as BackfillProgress;
    const { from, to } = dayBounds(TZ, progress.first_day as string);
    let readHours = 0;
    for (const r of read) readHours += Math.max(0, Math.min(r.to, to) - Math.max(r.from, from)) / HOUR;

    // Either the whole day was read (the window was split) or the day is not reported as done (an error is shown, a retry follows).
    if (progress.days_done >= 1) expect(readHours).toBe((to - from) / HOUR);
  });
});
