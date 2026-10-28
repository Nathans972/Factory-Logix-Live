import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type BackfillProgress, type MappingConfig, type Settings } from '@fld/shared';
import { localDateString } from '@fld/engine';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Backfill, dayBounds } from '../src/sync/backfill.js';

const TZ = 'America/Chicago';
const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: TZ, backfill_days: 3 };
const mapping = { work_orders: {}, unit_steps: {}, defects: null } as unknown as MappingConfig;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;

/** sync_state('backfill') in memory: the two statements saveBackfillProgress / loadSyncState send. */
function fakePool(initial: BackfillProgress | null = null) {
  let stored: BackfillProgress | null = initial;
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

function harness(initial: BackfillProgress | null = null) {
  const db = fakePool(initial);
  const pulledDays: string[] = [];
  let standardsReady = false;
  /** hour -> whether it was last recomputed with standards available (i.e. colored). */
  const colored = new Map<number, boolean>();
  const poller = {
    pullWindow: async (dataset: string, _m: unknown, _s: unknown, opts: { from: number }) => {
      if (dataset === 'unit_steps') pulledDays.push(localDateString(opts.from, TZ));
      return { rows: 0, ingested: 0, skipped: 0, truncated: false };
    },
  };
  const recomputer = {
    recomputeHours: async (hours: Iterable<number>) => {
      for (const h of hours) colored.set(h, standardsReady);
      return {} as never;
    },
  };
  let standardsRuns = 0;
  const backfill = new Backfill(db.pool, log, poller as never, recomputer as never, async () => {
    standardsRuns += 1;
    standardsReady = true;
  });
  return { backfill, db, pulledDays, colored, standardsRuns: () => standardsRuns };
}

/** 2025-10-10 23:59 and 2025-10-11 00:01 in Chicago (CDT, UTC-5). */
const BEFORE_MIDNIGHT = Date.parse('2025-10-11T04:59:00Z');
const AFTER_MIDNIGHT = Date.parse('2025-10-11T05:01:00Z');

describe('backfill', () => {
  it('processes every day with no gap when chunks run across midnight', async () => {
    const { backfill, db, pulledDays } = harness();
    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    await backfill.tick(mapping, settings, BEFORE_MIDNIGHT);
    expect(db.stored()?.first_day).toBe('2025-10-07');
    await backfill.tick(mapping, settings, AFTER_MIDNIGHT);
    await backfill.tick(mapping, settings, AFTER_MIDNIGHT + 60_000);
    expect(pulledDays).toEqual(['2025-10-07', '2025-10-08', '2025-10-09']);
  });

  it('computes and saves first_day once for saved progress that lacks it', async () => {
    const legacy: BackfillProgress = {
      status: 'paused',
      requested_now: true,
      days_total: 3,
      days_done: 1,
      current_day: '2025-10-07',
      started_at: BEFORE_MIDNIGHT - 3_600_000,
      finished_at: null,
      error: null,
    };
    const { backfill, db, pulledDays } = harness(legacy);
    await backfill.tick(mapping, settings, BEFORE_MIDNIGHT);
    expect(db.stored()?.first_day).toBe('2025-10-07');
    await backfill.tick(mapping, settings, AFTER_MIDNIGHT);
    expect(pulledDays).toEqual(['2025-10-08', '2025-10-09']);
  });

  it('gives backfilled hours standards and colors after the download completes', async () => {
    const { backfill, db, colored, standardsRuns } = harness();
    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    const statuses: string[] = [];
    let finished = false;
    for (let i = 0; i < 20 && !finished; i += 1) {
      finished = (await backfill.tick(mapping, settings, BEFORE_MIDNIGHT + i * 1_000)).finished;
      statuses.push(db.stored()!.status);
    }
    expect(finished).toBe(true);
    // 3 download days, the standards run, 3 re-colored days.
    expect(statuses).toEqual(['running', 'running', 'recoloring', 'recoloring', 'recoloring', 'recoloring', 'done']);
    expect(standardsRuns()).toBe(1);
    for (const day of ['2025-10-07', '2025-10-08', '2025-10-09']) {
      const { from, to } = dayBounds(TZ, day);
      for (let h = from; h < to; h += 3_600_000) expect(colored.get(h)).toBe(true);
    }
    expect(db.stored()).toMatchObject({ days_done: 3, recolor_days_done: 3, standards_done: true, requested_now: false });
  });

  it('resumes the recoloring phase after a restart', async () => {
    const saved: BackfillProgress = {
      status: 'recoloring',
      requested_now: true,
      days_total: 3,
      days_done: 3,
      current_day: '2025-10-08',
      started_at: 1,
      finished_at: null,
      error: null,
      first_day: '2025-10-07',
      standards_done: true,
      recolor_days_done: 1,
    };
    const { backfill, colored, pulledDays, standardsRuns } = harness(saved);
    await backfill.tick(mapping, settings, AFTER_MIDNIGHT);
    expect(await backfill.tick(mapping, settings, AFTER_MIDNIGHT)).toEqual({ worked: true, finished: true });
    expect(pulledDays).toEqual([]);
    expect(standardsRuns()).toBe(0);
    const recolored = [...colored.keys()].map((h) => localDateString(h, TZ));
    expect(new Set(recolored)).toEqual(new Set(['2025-10-08', '2025-10-09']));
  });

  it('a paused recoloring backfill picks up where it left off', async () => {
    const { backfill, db } = harness();
    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    for (let i = 0; i < 4; i += 1) await backfill.tick(mapping, settings, BEFORE_MIDNIGHT);
    await backfill.pause();
    expect(db.stored()?.status).toBe('paused');
    await backfill.tick(mapping, settings, AFTER_MIDNIGHT);
    expect(db.stored()).toMatchObject({ status: 'recoloring', recolor_days_done: 1, current_day: '2025-10-07' });
  });

  it('requestNow on a finished backfill starts over with a new range', async () => {
    const { backfill, db } = harness();
    await backfill.ensureScheduled(settings);
    await backfill.requestNow();
    for (let i = 0; i < 7; i += 1) await backfill.tick(mapping, settings, BEFORE_MIDNIGHT);
    expect(db.stored()?.status).toBe('done');
    await backfill.requestNow();
    expect(db.stored()).toMatchObject({ status: 'scheduled', days_done: 0, first_day: null, standards_done: false, recolor_days_done: 0 });
  });
});
