import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type DatasetName, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import type { Ingestor } from '../src/ingest/datasets.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { ODataSource } from '../src/sources/ODataSource.js';
import { Poller } from '../src/sync/poller.js';

/**
 * A service that returns at most 100 rows per request whatever `$top` asks for, and no nextLink
 * (a hard result limit below `poll_page_size`). `$skip` works, so every row is reachable.
 */
const BASE = 'http://fl:6065/odata';
const SERVER_LIMIT = 100;

interface FlRow {
  UnitSerial: string;
  WorkOrderNumber: string;
  OperationName: string;
  OperatorName: string;
  StartedDate: string;
  CompletedDate: string;
  /** Real time the row appears in FactoryLogix. */
  at: number;
}

function cappedServer(table: FlRow[], clock: { now: number }) {
  const fetchImpl = async (url: string): Promise<Response> => {
    const u = new URL(url);
    let rows = table.filter((r) => r.at <= clock.now);
    const filter = u.searchParams.get('$filter') ?? '';
    for (const m of filter.matchAll(/CompletedDate (ge|lt) ([0-9T:.\-Z]+)/g)) {
      const bound = Date.parse(m[2] as string);
      rows = rows.filter((r) => (m[1] === 'ge' ? Date.parse(r.CompletedDate) >= bound : Date.parse(r.CompletedDate) < bound));
    }
    rows.sort((a, b) => Date.parse(a.CompletedDate) - Date.parse(b.CompletedDate));
    const skip = Number(u.searchParams.get('$skip') ?? '0');
    const top = Math.min(Number(u.searchParams.get('$top') ?? String(SERVER_LIMIT)), SERVER_LIMIT);
    const value = rows.slice(skip, skip + top).map(({ at: _at, ...r }) => r);
    return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return new ODataSource({ baseUrl: BASE, username: 'u', password: 'p', timeoutSeconds: 5, fetchImpl });
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
      if (sql.includes('INSERT INTO sync_state')) {
        const source = params[0] as string;
        const watermark = (sql.includes('last_success_at') ? params[1] : params[3]) as string | null;
        state.set(source, watermark ?? state.get(source) ?? null);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  return { pool: pool as unknown as Pool, state };
}

function recordingIngestor() {
  const seen: Record<string, Record<string, unknown>[]> = {};
  const ingestor = {
    ingest: async (dataset: DatasetName, rows: Record<string, unknown>[]) => {
      (seen[dataset] ??= []).push(...rows);
      return { received: rows.length, ingested: rows.length, skipped: 0, touched: [] };
    },
  } as unknown as Ingestor;
  return { ingestor, seen };
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC' };

const unitSteps = {
  entity_set: 'UnitProcessHistory',
  watermark_field: 'CompletedDate',
  key: ['UnitSerial', 'WorkOrderNumber', 'OperationName', 'StartedDate'],
  fields: {
    unit_id: 'UnitSerial',
    job_number: 'WorkOrderNumber',
    operation: 'OperationName',
    operator: 'OperatorName',
    start_ts: 'StartedDate',
    complete_ts: 'CompletedDate',
  },
};

const mapping = {
  work_orders: null,
  unit_steps: unitSteps,
  defects: null,
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const iso = (ms: number) => new Date(ms).toISOString();

describe('a service that returns fewer rows than $top without a nextLink', () => {
  it('keeps unit steps flowing when 15 steps a minute complete (more than the limit inside the 10 min overlap)', async () => {
    // Shift starts at 06:00; one unit step completes every 4 s until 08:00.
    const shiftStart = Date.parse('2026-10-28T06:00:00Z');
    const table: FlRow[] = Array.from({ length: 1800 }, (_, i) => {
      const done = shiftStart + i * 4_000;
      return {
        UnitSerial: `SN-${i}`,
        WorkOrderNumber: 'J-1',
        OperationName: 'SMT',
        OperatorName: `op${i % 30}`,
        StartedDate: iso(done - 60_000),
        CompletedDate: iso(done),
        at: done,
      };
    });
    const clock = { now: shiftStart };
    const source = cappedServer(table, clock);
    const db = fakePool();
    db.state.set('unit_steps', '2026-10-28T05:59:00.000Z');
    db.state.set('late_data', '2026-10-28T05:30:00.000Z');
    const { ingestor, seen } = recordingIngestor();
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
    const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, source);

    for (; clock.now <= Date.parse('2026-10-28T08:00:00Z'); clock.now += 90_000) {
      const outcome = await poller.pollOnce(mapping, settings, clock.now);
      expect(outcome.ok).toBe(true);
    }

    const units = new Set((seen.unit_steps ?? []).map((r) => r.UnitSerial));
    // Ten minutes into the shift the overlap window holds more than 100 rows: every poll gets
    // the oldest 100 of them (a "short page", so the loop stops), their max is below the stored
    // watermark, so the watermark never moves again. The hourly late pull is capped the same way.
    expect(Date.parse(db.state.get('unit_steps') ?? '')).toBeGreaterThan(Date.parse('2026-10-28T07:50:00Z'));
    expect(units.has('SN-900')).toBe(true); // completed at 07:00
    expect(units.size).toBeGreaterThanOrEqual(1750);
  });
});
