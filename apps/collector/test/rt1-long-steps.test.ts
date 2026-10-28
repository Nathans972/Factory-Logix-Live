/**
 * Red team (data integrity): a unit whose step lasted longer than about a day is never counted.
 *
 * Recomputer loads the steps for an hour range with engine/load.ts `loadUnitSteps`, documented as
 * "steps overlapping [from - lookback, to)" and, in ComputeHourCellsInput, "Unit steps for ALL
 * operators/jobs that overlap [from_utc - lookback, to_utc]". The query also demands
 * `start_ts >= from - lookback - 24 h`, so a step that completes inside the range but started more
 * than lookback + 24 h (27 h by default) before it is not loaded, and the engine never sees the unit.
 *
 * The database below evaluates the WHERE clause of the SELECT it receives (comparisons, AND, OR,
 * IS NULL, parentheses over bound parameters), so the test exercises the SQL the collector really
 * sends and not a copy of it. Everything else is a minimal in-memory stand-in.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import { Recomputer } from '../src/engine/recompute.js';
import { OperationCache } from '../src/ingest/operations.js';
import type { Logger } from '../src/logger.js';

const log ={ info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;

type Row = Record<string, unknown>;

// ---- a small WHERE evaluator -------------------------------------------------------------------
type Token = string;
const TOKEN = /\s*(>=|<=|<>|!=|=|>|<|\(|\)|\$\d+(?:::\w+(?:\[\])?)?|'[^']*'|[\w.]+)/gy;

function tokenize(where: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(where); m; m = TOKEN.exec(where)) tokens.push(m[1] as string);
  return tokens;
}

/** Evaluates `a >= $1 AND (b IS NULL OR b >= $3)` style predicates against one row. */
function evaluate(where: string, row: Row, params: unknown[]): boolean {
  const tokens = tokenize(where);
  let pos = 0;
  const peek = () => tokens[pos]?.toUpperCase();
  const value = (token: Token): unknown => {
    if (token.startsWith('$')) {
      const v = params[Number(/^\$(\d+)/.exec(token)![1]) - 1];
      return v instanceof Date ? v.getTime() : v;
    }
    if (token.startsWith("'")) return token.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    const v = row[token.split('.').pop() as string];
    return v instanceof Date ? v.getTime() : v;
  };
  const or = (): boolean => {
    let left = and();
    while (peek() === 'OR') {
      pos += 1;
      const right = and();
      left = left || right;
    }
    return left;
  };
  const and = (): boolean => {
    let left = atom();
    while (peek() === 'AND') {
      pos += 1;
      const right = atom();
      left = left && right;
    }
    return left;
  };
  const atom = (): boolean => {
    if (tokens[pos] === '(') {
      pos += 1;
      const inner = or();
      pos += 1; // ')'
      return inner;
    }
    const left = value(tokens[pos++] as string);
    if (peek() === 'IS') {
      pos += 1;
      const negate = peek() === 'NOT';
      if (negate) pos += 1;
      pos += 1; // NULL
      return negate ? left !== null && left !== undefined : left === null || left === undefined;
    }
    const op = tokens[pos++] as string;
    const right = value(tokens[pos++] as string);
    if (left === null || left === undefined || right === null || right === undefined) return false;
    const l = left as number;
    const r = right as number;
    return { '>=': l >= r, '<=': l <= r, '>': l > r, '<': l < r, '=': l === r, '<>': l !== r, '!=': l !== r }[op] ?? false;
  };
  return or();
}

// ---- in-memory database ------------------------------------------------------------------------
function memoryDb(unitSteps: Row[]) {
  const operations = new Map<string, number>();
  const hourCells: Row[] = [];
  const ok = (rows: Row[] = [], rowCount = rows.length) => ({ rows, rowCount });

  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return ok();
    if (/FROM (shifts|breaks|standard_adjustments|standard_overrides|operator_pins)/.test(text)) return ok();
    if (text.includes('FROM standards s JOIN operations') || text.includes('FROM defects d JOIN operations')) return ok();
    if (text.startsWith('INSERT INTO operations')) {
      for (const name of params[0] as string[]) if (!operations.has(name)) operations.set(name, operations.size + 1);
      return ok();
    }
    if (text.startsWith('SELECT id, name FROM operations WHERE name = ANY')) {
      return ok((params[0] as string[]).filter((n) => operations.has(n)).map((name) => ({ id: operations.get(name), name })));
    }
    const select = /^SELECT .+ FROM unit_steps us JOIN operations o ON o\.id = us\.operation_id WHERE (.+?) ORDER BY/.exec(text);
    if (select) {
      const name = (id: unknown) => [...operations].find(([, v]) => v === id)?.[0];
      return ok(unitSteps.filter((r) => evaluate(select[1] as string, r, params)).map((r) => ({ ...r, operation: name(r.operation_id) ?? 'Cure' })));
    }
    if (text.startsWith('DELETE FROM hour_cells')) {
      const [from, to] = (params as Date[]).map((d) => d.getTime());
      for (let i = hourCells.length - 1; i >= 0; i--) {
        const h = (hourCells[i]!.hour_start_utc as Date).getTime();
        if (h >= (from as number) && h < (to as number)) hourCells.splice(i, 1);
      }
      return ok();
    }
    if (text.startsWith('DELETE FROM defect_hour_cells') || text.startsWith('SELECT pg_notify')) return ok();
    if (text.startsWith('INSERT INTO operator_assignment_state')) return ok([], 1);
    const insert = /^INSERT INTO hour_cells \(([^)]+)\) VALUES /.exec(text);
    if (insert) {
      const columns = (insert[1] as string).split(',').map((c) => c.trim());
      for (let i = 0; i < params.length; i += columns.length) hourCells.push(Object.fromEntries(columns.map((c, j) => [c, params[i + j]])));
      return ok([], params.length / columns.length);
    }
    throw new Error(`unexpected SQL: ${text}`);
  };

  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, operations, hourCells };
}

const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'UTC' };

function step(id: string, start: string, complete: string): Row {
  return {
    unit_id: `U-${id}`,
    job_number: 'J-1',
    product_number: 'P-1',
    operation_id: 1,
    operator_id: 'ann',
    start_ts: new Date(start),
    complete_ts: new Date(complete),
    result: null,
    rework_flag: null,
  };
}

async function unitsRecomputed(steps: Row[], hour: string, now: string): Promise<number> {
  const db = memoryDb(steps);
  db.operations.set('Cure', 1);
  const recomputer = new Recomputer(db.pool, log, new OperationCache(db.pool));
  await recomputer.recomputeHours([Date.parse(hour)], settings, Date.parse(now));
  return db.hourCells.filter((c) => (c.hour_start_utc as Date).getTime() === Date.parse(hour)).reduce((sum, c) => sum + Number(c.units), 0);
}

describe('hour cells for a step that completes long after it started', () => {
  it('control: a step of a few minutes is counted in the hour it completed', async () => {
    const steps = [step('short', '2026-06-01T07:50:00Z', '2026-06-01T08:10:00Z')];
    expect(await unitsRecomputed(steps, '2026-06-01T08:00:00Z', '2026-06-01T08:30:00Z')).toBe(1);
  });

  it('a 20-hour step is counted in the hour it completed', async () => {
    const steps = [step('overnight', '2026-05-31T12:00:00Z', '2026-06-01T08:10:00Z')];
    expect(await unitsRecomputed(steps, '2026-06-01T08:00:00Z', '2026-06-01T08:30:00Z')).toBe(1);
  });

  it('a step that started on Friday afternoon and was completed on Monday morning is counted in the hour it completed', async () => {
    const steps = [step('weekend', '2026-05-29T16:00:00Z', '2026-06-01T08:10:00Z')];
    expect(await unitsRecomputed(steps, '2026-06-01T08:00:00Z', '2026-06-01T08:30:00Z')).toBe(1);
  });
});
