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

/**
 * The tables the recompute reads and writes, in memory. `clock` is "now" for the database:
 * steps that have not started yet are not there, and steps still running have no complete_ts.
 * Standard for Z1/Weld: computed 30/h. `overrides` is what a manager writes from the product page.
 */
function fakePool() {
  const state = { clock: 0, overrides: [] as Record<string, unknown>[] };
  const cells = new Map<string, Record<string, unknown>>();
  // OP1 runs J1/Weld all morning, a board every 2 minutes: 30 an hour, exactly the standard.
  const steps: { start: number; complete: number }[] = [];
  for (let s = t('07:00'); s < t('11:00'); s += 2 * MIN) steps.push({ start: s, complete: s + 2 * MIN });

  const run = async (sql: string, params: unknown[] = []) => {
    const ok = (rows: unknown[], rowCount = rows.length) => ({ rows, rowCount });
    if (/FROM standards s JOIN operations o/.test(sql)) {
      return ok([
        {
          product_number: 'Z1', operation: 'Weld', computed_std_hr: 30, median_minutes_per_unit: 2,
          sample_units: 500, sample_operators: 4, sample_from: null, sample_to: null,
          computed_at: new Date(t('02:00')), fallback_source: 'computed', fl_std_hr: null,
        },
      ]);
    }
    if (/FROM standard_overrides v/.test(sql)) return ok(state.overrides);
    if (/FROM unit_steps us/.test(sql)) {
      const [hardStart, to, windowStart] = (params as Date[]).map((d) => d.getTime());
      return ok(
        steps
          .filter((s) => s.start <= state.clock && s.start >= hardStart! && s.start < to!)
          .map((s) => ({ ...s, complete: s.complete <= state.clock ? s.complete : null }))
          .filter((s) => s.complete === null || s.complete >= windowStart!)
          .map((s, i) => ({
            unit_id: `U${i}`, job_number: 'J1', product_number: 'Z1', operation: 'Weld', operator_id: 'OP1',
            start_ts: new Date(s.start), complete_ts: s.complete === null ? null : new Date(s.complete),
            result: 'pass', rework_flag: null,
          })),
      );
    }
    if (/SELECT id, name FROM operations WHERE name = ANY/.test(sql)) return ok([{ id: 1, name: 'Weld' }]);
    if (/DELETE FROM hour_cells/.test(sql)) {
      const [from, to] = (params as Date[]).map((d) => d.getTime());
      for (const [k, c] of cells) if ((c.hour as number) >= from! && (c.hour as number) < to!) cells.delete(k);
      return ok([]);
    }
    if (/INSERT INTO hour_cells/.test(sql)) {
      for (let i = 0; i < params.length; i += 17) {
        const r = params.slice(i, i + 17);
        const hour = (r[0] as Date).getTime();
        cells.set(`${hour}|${r[1]}|${r[3]}|${r[4]}`, { hour, units: r[5], charged: r[9], eligible: r[10], std_hr: r[12], pace: r[14], color: r[15] });
      }
      return ok([], params.length / 17);
    }
    return ok([]); // shifts, breaks, adjustments, pins, defects, operations insert, notify, BEGIN/COMMIT
  };

  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => undefined }),
  } as unknown as Pool;
  const cellAt = (local: string) => [...cells.values()].find((c) => c.hour === t(local));
  return { pool, state, cellAt };
}

describe('a standards change made during an hour', () => {
  it('judges two identical, already-ended hours against the same StdHr', async () => {
    const db = fakePool();
    const recomputer = new Recomputer(db.pool, log, new OperationCache(db.pool));
    // After every poll the collector recomputes the previous and the current hour.
    const pollAt = async (local: string) => {
      db.state.clock = t(local);
      await recomputer.recomputeCurrentHours(settings, t(local));
    };

    await pollAt('09:01'); // 08:00 ends and is recomputed
    await pollAt('10:01'); // 09:00 ends and is recomputed
    expect(db.cellAt('08:00')).toMatchObject({ units: 30, std_hr: 30, color: 'green' });
    expect(db.cellAt('09:00')).toMatchObject({ units: 30, std_hr: 30, color: 'green' });

    // 10:05: a manager sets a Weld override of 40 on the product page.
    db.state.overrides.push({
      id: 1, scope: 'product_operation', product_number: 'Z1', operation: 'Weld', std_hr: 40,
      created_by: 'mgr', created_at: new Date(t('10:05')), note: 'new fixture', active: true,
    });
    await pollAt('10:06');

    // Both hours had the same work and both ended before the change.
    const h08 = db.cellAt('08:00')!;
    const h09 = db.cellAt('09:00')!;
    expect(h09.std_hr).toBe(h08.std_hr);
    expect(h09.color).toBe(h08.color);
  });
});
