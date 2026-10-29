import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type MappingConfig, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

/** What PostgreSQL itself refuses to store (docs 8.3 and 8.14), with the errors it raises. */
function pgInputError(sql: string, params: unknown[]): Error | null {
  for (const value of params) {
    if (typeof value !== 'string') continue;
    // text/varchar/jsonb parameters: "the character with code zero (NUL) cannot be stored".
    if (value.includes('\u0000')) {
      return Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' });
    }
    if (sql.startsWith('INSERT INTO raw_events')) {
      // jsonb input: "jsonb also rejects \u0000"; an unpaired surrogate escape is invalid JSON.
      if (/\\u0000/.test(value)) {
        return Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' });
      }
      if (/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(value)) {
        return Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' });
      }
    }
  }
  return null;
}

/** sync_state / sync_log in memory, real BEGIN/COMMIT/ROLLBACK, PostgreSQL's input checks. */
function fakePg() {
  const state = new Map<string, { watermark: string | null; consecutive_failures: number }>();
  const committed: { sql: string; params: unknown[] }[] = [];
  let nextLogId = 0;

  const run = async (sql: string, params: unknown[], pending: { sql: string; params: unknown[] }[] | null) => {
    const err = pgInputError(sql, params);
    if (err) throw err;
    if (sql.includes('FROM sync_state WHERE source')) {
      const found = state.get(params[0] as string);
      return {
        rows: found
          ? [{ source: params[0], watermark: found.watermark, last_success_at: null, last_error: null, consecutive_failures: found.consecutive_failures, rows_last_poll: null, duration_ms_last_poll: null, backfill_progress: null }]
          : [],
        rowCount: found ? 1 : 0,
      };
    }
    if (sql.includes('INSERT INTO sync_state (source, watermark, last_success_at')) {
      const [source, watermark] = params as [string, string | null];
      state.set(source, { watermark: watermark ?? state.get(source)?.watermark ?? null, consecutive_failures: 0 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO sync_state (source, watermark, last_error')) {
      const source = params[0] as string;
      const prev = state.get(source);
      state.set(source, { watermark: (params[3] as string | null) ?? prev?.watermark ?? null, consecutive_failures: (prev?.consecutive_failures ?? 0) + 1 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO sync_log')) return { rows: [{ id: ++nextLogId }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO raw_event_hashes')) {
      // Every key is new: RETURNING gives back each (source, natural_key).
      const rows: { source: unknown; natural_key: unknown }[] = [];
      for (let i = 0; i < params.length; i += 3) rows.push({ source: params[i], natural_key: params[i + 1] });
      (pending ?? committed).push({ sql, params });
      return { rows, rowCount: rows.length };
    }
    (pending ?? committed).push({ sql, params });
    return { rows: [], rowCount: 0 };
  };

  const pool = {
    query: async (sql: string, params: unknown[] = []) => run(sql, params, null),
    connect: async () => {
      let pending: { sql: string; params: unknown[] }[] | null = null;
      return {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql === 'BEGIN') {
            pending = [];
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'COMMIT') {
            committed.push(...(pending ?? []));
            pending = null;
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'ROLLBACK') {
            pending = null;
            return { rows: [], rowCount: 0 };
          }
          return run(sql, params, pending);
        },
        release: () => undefined,
      };
    },
  };
  return { pool: pool as unknown as Pool, state, committed };
}

function fakeSource(rows: Record<string, Record<string, unknown>[]>) {
  const requests: SourceRequest[] = [];
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: () => null,
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
    describe: () => '',
    fetchPage: async (req) => {
      requests.push(req);
      return { rows: (req.skip ?? 0) === 0 ? (rows[req.entitySet] ?? []) : [], nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, requests };
}

const mapping = {
  work_orders: {
    entity_set: 'WorkOrders',
    watermark_field: 'Modified',
    key: ['Job'],
    fields: { job_number: 'Job', product_number: 'Product', product_name: 'ProductName', qty_released: 'Qty', modified_at: 'Modified' },
  },
  unit_steps: {
    entity_set: 'UnitSteps',
    watermark_field: 'Modified',
    key: ['Id'],
    fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', operator: 'User', start_ts: 'Start', complete_ts: 'Done', modified_at: 'Modified' },
  },
  defects: {
    entity_set: 'Defects',
    watermark_field: 'Modified',
    key: ['DefectId'],
    fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Op', found_ts: 'Found', description: 'Text', modified_at: 'Modified' },
  },
  operators: null,
  routes: null,
  standards: null,
} as unknown as MappingConfig;

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC', late_data_hours: 0 };
const NOW = Date.parse('2025-03-04T12:00:00Z');

function harness(rows: Record<string, Record<string, unknown>[]>) {
  const db = fakePg();
  const src = fakeSource(rows);
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, mapping);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, src.source);
  return { poller, db, src };
}

const committedWorkOrders = (db: ReturnType<typeof fakePg>) =>
  db.committed.filter((c) => c.sql.startsWith('INSERT INTO work_orders')).flatMap((c) => c.params.filter((p) => typeof p === 'string' && /^J-/.test(p)));

describe('values PostgreSQL cannot store', () => {
  it('a work order whose product name carries a NUL character does not stop every poll', async () => {
    const { poller, db, src } = harness({
      WorkOrders: [
        // Fixed-width / scanner text often ends in NUL padding; FactoryLogix (SQL Server) stores it.
        { Job: 'J-1', Product: 'P-1', ProductName: 'Bracket\u0000', Qty: 10, Modified: '2025-03-04T11:00:00Z' },
        { Job: 'J-2', Product: 'P-2', ProductName: 'Housing', Qty: 5, Modified: '2025-03-04T11:01:00Z' },
      ],
      UnitSteps: [{ Id: 's1', Unit: 'U1', Job: 'J-2', Op: 'Solder', User: 'jdoe', Start: '2025-03-04T11:10:00Z', Done: '2025-03-04T11:12:00Z', Modified: '2025-03-04T11:12:00Z' }],
    });

    for (let poll = 0; poll < 2; poll++) {
      const outcome = await poller.pollOnce(mapping, settings, NOW + poll * 60_000);
      expect(outcome.error).toBeNull();
      expect(outcome.ok).toBe(true);
    }
    // The other work order on the page and the unit steps after it are stored.
    expect(committedWorkOrders(db)).toContain('J-2');
    expect(src.requests.some((r) => r.entitySet === 'UnitSteps')).toBe(true);
    expect(db.state.get('work_orders')?.watermark).toBe('2025-03-04T11:01:00.000Z');
  });

  it('a defect description ending in half of an emoji (unpaired surrogate) does not stop the defects poll', async () => {
    const { poller } = harness({
      WorkOrders: [{ Job: 'J-2', Product: 'P-2', ProductName: 'Housing', Qty: 5, Modified: '2025-03-04T11:01:00Z' }],
      UnitSteps: [],
      // An nvarchar column truncated in the middle of a surrogate pair ("Scratch 😬" cut to 9 UTF-16 units).
      Defects: [{ DefectId: 'd1', Unit: 'U1', Job: 'J-2', Op: 'Solder', Found: '2025-03-04T11:20:00Z', Text: 'Scratch \ud83d', Modified: '2025-03-04T11:20:00Z' }],
    });

    const outcome = await poller.pollOnce(mapping, settings, NOW);
    expect(outcome.error).toBeNull();
    expect(outcome.ok).toBe(true);
  });
});
