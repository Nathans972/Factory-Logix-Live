/**
 * Once an hour has ended, computing it again keeps the StdHr it was judged against while it ran
 * (spec 7.7, docs/CALCULATIONS.md): not only the previous hour after every poll
 * (standards-change-ended-hour.test.ts), but also when the change comes between the end of the
 * hour and the next poll, after the collector restarted (read back from the stored cells), and
 * when late rows touch an older hour. The backfill's recoloring judges the history against today's
 * standards.
 *
 * This drives the real Recomputer against an in-memory pool. OP1 runs J1/Weld (product Z1) all
 * morning, a board every 2 minutes: 30 an hour, against a computed StdHr of 30 (or none).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@fld/shared';
import type { Pool } from '../src/db.js';
import type { Logger } from '../src/logger.js';
import { Recomputer } from '../src/engine/recompute.js';
import { OperationCache } from '../src/ingest/operations.js';

const MIN = 60_000;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as Logger;
const settings: Settings = { ...DEFAULT_SETTINGS, plant_timezone: 'America/New_York' };
const t = (local: string) => Date.parse(`2025-06-10T${local}-04:00`);

type Cell = { hour: number; operator: string; units: number; provisional: boolean; std_hr: number | null; color: string };

/** The tables the recompute reads and writes. `clock` is "now" for the database, as in standards-change-ended-hour.test.ts. */
function memoryDb(computedStdHr: number | null) {
  const state = { clock: 0, overrides: [] as Record<string, unknown>[] };
  const steps: { operator: string; start: number; complete: number }[] = [];
  for (let s = t('07:00'); s < t('11:00'); s += 2 * MIN) steps.push({ operator: 'OP1', start: s, complete: s + 2 * MIN });
  const cells: Cell[] = [];
  const ok = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });

  const run = async (sql: string, params: unknown[] = []) => {
    if (/FROM standards s JOIN operations o/.test(sql)) {
      if (computedStdHr === null) return ok([]);
      return ok([
        {
          product_number: 'Z1', operation: 'Weld', computed_std_hr: computedStdHr, median_minutes_per_unit: 2,
          sample_units: 500, sample_operators: 4, sample_from: null, sample_to: null,
          computed_at: new Date(t('02:00')), fallback_source: 'computed', fl_std_hr: null,
        },
      ]);
    }
    if (/FROM standard_overrides v/.test(sql)) return ok(state.overrides);
    if (/FROM unit_steps us/.test(sql)) {
      if (/us\.start_ts < \$1/.test(sql)) return ok([]); // no step here runs for more than a day
      const [hardStart, to, windowStart] = (params as Date[]).map((d) => d.getTime());
      return ok(
        steps
          .filter((s) => s.start <= state.clock && s.start >= hardStart! && s.start < to!)
          .map((s) => ({ ...s, complete: s.complete <= state.clock ? s.complete : null }))
          .filter((s) => s.complete === null || s.complete >= windowStart!)
          .map((s, i) => ({
            unit_id: `U${i}`, job_number: 'J1', product_number: 'Z1', operation: 'Weld', operator_id: s.operator,
            start_ts: new Date(s.start), complete_ts: s.complete === null ? null : new Date(s.complete),
            result: 'pass', rework_flag: null,
          })),
      );
    }
    if (/SELECT id, name FROM operations WHERE name = ANY/.test(sql)) return ok([{ id: 1, name: 'Weld' }]);
    if (/FROM hour_cells c JOIN operations o/.test(sql)) {
      const [from, to] = (params as Date[]).map((d) => d.getTime());
      return ok(
        cells
          .filter((c) => c.hour >= from! && c.hour < to!)
          // numeric comes back from pg as a string
          .map((c) => ({ hour_start_utc: new Date(c.hour), product_number: 'Z1', operation: 'Weld', std_hr: c.std_hr === null ? null : String(c.std_hr) })),
      );
    }
    if (/DELETE FROM hour_cells/.test(sql)) {
      const [from, to] = (params as Date[]).map((d) => d.getTime());
      for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.hour >= from! && cells[i]!.hour < to!) cells.splice(i, 1);
      return ok([]);
    }
    if (/INSERT INTO hour_cells/.test(sql)) {
      for (let i = 0; i < params.length; i += 17) {
        const r = params.slice(i, i + 17);
        cells.push({
          hour: (r[0] as Date).getTime(), operator: r[4] as string, units: r[5] as number,
          provisional: r[11] as boolean, std_hr: r[12] as number | null, color: r[15] as string,
        });
      }
      return ok([], params.length / 17);
    }
    return ok([]); // shifts, breaks, adjustments, pins, defects, operations insert, notify, BEGIN/COMMIT
  };

  const pool = { query: run, connect: async () => ({ query: run, release: () => undefined }) } as unknown as Pool;
  const cellsAt = (local: string) => cells.filter((c) => c.hour === t(local));
  return { pool, state, steps, cellsAt };
}

type Db = ReturnType<typeof memoryDb>;

/** A manager sets a Weld override on the product page. */
function setOverride(db: Db, stdHr: number, local: string): void {
  db.state.overrides.push({
    id: 1, scope: 'product_operation', product_number: 'Z1', operation: 'Weld', std_hr: stdHr,
    created_by: 'mgr', created_at: new Date(t(local)), note: null, active: true,
  });
}

/** What the collector recomputes after every poll: the previous and the current hour. */
async function pollAt(db: Db, recomputer: Recomputer, local: string): Promise<void> {
  db.state.clock = t(local);
  await recomputer.recomputeCurrentHours(settings, t(local));
}

const newRecomputer = (db: Db) => new Recomputer(db.pool, log, new OperationCache(db.pool));

describe('an hour that has ended', () => {
  it('keeps the StdHr it ran with when the standard changes before the poll after its end', async () => {
    const db = memoryDb(30);
    const recomputer = newRecomputer(db);
    await pollAt(db, recomputer, '09:59');
    setOverride(db, 40, '10:00:30');
    await pollAt(db, recomputer, '10:01');

    expect(db.cellsAt('09:00')).toEqual([expect.objectContaining({ units: 30, provisional: false, std_hr: 30, color: 'green' })]);
    expect(db.cellsAt('10:00')).toEqual([expect.objectContaining({ provisional: true, std_hr: 40 })]);
  });

  it('keeps its StdHr after the collector restarts: it is read back from its cells', async () => {
    const db = memoryDb(30);
    const before = newRecomputer(db);
    await pollAt(db, before, '09:01');
    await pollAt(db, before, '10:01');
    setOverride(db, 40, '10:05');

    const after = newRecomputer(db);
    await pollAt(db, after, '10:06');
    expect(db.cellsAt('09:00')).toEqual([expect.objectContaining({ units: 30, std_hr: 30, color: 'green' })]);
    expect(db.cellsAt('10:00')).toEqual([expect.objectContaining({ std_hr: 40 })]);
  });

  it('keeps its StdHr when late rows touch it, for the cells they add as well', async () => {
    const db = memoryDb(30);
    const recomputer = newRecomputer(db);
    await pollAt(db, recomputer, '09:01');
    await pollAt(db, recomputer, '10:01');
    setOverride(db, 40, '10:05');

    // 10:06: the rows of OP2, who also ran J1/Weld from 08:00 to 08:40, come in late.
    for (let s = t('08:00'); s < t('08:40'); s += 2 * MIN) db.steps.push({ operator: 'OP2', start: s, complete: s + 2 * MIN });
    db.state.clock = t('10:06');
    await recomputer.recomputeHours([t('08:00')], settings, t('10:06'));

    expect(db.cellsAt('08:00').map((c) => [c.operator, c.std_hr])).toEqual([
      ['OP1', 30],
      ['OP2', 30],
    ]);
    expect(db.cellsAt('08:00')[0]).toMatchObject({ units: 30, color: 'green' });
  });

  it('with no standard stays unjudged when one is set, like the hours before it', async () => {
    const db = memoryDb(null);
    const recomputer = newRecomputer(db);
    await pollAt(db, recomputer, '09:01');
    await pollAt(db, recomputer, '10:01');
    setOverride(db, 40, '10:05');
    await pollAt(db, recomputer, '10:06');

    expect(db.cellsAt('08:00')).toEqual([expect.objectContaining({ std_hr: null, color: 'neutral' })]);
    expect(db.cellsAt('09:00')).toEqual([expect.objectContaining({ std_hr: null, color: 'neutral' })]);
    expect(db.cellsAt('10:00')).toEqual([expect.objectContaining({ std_hr: 40 })]);
  });

  it('is judged against the standards of now by the backfill recoloring', async () => {
    const db = memoryDb(30);
    const recomputer = newRecomputer(db);
    await pollAt(db, recomputer, '09:01');
    await pollAt(db, recomputer, '10:01');
    setOverride(db, 40, '10:05');

    db.state.clock = t('10:06');
    await recomputer.recomputeHours([t('08:00'), t('09:00')], settings, t('10:06'), { currentStandards: true });
    // 30 units against a target of 40: pace 0.75.
    expect(db.cellsAt('08:00')).toEqual([expect.objectContaining({ units: 30, std_hr: 40, color: 'yellow' })]);
    expect(db.cellsAt('09:00')).toEqual([expect.objectContaining({ units: 30, std_hr: 40, color: 'yellow' })]);

    // They keep it from then on, also when the override is cleared again.
    db.state.overrides.length = 0;
    db.state.clock = t('10:11');
    await recomputer.recomputeHours([t('08:00')], settings, t('10:11'));
    expect(db.cellsAt('08:00')).toEqual([expect.objectContaining({ std_hr: 40 })]);
  });
});
