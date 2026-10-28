/**
 * A record read again with a different parsed time replaces its stored copy (proof in
 * rt1-duplicate-rows.test.ts). Here: the hours the removed copy was counted in are recomputed,
 * the delete stays near the page, and rows without a usable key are left alone.
 */
import { describe, expect, it } from 'vitest';
import type { MappingConfig } from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';

const DAY = 86_400_000;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** Records the stale-copy deletes and answers them with `deleted`; every other statement returns no rows. */
function recordingPool(deleted: Record<string, Date | null>[] = []) {
  const deletes: unknown[][] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT id, name FROM operations')) {
      return { rows: (params[0] as string[]).map((name, i) => ({ id: i + 1, name })), rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM')) {
      deletes.push(params);
      return { rows: deleted, rowCount: deleted.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, deletes };
}

const mapping = {
  work_orders: { entity_set: 'WorkOrders', watermark_field: null, key: ['Job'], fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty' } },
  unit_steps: {
    entity_set: 'UnitSteps',
    watermark_field: 'Done',
    key: ['StepId'],
    fields: { unit_id: 'Unit', job_number: 'Job', product_number: 'Product', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
  },
  defects: { entity_set: 'Defects', watermark_field: 'Found', key: ['DefectId'], fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', found_ts: 'Found' } },
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

function ingestor(pool: Pool): Ingestor {
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  return new Ingestor({ pool, log, operations: new OperationCache(pool), timestamps }, mapping);
}

const step = { StepId: 'S-1', Unit: 'U-1', Job: 'J-1', Product: 'P-1', Op: 'Weld', User: 'ann', Start: '2026-06-01T14:05:00Z', Done: '2026-06-01T14:20:00Z' };
const iso = (ms: number): string => new Date(ms).toISOString();

describe('stale copies of a record read again', () => {
  it('are looked for within two days of the page, and their start and complete hours are recomputed', async () => {
    const db = recordingPool([{ start_ts: new Date('2026-06-01T10:05:00Z'), complete_ts: new Date('2026-06-01T10:20:00Z') }]);
    const { touched } = await ingestor(db.pool).ingest('unit_steps', [step]);

    const start = Date.parse(step.Start);
    expect(db.deletes).toEqual([[['S-1'], [new Date(start)], new Date(start - 2 * DAY), new Date(start + 2 * DAY)]]);
    expect(touched.map(iso).sort()).toEqual([
      '2026-06-01T10:05:00.000Z',
      '2026-06-01T10:20:00.000Z',
      '2026-06-01T14:05:00.000Z',
      '2026-06-01T14:20:00.000Z',
    ]);
  });

  it('of a defect have their found hour recomputed', async () => {
    const db = recordingPool([{ found_ts: new Date('2026-06-01T14:10:00Z') }]);
    const defect = { DefectId: 'D-9', Unit: 'U-1', Job: 'J-1', Op: 'Weld', Found: '2026-06-01T14:40:00Z' };
    const { touched } = await ingestor(db.pool).ingest('defects', [defect]);
    expect(touched.map(iso).sort()).toEqual(['2026-06-01T14:10:00.000Z', '2026-06-01T14:40:00.000Z']);
  });

  it('are never looked for under a key whose fields are all empty', async () => {
    const db = recordingPool();
    const ingest = ingestor(db.pool);
    await ingest.ingest('unit_steps', [{ ...step, StepId: null }, { ...step, StepId: 'S-2' }]);
    await ingest.ingest('unit_steps', [{ ...step, StepId: '' }]);
    expect(db.deletes.map((params) => params[0])).toEqual([['S-2']]);
  });
});
