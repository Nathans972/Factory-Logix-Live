import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BackfillProgress, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Backfill } from '../src/sync/backfill.js';

/**
 * docs/SPEC.md section 1: "All reads from FactoryLogix are ... circuit-broken. The one-time
 * historical backfill is chunked and throttled." The main poll has a breaker (3 failures, then
 * backoff); the backfill has none. A chunk that fails is simply run again on the next idle pass
 * (every backfill_pause_seconds, 5 s), downloading the same day again, and the backfill stays
 * `running` with an error string instead of moving to a failed state.
 */
const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'America/Chicago', backfill_days: 3 };
const mapping = { work_orders: {}, unit_steps: {}, defects: null } as unknown as MappingConfig;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

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

describe('a backfill chunk that fails on every attempt', () => {
  it('is not retried at full pace forever: it stops hitting FactoryLogix after the breaker threshold', async () => {
    const db = fakePool();
    let pulls = 0;
    const poller = {
      pullWindow: async (dataset: string) => {
        if (dataset === 'unit_steps') {
          pulls += 1;
          throw new Error('OData request failed with HTTP 503 Service Unavailable');
        }
        return { rows: 0, ingested: 0, skipped: 0, truncated: false };
      },
    };
    const recomputer = { recomputeHours: async () => ({}) as never };
    const backfill = new Backfill(db.pool, log, poller as never, recomputer as never, async () => undefined);
    await backfill.ensureScheduled(settings);
    await backfill.requestNow();

    // Six idle passes in a row, gated the way Collector.idle() gates them (load, isActive,
    // shouldRun, then one tick). No time passes between them, as if a backoff were in force.
    const now = Date.parse('2025-10-11T04:59:00Z');
    for (let pass = 0; pass < 6; pass += 1) {
      await backfill.load();
      if (backfill.isActive() && backfill.shouldRun(settings, now)) await backfill.tick(mapping, settings, now);
    }

    // The main poll stops after breaker_failure_threshold failures; the backfill keeps going
    // (and the stored progress stays `running`, days_done 0, with only an error string).
    expect(db.stored()?.days_done).toBe(0);
    expect(pulls).toBeLessThanOrEqual(settings.breaker_failure_threshold);
  });
});
