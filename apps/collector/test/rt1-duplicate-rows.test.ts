/**
 * Red team (data integrity): a row that is read again with a different parsed timestamp becomes a
 * second row instead of replacing the first, so every count built on it doubles.
 *
 * unit_steps is unique on (natural_key, start_ts) and defects on (natural_key, found_ts)
 * (db/migrations/0001_init.sql), and the Ingestor upserts on exactly those pairs. The database
 * below is in memory (no Postgres in CI) but takes its unique constraints from that migration file
 * and rejects an ON CONFLICT target that no constraint backs, as Postgres does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeHourCells } from '@fld/engine';
import { DEFAULT_SETTINGS, pickEngineSettings, type MappingConfig, type UnitStep } from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';

const HOUR = 3_600_000;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

type Row = Record<string, unknown>;

const MIGRATION = readFileSync(fileURLToPath(new URL('../../../db/migrations/0001_init.sql', import.meta.url)), 'utf8');

/** Column sets the real schema declares UNIQUE (or PRIMARY KEY) for a table. */
function uniqueKeys(table: string): string[][] {
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(MIGRATION)?.[1] ?? '';
  const keys = [...body.matchAll(/(?:UNIQUE|PRIMARY KEY) \(([^)]+)\)/g)].map((m) => (m[1] as string).split(',').map((c) => c.trim()));
  for (const m of body.matchAll(/^\s*(\w+)\s+[^,\n]*PRIMARY KEY/gm)) keys.push([m[1] as string]);
  return keys;
}

const same = (a: unknown, b: unknown): boolean => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function memoryDb() {
  const tables: Record<string, Row[]> = {};
  const operations = new Map<string, number>();
  const table = (name: string): Row[] => (tables[name] ??= []);
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return ok();
    if (text.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return ok();
    }
    if (text.startsWith('SELECT id, name FROM operations WHERE name = ANY')) {
      return ok((params[0] as string[]).filter((n) => operations.has(n)).map((name) => ({ id: operations.get(name), name })));
    }
    if (text.startsWith('SELECT 1 AS ok FROM information_schema.columns')) return ok([{ ok: 1 }]);
    if (text.startsWith('SELECT job_number, product_number FROM work_orders')) return ok();
    if (text.startsWith('SELECT product_number, operation_id, sequence FROM product_routes')) return ok();
    if (text.startsWith('INSERT INTO raw_event_hashes')) {
      const changed: Row[] = [];
      for (let i = 0; i < params.length; i += 3) changed.push({ source: params[i], natural_key: params[i + 1] });
      return ok(changed);
    }
    const insert = /^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+?)(?: ON CONFLICT \(([^)]+)\) DO (NOTHING|UPDATE SET (.+?)))?$/.exec(text);
    if (!insert) throw new Error(`unexpected SQL: ${text}`);
    const [, name, columnList, , conflictList, action, assignments] = insert;
    const columns = (columnList as string).split(',').map((c) => c.trim());
    const rows = table(name as string);
    if (conflictList) {
      const target = conflictList.split(',').map((c) => c.trim());
      if (!uniqueKeys(name as string).some((k) => k.length === target.length && k.every((c) => target.includes(c)))) {
        throw new Error(`there is no unique or exclusion constraint matching the ON CONFLICT specification (${name}: ${target.join(', ')})`);
      }
    }
    let written = 0;
    for (let i = 0; i < params.length; i += columns.length) {
      const incoming: Row = Object.fromEntries(columns.map((c, j) => [c, params[i + j]]));
      const target = conflictList?.split(',').map((c) => c.trim());
      const existing = target ? rows.find((r) => target.every((c) => same(r[c], incoming[c]))) : undefined;
      if (!existing) {
        rows.push(incoming);
        written += 1;
      } else if (action?.startsWith('UPDATE')) {
        for (const part of (assignments as string).split(/ WHERE /)[0]!.split(', ')) {
          const set = /^(\w+) = EXCLUDED\.(\w+)$/.exec(part);
          if (set) existing[set[1] as string] = incoming[set[2] as string];
        }
        written += 1;
      }
    }
    return ok([], written);
  };

  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, tables, table };
}

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'Modified',
    key: ['Job'],
    fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty' },
  },
  unit_steps: {
    entity_set: 'UnitSteps',
    watermark_field: 'Done',
    // One row per unit per operation, the shape DATASET_SPECS describes.
    key: ['StepId'],
    fields: { unit_id: 'Unit', job_number: 'Job', product_number: 'Product', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
  },
  defects: {
    entity_set: 'Defects',
    watermark_field: 'Modified',
    // Typical defects key from docs/MAPPING.md.
    key: ['DefectId'],
    fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', operator: 'User', defect_code: 'Code', found_ts: 'Found', status: 'Status', modified_at: 'Modified' },
  },
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

function harness(mode: 'offset_present' | 'utc' | 'local_no_offset') {
  const db = memoryDb();
  const timestamps = new TimestampResolver({ mode, timezone: 'America/New_York' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  return { db, timestamps, ingestor };
}

const stepRow = { StepId: 'S-1', Unit: 'U-1', Job: 'J-1', Product: 'P-1', Op: 'Weld', User: 'ann', Start: '2026-06-01T10:05:00', Done: '2026-06-01T10:20:00' };

describe('re-reading a row with a different parsed timestamp', () => {
  it('control: re-reading an unchanged row in the same mode stays one row (the overlap re-pull is idempotent)', async () => {
    const { db, ingestor } = harness('utc');
    await ingestor.ingest('unit_steps', [stepRow]);
    await ingestor.ingest('unit_steps', [stepRow]);
    expect(db.table('unit_steps').filter((r) => r.natural_key === 'S-1')).toHaveLength(1);
  });

  it('unit_steps: fixing fl_timestamp_mode and re-reading the overlap leaves one row per natural key, not two', async () => {
    const { db, timestamps, ingestor } = harness('utc');

    // The plant sees hours shifted, and docs/OPERATIONS.md says: fix the timestamp mode in Admin > Connection.
    await ingestor.ingest('unit_steps', [stepRow]);
    timestamps.configure('local_no_offset', 'America/New_York'); // what Collector.reloadConfig does on the restart command
    // The next overlap / late-data / backfill pull returns the same FactoryLogix row again.
    await ingestor.ingest('unit_steps', [stepRow]);

    const starts = db
      .table('unit_steps')
      .filter((r) => r.natural_key === 'S-1')
      .map((r) => (r.start_ts as Date).toISOString());
    expect(starts).toEqual(['2026-06-01T14:05:00.000Z']);
  });

  it('unit_steps: the unit is counted once in hour_cells after the mode fix', async () => {
    const { db, timestamps, ingestor } = harness('utc');
    await ingestor.ingest('unit_steps', [stepRow]);
    timestamps.configure('local_no_offset', 'America/New_York');
    await ingestor.ingest('unit_steps', [stepRow]);

    const steps: UnitStep[] = db.table('unit_steps').map((r) => ({
      unit_id: r.unit_id as string,
      job_number: r.job_number as string,
      product_number: r.product_number as string,
      operation: 'Weld',
      operation_seq: null,
      operator_id: r.operator_id as string,
      start_ts: (r.start_ts as Date).getTime(),
      complete_ts: (r.complete_ts as Date).getTime(),
      result: null,
      rework_flag: null,
    }));
    const from = Date.parse('2026-06-01T00:00:00Z');
    const { cells } = computeHourCells({
      steps,
      breaks: [],
      standards: new Map(),
      pins: [],
      settings: pickEngineSettings({ ...DEFAULT_SETTINGS, plant_timezone: 'America/New_York' }),
      from_utc: from,
      to_utc: from + 24 * HOUR,
      now: from + 23 * HOUR,
    });
    expect(cells.reduce((sum, c) => sum + c.units, 0)).toBe(1);
  });

  it('defects: a corrected found time under the usual DefectId key does not add a second defect', async () => {
    const { db, ingestor } = harness('offset_present');
    const defect = { DefectId: 'D-9', Unit: 'U-1', Job: 'J-1', Op: 'Weld', User: 'ann', Code: 'SCRATCH', Status: 'Open', Modified: '2026-06-01T15:00:00Z' };

    await ingestor.ingest('defects', [{ ...defect, Found: '2026-06-01T14:10:00Z' }]);
    // QA corrects the found time; FactoryLogix bumps Modified, the next poll returns the row again.
    await ingestor.ingest('defects', [{ ...defect, Found: '2026-06-01T14:40:00Z', Modified: '2026-06-01T15:30:00Z' }]);

    const found = db
      .table('defects')
      .filter((r) => r.natural_key === 'D-9')
      .map((r) => (r.found_ts as Date).toISOString());
    expect(found).toEqual(['2026-06-01T14:40:00.000Z']);
  });
});
