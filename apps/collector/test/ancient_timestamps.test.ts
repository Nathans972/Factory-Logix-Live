import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, EXAMPLE_MAPPING } from '@fld/shared';
import { hourStartUtc } from '@fld/engine';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { StandardsRecomputer } from '../src/engine/standards.js';
import { Recomputer } from '../src/engine/recompute.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';

const HOUR = 3_600_000;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

interface StoredStep {
  unit_id: string;
  job_number: string;
  product_number: string;
  operation_id: number;
  operator_id: string;
  start_ts: Date;
  complete_ts: Date | null;
}

/** Keeps what the ingest writes to unit_steps and serves it back to the recompute and standards loads. */
function fakePool() {
  const stored: StoredStep[] = [];
  const operationIds = new Map<string, number>();
  const nameOf = (id: number) => [...operationIds].find(([, v]) => v === id)?.[0] as string;
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
    if (sql === 'SELECT id, name FROM operations') {
      const rows = [...operationIds].map(([name, id]) => ({ id, name }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO unit_steps')) {
      // unit_id, job_number, product_number, operation_id, operator_id, start_ts, complete_ts, ... (12 columns)
      for (let i = 0; i < params.length; i += 12) {
        const p = params.slice(i, i + 12);
        stored.push({
          unit_id: p[0] as string,
          job_number: p[1] as string,
          product_number: p[2] as string,
          operation_id: p[3] as number,
          operator_id: p[4] as string,
          start_ts: p[5] as Date,
          complete_ts: p[6] as Date | null,
        });
      }
      return { rows: [], rowCount: params.length / 12 };
    }
    const asRow = (s: StoredStep) => ({
      unit_id: s.unit_id,
      job_number: s.job_number,
      product_number: s.product_number,
      operation: nameOf(s.operation_id),
      operator_id: s.operator_id,
      start_ts: s.start_ts,
      complete_ts: s.complete_ts,
      result: null,
      rework_flag: null,
    });
    if (sql.includes('FROM unit_steps us JOIN operations o') && sql.includes('us.start_ts >= $1')) {
      const [hardStart, to, windowStart] = (params as Date[]).map((d) => d.getTime()) as [number, number, number];
      const rows = stored
        .filter((s) => s.start_ts.getTime() >= hardStart && s.start_ts.getTime() < to)
        .filter((s) => s.complete_ts === null || s.complete_ts.getTime() >= windowStart)
        .map(asRow);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SELECT DISTINCT product_number, operation_id FROM unit_steps')) {
      const seen = new Map<string, { product_number: string; operation_id: number }>();
      for (const s of stored) seen.set(`${s.product_number}|${s.operation_id}`, { product_number: s.product_number, operation_id: s.operation_id });
      return { rows: [...seen.values()], rowCount: seen.size };
    }
    if (sql.includes('FROM unit_steps us JOIN operations o') && sql.includes('us.product_number = $1')) {
      const [product, operationId] = params as [string, number];
      const rows = stored.filter((s) => s.product_number === product && s.operation_id === operationId).map(asRow);
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, stored };
}

/** A completed step whose StartedDate is SQL Server's zero date, which a data source can send for a step with no start scan. */
const zeroStartRow = {
  UnitSerial: 'U-1',
  WorkOrderNumber: 'J-1',
  PartNumber: 'P-1',
  OperationName: 'Weld',
  OperationSequence: 1,
  OperatorName: 'jdoe',
  StartedDate: '1900-01-01T00:00:00Z',
  CompletedDate: '2026-03-09T13:00:00Z',
  Result: 'Pass',
};

describe('a step with an implausibly old StartedDate must not stall the collector', () => {
  const settings = { ...DEFAULT_SETTINGS, plant_timezone: 'America/New_York' };
  const now = Date.parse('2026-03-10T15:20:00Z');

  async function ingestZeroStart() {
    const { pool, stored } = fakePool();
    const operations = new OperationCache(pool);
    const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: settings.plant_timezone });
    const ingestor = new Ingestor({ pool, log, operations, timestamps }, EXAMPLE_MAPPING);
    const outcome = await ingestor.ingest('unit_steps', [zeroStartRow]);
    return { pool, stored, operations, outcome };
  }

  it('the hour cell recompute after the poll that ingested it finishes in seconds, not tens of seconds', async () => {
    const { pool, operations, outcome } = await ingestZeroStart();
    // What the collector does after a poll: the hours of every touched instant plus the current and previous hour.
    const current = hourStartUtc(now, settings.plant_timezone);
    const hours = new Set<number>([current - HOUR, current, ...outcome.touched.map((t) => hourStartUtc(t, settings.plant_timezone))]);

    const started = performance.now();
    await new Recomputer(pool, log, operations).recomputeHours(hours, settings, now);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
  }, 180_000);

  it('the nightly standards run over that product and operation finishes in seconds, not tens of seconds', async () => {
    const { pool, operations } = await ingestZeroStart();

    const started = performance.now();
    await new StandardsRecomputer(pool, log, operations).run({ settings, mapping: null, now, since: null });
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(2_000);
  }, 180_000);
});
