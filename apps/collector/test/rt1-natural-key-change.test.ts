/**
 * Red team (data integrity): changing a data source's natural key in Admin > Mapping made every
 * row read again a second row. unit_steps and defects are unique on (natural_key, start_ts /
 * found_ts) and the natural key is built from the mapped key fields, so once the unit_steps key
 * went from [UnitHistoryId] to [UnitHistoryId, Operation], the overlap, the hourly late-data
 * re-pull and "Run backfill now" stored "48210|OP10" next to the stored "48210", and the units of
 * every hour they touched doubled, for good.
 *
 * The API now keeps the keys a dataset had before (`mapping_key_history`, `nextMappingKeyHistory`)
 * and the collector reads their fields as well, to replace the copy stored under an old key. The
 * real Poller and Ingestor run against an in-memory database that takes its unique keys from
 * 0001_init.sql and rejects an ON CONFLICT no constraint backs (as rt1-duplicate-rows.test.ts
 * does), and a fake FactoryLogix that answers $filter and $select like the real service and
 * refuses a $select naming a field the entity set does not have.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeHourCells } from '@fld/engine';
import {
  DEFAULT_SETTINGS,
  MAPPING_KEY_HISTORY,
  nextMappingKeyHistory,
  pickEngineSettings,
  withPreviousKeys,
  type MappingConfig,
  type MappingKeyHistory,
  type Settings,
  type UnitStep,
} from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Ingestor } from '../src/ingest/datasets.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';
import { TimestampResolver } from '../src/mapping/extract.js';
import { loadConfig } from '../src/settings.js';
import type { Source, SourceRequest } from '../src/sources/Source.js';
import { Poller } from '../src/sync/poller.js';

const MIN = 60_000;
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
  const syncState = new Map<string, Row>();
  let logId = 0;
  const table = (name: string): Row[] => (tables[name] ??= []);
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });
  const returning = (rows: Row[], columns: string) => rows.map((r) => Object.fromEntries(columns.split(', ').map((c) => [c, r[c]])));

  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return ok();
    if (text.includes('FROM sync_state WHERE source')) {
      const found = syncState.get(params[0] as string);
      return ok(found ? [{ ...found }] : []);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_success_at')) {
      const [source, watermark] = params as [string, string | null];
      const previous = syncState.get(source) ?? {};
      syncState.set(source, { source, ...previous, consecutive_failures: 0, watermark: watermark ?? previous.watermark ?? null });
      return ok([], 1);
    }
    if (text.startsWith('INSERT INTO sync_state (source, watermark, last_error')) {
      const source = params[0] as string;
      const previous = syncState.get(source) ?? {};
      syncState.set(source, { source, ...previous, last_error: params[1], consecutive_failures: Number(previous.consecutive_failures ?? 0) + 1 });
      return ok([], 1);
    }
    if (text.startsWith('INSERT INTO sync_log')) return ok([{ id: (logId += 1) }]);
    if (text.startsWith('UPDATE sync_log')) return ok([], 1);
    if (text.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return ok();
    }
    if (text.startsWith('SELECT id, name FROM operations WHERE name = ANY')) {
      return ok((params[0] as string[]).filter((n) => operations.has(n)).map((name) => ({ id: operations.get(name), name })));
    }
    if (text.startsWith('SELECT 1 AS ok FROM information_schema.columns')) return ok([{ ok: 1 }]);
    if (text.startsWith('SELECT job_number, product_number FROM work_orders')) {
      const jobs = params[0] as string[];
      return ok(table('work_orders').filter((r) => jobs.includes(r.job_number as string)));
    }
    if (text.startsWith('SELECT product_number, operation_id, sequence FROM product_routes')) return ok();
    if (text.startsWith('INSERT INTO raw_event_hashes')) {
      const changed: Row[] = [];
      for (let i = 0; i < params.length; i += 3) changed.push({ source: params[i], natural_key: params[i + 1] });
      return ok(changed);
    }
    // Stored copies of the page's keys at other times ($1/$2 are the page's key/time pairs, $3..$4 the window).
    const moved =
      /^DELETE FROM (\w+) WHERE natural_key = ANY\(\$1::text\[\]\) AND (\w+) BETWEEN \$3 AND \$4 AND \(natural_key, \2\) NOT IN \(SELECT \* FROM unnest\(\$1::text\[\], \$2::timestamptz\[\]\)\) RETURNING (.+)$/.exec(
        text,
      );
    if (moved) {
      const [, name, time, columns] = moved as unknown as [string, string, string, string];
      const [keys, ats, from, to] = params as [string[], Date[], Date, Date];
      const stale = (r: Row): boolean =>
        keys.includes(r.natural_key as string) &&
        (r[time] as Date) >= from &&
        (r[time] as Date) <= to &&
        !keys.some((k, i) => k === r.natural_key && same(ats[i], r[time]));
      const gone = table(name).filter(stale);
      tables[name] = table(name).filter((r) => !stale(r));
      return ok(returning(gone, columns));
    }
    // Copies stored under an old key ($1: old keys, with the record's time, unit, job and operation
    // in $2..$5; $6..$7 the window; $8/$9 the page's own key/time pairs).
    const rekeyed =
      /^DELETE FROM (\w+) WHERE natural_key = ANY\(\$1::text\[\]\) AND (\w+) BETWEEN \$6 AND \$7 AND \(\(natural_key, \2\) IN \(SELECT \* FROM unnest\(\$1::text\[\], \$2::timestamptz\[\]\)\) OR \(natural_key, unit_id, job_number, operation_id\) IN \(SELECT \* FROM unnest\(\$1::text\[\], \$3::text\[\], \$4::text\[\], \$5::int\[\]\)\)\) AND \(natural_key, \2\) NOT IN \(SELECT \* FROM unnest\(\$8::text\[\], \$9::timestamptz\[\]\)\) RETURNING (.+)$/.exec(
        text,
      );
    if (rekeyed) {
      const [, name, time, columns] = rekeyed as unknown as [string, string, string, string];
      const [keys, ats, units, jobs, ops, from, to, ownKeys, ownAts] = params as [string[], Date[], string[], string[], number[], Date, Date, string[], Date[]];
      const sameStep = (r: Row, i: number): boolean => units[i] === r.unit_id && jobs[i] === r.job_number && ops[i] === r.operation_id;
      const stale = (r: Row): boolean =>
        (r[time] as Date) >= from &&
        (r[time] as Date) <= to &&
        keys.some((k, i) => k === r.natural_key && (same(ats[i], r[time]) || sameStep(r, i))) &&
        !ownKeys.some((k, i) => k === r.natural_key && same(ownAts[i], r[time]));
      const gone = table(name).filter(stale);
      tables[name] = table(name).filter((r) => !stale(r));
      return ok(returning(gone, columns));
    }
    const insert = /^INSERT INTO (\w+) \(([^)]+)\) VALUES (.+?)(?: ON CONFLICT \(([^)]+)\) DO (NOTHING|UPDATE SET (.+?)))?$/.exec(text);
    if (!insert) throw new Error(`unexpected SQL: ${text}`);
    const [, name, columnList, , conflictList, action, assignments] = insert;
    const columns = (columnList as string).split(',').map((c) => c.trim());
    const rows = table(name as string);
    const target = conflictList?.split(',').map((c) => c.trim());
    if (target && !uniqueKeys(name as string).some((k) => k.length === target.length && k.every((c) => target.includes(c)))) {
      throw new Error(`there is no unique or exclusion constraint matching the ON CONFLICT specification (${name}: ${target.join(', ')})`);
    }
    let written = 0;
    for (let i = 0; i < params.length; i += columns.length) {
      const incoming: Row = Object.fromEntries(columns.map((c, j) => [c, params[i + j]]));
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
  return { pool, table, operations };
}

/** An entity set as FactoryLogix has it: its fields with their EDM types ($metadata) and its rows. */
interface EntitySet {
  fields: Record<string, string>;
  rows: Row[];
}

/** Applies `field ge/gt/le/lt <iso>` terms from $filter and the $select, as OData does. */
function factoryLogix(sets: Record<string, EntitySet>) {
  const selects: { entitySet: string; select: string[] }[] = [];
  const matches = (row: Row, filter: string | null | undefined): boolean => {
    if (!filter) return true;
    for (const term of filter.matchAll(/(\w+) (ge|gt|le|lt) (\S+?)\)?(?= and |$)/g)) {
      const [, field, op, literal] = term as unknown as [string, string, 'ge' | 'gt' | 'le' | 'lt', string];
      const left = Date.parse(String(row[field]));
      const right = Date.parse(literal.replace(/^\(+/, ''));
      if (Number.isNaN(left) || Number.isNaN(right)) return false;
      if (op === 'ge' && !(left >= right)) return false;
      if (op === 'gt' && !(left > right)) return false;
      if (op === 'le' && !(left <= right)) return false;
      if (op === 'lt' && !(left < right)) return false;
    }
    return true;
  };
  const source: Source = {
    kind: 'odata',
    init: async () => undefined,
    getMetadata: () => null,
    version: () => '4.0',
    edmType: (entitySet, field) => sets[entitySet]?.fields[field] ?? null,
    literal: (_set, _field, value) => (value.kind === 'timestamp' ? new Date(value.ms).toISOString() : String(value)),
    describe: () => '',
    fetchPage: async (req: SourceRequest) => {
      const set = sets[req.entitySet];
      if (!set) throw new Error(`HTTP 404: no entity set ${req.entitySet}`);
      const select = req.select ?? Object.keys(set.fields);
      const unknown = select.find((field) => !(field in set.fields));
      if (unknown) throw new Error(`HTTP 400: Could not find a property named '${unknown}' on '${req.entitySet}'`);
      selects.push({ entitySet: req.entitySet, select });
      const all = set.rows.filter((r) => matches(r, req.filter)).map((r) => Object.fromEntries(select.map((f) => [f, r[f] ?? null])));
      const skip = req.skip ?? 0;
      return { rows: all.slice(skip, skip + (req.top ?? 500)), nextLink: null };
    },
    close: async () => undefined,
  };
  return { source, selects };
}

const STEP_FIELDS = {
  UnitHistoryId: 'Edm.Int32',
  Unit: 'Edm.String',
  Job: 'Edm.String',
  Product: 'Edm.String',
  Operation: 'Edm.String',
  User: 'Edm.String',
  Start: 'Edm.DateTimeOffset',
  Done: 'Edm.DateTimeOffset',
};

function mappingWith(stepKey: string[], defectKey: string[] = ['DefectId']): MappingConfig {
  return {
    work_orders: {
      entity_set: 'WorkOrders',
      watermark_field: 'Modified',
      key: ['Job'],
      fields: { job_number: 'Job', product_number: 'Product', qty_released: 'Qty', modified_at: 'Modified' },
    },
    unit_steps: {
      entity_set: 'UnitHistory',
      watermark_field: 'Done',
      key: stepKey,
      fields: { unit_id: 'Unit', job_number: 'Job', product_number: 'Product', operation: 'Operation', operator: 'User', start_ts: 'Start', complete_ts: 'Done' },
    },
    defects: {
      entity_set: 'Defects',
      watermark_field: 'Modified',
      key: defectKey,
      fields: { unit_id: 'Unit', job_number: 'Job', operation: 'Operation', operator: 'User', defect_code: 'Code', found_ts: 'Found', modified_at: 'Modified' },
    },
    operators: null,
    routes: null,
    standards: null,
  } as unknown as MappingConfig;
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC' }; // 10 min overlap, hourly 24 h late-data re-pull

const iso = (ms: number): string => new Date(ms).toISOString();
const step = (id: number, start: number): Row => ({
  UnitHistoryId: id,
  Unit: `U-${id}`,
  Job: 'J-1',
  Product: 'P-1',
  Operation: 'OP10',
  User: 'ann',
  Start: iso(start),
  Done: iso(start + 4 * MIN),
});
const defect = (id: string, found: number): Row => ({
  DefectId: id,
  Unit: 'U-48210',
  Job: 'J-1',
  Operation: 'OP10',
  User: 'ann',
  Code: 'SCRATCH',
  Found: iso(found),
  Modified: iso(found),
});

const H8 = Date.parse('2026-06-02T08:00:00Z');
const OLD_DAY = Date.parse('2026-05-30T00:00:00Z');
/** First poll: 09:30. The 08:00 hour has 12 completed steps by one operator, one every 5 minutes. */
const T0 = Date.parse('2026-06-02T09:30:00Z');

function plant(stepFields: Record<string, string> = STEP_FIELDS) {
  return {
    WorkOrders: {
      fields: { Job: 'Edm.String', Product: 'Edm.String', Qty: 'Edm.Int32', Modified: 'Edm.DateTimeOffset' },
      rows: [{ Job: 'J-1', Product: 'P-1', Qty: 100, Modified: iso(H8 - HOUR) }],
    },
    UnitHistory: {
      fields: stepFields,
      rows: [
        // Three days ago: only the backfill reads these.
        ...Array.from({ length: 4 }, (_, i) => step(47000 + i, OLD_DAY + 8 * HOUR + i * 5 * MIN)),
        ...Array.from({ length: 12 }, (_, i) => step(48210 + i, H8 + i * 5 * MIN)),
      ],
    },
    Defects: {
      fields: {
        DefectId: 'Edm.String',
        Unit: 'Edm.String',
        Job: 'Edm.String',
        Operation: 'Edm.String',
        User: 'Edm.String',
        Code: 'Edm.String',
        Found: 'Edm.DateTimeOffset',
        Modified: 'Edm.DateTimeOffset',
      },
      rows: [defect('D-1', H8 + 30 * MIN), defect('D-2', H8 + 45 * MIN)],
    },
  };
}

function harness(first: MappingConfig, sets = plant()) {
  const db = memoryDb();
  const fl = factoryLogix(sets);
  const timestamps = new TimestampResolver({ mode: 'offset_present', timezone: 'UTC' });
  const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, first);
  const poller = new Poller({ pool: db.pool, log, ingestor, timestamps }, fl.source);
  let mapping = first;
  let history: MappingKeyHistory = {};
  return {
    db,
    fl,
    poll: (now: number) => poller.pollOnce(mapping, settings, now),
    /** "Run backfill now" for one day of unit steps. */
    backfill: (day: number) =>
      poller.pullWindow('unit_steps', mapping.unit_steps, settings, { from: day, to: day + 24 * HOUR, logSource: 'unit_steps:backfill' }),
    /** PUT /api/admin/mapping (services/mapping.ts saveMapping), then the restart command: loadConfig and Collector.reloadConfig. */
    save(next: MappingConfig) {
      history = nextMappingKeyHistory(history, mapping, next);
      mapping = withPreviousKeys(next, history);
      ingestor.setMapping(mapping);
    },
  };
}

/** Units the hour cell engine counts in `hour` from what unit_steps holds. */
function unitsInHour(table: (name: string) => Row[], hour: number): number {
  const steps: UnitStep[] = table('unit_steps').map((r) => ({
    unit_id: r.unit_id as string,
    job_number: r.job_number as string,
    product_number: r.product_number as string,
    operation: 'OP10',
    operation_seq: null,
    operator_id: r.operator_id as string,
    start_ts: (r.start_ts as Date).getTime(),
    complete_ts: (r.complete_ts as Date).getTime(),
    result: null,
    rework_flag: null,
  }));
  const { cells } = computeHourCells({
    steps,
    breaks: [],
    standards: new Map(),
    pins: [],
    settings: pickEngineSettings(settings),
    from_utc: hour,
    to_utc: hour + HOUR,
    now: T0 + 2 * HOUR,
  });
  return cells.filter((c) => c.hour_start_utc === hour).reduce((sum, c) => sum + c.units, 0);
}

const keysOf = (rows: Row[]): string[] => rows.map((r) => r.natural_key as string).sort();

describe('changing the natural key of a data source that already has rows', () => {
  it('control: polling again with the same key keeps one row per step and per defect', async () => {
    const h = harness(mappingWith(['UnitHistoryId']));
    expect((await h.poll(T0)).ok).toBe(true);
    expect((await h.poll(T0 + 61 * MIN)).ok).toBe(true);
    expect(h.db.table('unit_steps')).toHaveLength(12);
    expect(h.db.table('defects')).toHaveLength(2);
    expect(unitsInHour(h.db.table, H8)).toBe(12);
  });

  it('a key that gains a field: the overlap, the late-data re-pull and the backfill re-key the rows instead of adding a second copy', async () => {
    const h = harness(mappingWith(['UnitHistoryId']));
    await h.backfill(OLD_DAY);
    expect((await h.poll(T0)).ok).toBe(true);
    expect(h.db.table('unit_steps')).toHaveLength(16);
    expect(h.db.table('defects')).toHaveLength(2);
    expect(unitsInHour(h.db.table, H8)).toBe(12);

    // Admin > Mapping: the key gets the operation as well.
    h.save(mappingWith(['UnitHistoryId', 'Operation'], ['DefectId', 'Operation']));
    // The overlap re-reads the last 10 minutes; an hour after the last one, the late-data re-pull re-reads the last 24 hours.
    expect((await h.poll(T0 + 61 * MIN)).ok).toBe(true);

    expect(h.db.table('unit_steps')).toHaveLength(16);
    expect(h.db.table('defects')).toHaveLength(2);
    expect(unitsInHour(h.db.table, H8)).toBe(12);
    expect(keysOf(h.db.table('defects'))).toEqual(['D-1|OP10', 'D-2|OP10']);
    // Rows nothing read again keep the key they were stored with, once.
    expect(keysOf(h.db.table('unit_steps')).filter((k) => k.startsWith('47'))).toEqual(['47000', '47001', '47002', '47003']);

    // "Run backfill now" reads those older days again.
    await h.backfill(OLD_DAY);
    expect(h.db.table('unit_steps')).toHaveLength(16);
    expect(keysOf(h.db.table('unit_steps')).filter((k) => k.startsWith('47'))).toEqual(['47000|OP10', '47001|OP10', '47002|OP10', '47003|OP10']);
    expect(unitsInHour(h.db.table, OLD_DAY + 8 * HOUR)).toBe(4);
  });

  it('a key whose field the new mapping no longer uses: the pull still reads that field, so the stored rows are found', async () => {
    const h = harness(mappingWith(['UnitHistoryId']));
    expect((await h.poll(T0)).ok).toBe(true);

    // Natural key from the docs' typical unit + job + operation + start instead of the history id.
    h.save(mappingWith(['Unit', 'Job', 'Operation', 'Start']));
    expect((await h.poll(T0 + 61 * MIN)).ok).toBe(true);

    const stepPulls = h.fl.selects.filter((s) => s.entitySet === 'UnitHistory').slice(-1);
    expect(stepPulls[0]?.select).toContain('UnitHistoryId');
    expect(h.db.table('unit_steps')).toHaveLength(12);
    expect(unitsInHour(h.db.table, H8)).toBe(12);
  });

  it('a key changed twice, and one changed back, leave one row per step', async () => {
    const h = harness(mappingWith(['UnitHistoryId']));
    expect((await h.poll(T0)).ok).toBe(true);
    h.save(mappingWith(['UnitHistoryId', 'Operation']));
    expect((await h.poll(T0 + 61 * MIN)).ok).toBe(true);
    h.save(mappingWith(['Unit', 'Job', 'Operation', 'Start']));
    expect((await h.poll(T0 + 122 * MIN)).ok).toBe(true);
    expect(h.db.table('unit_steps')).toHaveLength(12);

    h.save(mappingWith(['UnitHistoryId']));
    expect((await h.poll(T0 + 183 * MIN)).ok).toBe(true);
    expect(h.db.table('unit_steps')).toHaveLength(12);
    expect(keysOf(h.db.table('unit_steps'))[0]).toBe('48210');
    expect(unitsInHour(h.db.table, H8)).toBe(12);
  });

  it('an old key field FactoryLogix no longer has is not asked for, so the data source keeps polling', async () => {
    const sets = plant({ ...STEP_FIELDS, LegacyId: 'Edm.Int32' });
    for (const row of sets.UnitHistory.rows) row.LegacyId = (row.UnitHistoryId as number) + 900_000;
    const h = harness(mappingWith(['LegacyId']), sets);
    expect((await h.poll(T0)).ok).toBe(true);

    // FactoryLogix drops LegacyId (an upgrade); the admin maps the key to UnitHistoryId.
    delete (sets.UnitHistory.fields as Record<string, string>).LegacyId;
    h.save(mappingWith(['UnitHistoryId']));
    const outcome = await h.poll(T0 + 61 * MIN);

    expect(outcome.error).toBeNull();
    expect(h.fl.selects.filter((s) => s.entitySet === 'UnitHistory').slice(-1)[0]?.select).not.toContain('LegacyId');
  });
});

describe('the copy stored under an old key', () => {
  const stepMapping = (key: string[]) => mappingWith(key);

  function ingestHarness(mode: 'utc' | 'local_no_offset' | 'offset_present' = 'offset_present') {
    const db = memoryDb();
    const timestamps = new TimestampResolver({ mode, timezone: 'America/New_York' });
    const ingestor = new Ingestor({ pool: db.pool, log, operations: new OperationCache(db.pool), timestamps }, stepMapping(['UnitHistoryId']));
    return { db, timestamps, ingestor };
  }

  it('is found when the time moved as well (timestamp mode fixed after the key changed)', async () => {
    const { db, timestamps, ingestor } = ingestHarness('utc');
    const naive = { ...step(48210, 0), Start: '2026-06-01T10:05:00', Done: '2026-06-01T10:20:00' };
    await ingestor.ingest('unit_steps', [naive]);

    const next = stepMapping(['UnitHistoryId', 'Operation']);
    ingestor.setMapping(withPreviousKeys(next, nextMappingKeyHistory({}, stepMapping(['UnitHistoryId']), next)));
    timestamps.configure('local_no_offset', 'America/New_York');
    const { touched } = await ingestor.ingest('unit_steps', [naive]);

    expect(db.table('unit_steps').map((r) => [r.natural_key, (r.start_ts as Date).toISOString()])).toEqual([['48210|OP10', '2026-06-01T14:05:00.000Z']]);
    // The hour the old copy was counted in is recomputed.
    expect(touched).toContain(Date.parse('2026-06-01T10:05:00Z'));
  });

  it('is only ever the same record: another unit whose new key reads like an old one stays', async () => {
    const { db, ingestor } = ingestHarness();
    const next = mappingWith(['StepNo']);
    ingestor.setMapping(withPreviousKeys(next, nextMappingKeyHistory({}, stepMapping(['UnitHistoryId']), next)));

    // U-B's step number happens to be 48210, the history id of U-A's step, an hour earlier.
    const other = { ...step(1, Date.parse('2026-06-01T13:00:00Z')), Unit: 'U-B', StepNo: 48210 };
    await ingestor.ingest('unit_steps', [other]);
    await ingestor.ingest('unit_steps', [{ ...step(48210, Date.parse('2026-06-01T14:00:00Z')), Unit: 'U-A', StepNo: 7 }]);

    expect(keysOf(db.table('unit_steps'))).toEqual(['48210', '7']);
  });

  it('is only that step when the old key did not tell the unit\'s steps apart', async () => {
    const { db, ingestor } = ingestHarness();
    ingestor.setMapping(mappingWith(['Unit']));
    const weld = { ...step(1, Date.parse('2026-06-01T08:00:00Z')), Unit: 'U-1' };
    const test = { ...step(2, Date.parse('2026-06-01T08:30:00Z')), Unit: 'U-1', Operation: 'OP20' };
    await ingestor.ingest('unit_steps', [weld, test]);

    // The key is fixed; the overlap reads the later step again, the earlier one is not read yet.
    const next = mappingWith(['Unit', 'Operation']);
    ingestor.setMapping(withPreviousKeys(next, nextMappingKeyHistory({}, mappingWith(['Unit']), next)));
    await ingestor.ingest('unit_steps', [test]);

    expect(db.table('unit_steps').map((r) => r.natural_key).sort()).toEqual(['U-1', 'U-1|OP20']);
  });
});

describe('loadConfig', () => {
  it('hands the collector the mapping with the keys its datasets had before', async () => {
    const saved = mappingWith(['UnitHistoryId', 'Operation']);
    const history = { unit_steps: [['UnitHistoryId']], defects: [['DefectId', 'Operation']] };
    const rows = [
      { key: 'mapping', value: saved },
      { key: MAPPING_KEY_HISTORY, value: history },
    ];
    const db = { query: async () => ({ rows, rowCount: rows.length }) } as unknown as Pool;

    const { mapping } = await loadConfig(db, { encryptionKey: '0'.repeat(64), fallbackTimezone: 'UTC' });

    expect(mapping?.unit_steps.previous_keys).toEqual([['UnitHistoryId']]);
    expect(mapping?.unit_steps.key).toEqual(['UnitHistoryId', 'Operation']);
    expect(mapping?.defects?.previous_keys).toEqual([['DefectId', 'Operation']]);
    expect(mapping?.work_orders.previous_keys).toBeUndefined();
  });
});
