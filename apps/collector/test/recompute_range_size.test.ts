import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EXAMPLE_MAPPING } from '@fld/shared';
import { hourStartUtc } from '@fld/engine';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Recomputer } from '../src/engine/recompute.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';

const HOUR = 3_600_000;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** Answers every statement with no rows, and records how much start_ts history each unit_steps load asks for. */
function fakePool() {
  const stepLoadSpansHours: number[] = [];
  const operationIds = new Map<string, number>();
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('information_schema.columns')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operationIds.has(name)) operationIds.set(name, operationIds.size + 1);
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith('SELECT id, name FROM operations WHERE')) {
      const rows = (params[0] as string[]).map((name) => ({ id: operationIds.get(name), name }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM unit_steps us JOIN operations o') && sql.includes('us.start_ts >= $1')) {
      const [hardStart, to] = (params as Date[]).map((d) => d.getTime()) as [number, number];
      stepLoadSpansHours.push((to - hardStart) / HOUR);
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, stepLoadSpansHours };
}

describe('hour cell recompute after a poll that touched a long stretch of hours', () => {
  const settings = { ...DEFAULT_SETTINGS, plant_timezone: 'America/New_York' };
  const now = Date.parse('2026-03-10T15:20:00Z');

  it('does not load a month of unit_steps in one query because 720 old rows were modified, one per hour', async () => {
    const { pool, stepLoadSpansHours } = fakePool();
    const operations = new OperationCache(pool);
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: settings.plant_timezone });
    const ingestor = new Ingestor({ pool, log, operations, timestamps }, EXAMPLE_MAPPING);

    // A data fix in the source system re-saves about one old step per hour for 30 days (720 rows, far below one poll's 100,000-row cap).
    const first = hourStartUtc(now - 30 * 24 * HOUR, settings.plant_timezone);
    const rows = Array.from({ length: 720 }, (_, i) => ({
      UnitSerial: `U-${i}`,
      WorkOrderNumber: 'J-1',
      PartNumber: 'P-1',
      OperationName: 'Weld',
      OperationSequence: 1,
      OperatorName: 'jdoe',
      StartedDate: new Date(first + i * HOUR).toISOString(),
      CompletedDate: new Date(first + i * HOUR + 60_000).toISOString(),
      Result: 'Pass',
    }));
    const outcome = await ingestor.ingest('unit_steps', rows);

    // What the collector does after the poll: recompute the hour of every touched instant (plus the current and previous hour).
    const current = hourStartUtc(now, settings.plant_timezone);
    const hours = new Set<number>([current - HOUR, current, ...outcome.touched.map((t) => hourStartUtc(t, settings.plant_timezone))]);
    await new Recomputer(pool, log, operations).recomputeHours(hours, settings, now, { notify: false });

    // At the SPEC's 300,000 steps a day every 24 h of start_ts is about 300,000 rows held in memory at once (about 1 GB per 1.5 million rows).
    // The widest window the product already has to cope with is the late-data re-pull at its 168 h maximum (about 197 h of start_ts).
    expect(Math.max(...stepLoadSpansHours)).toBeLessThanOrEqual(240);
  });
});
