/** Collector control channel (docs/API.md: Postgres NOTIFY channel `fld_control`). */
import { addDays, localDateString, localToUtc } from '@fld/engine';
import type { UtcMs } from '@fld/shared';
import type { Db } from './db/pool.js';

export type ControlCommand =
  | { cmd: 'restart' }
  | { cmd: 'backfill_now' }
  | { cmd: 'recompute_standards'; product_number?: string }
  | { cmd: 'recompute_cells'; from_utc: UtcMs; to_utc: UtcMs };

export const CONTROL_CHANNEL = 'fld_control';

export async function sendControl(db: Db, command: ControlCommand): Promise<void> {
  await db.query('SELECT pg_notify($1, $2)', [CONTROL_CHANNEL, JSON.stringify(command)]);
}

/**
 * After a change the stored hour cells depend on (`HOUR_CELL_SETTINGS_KEYS`, a shift, a break):
 * recompute the cells of today and yesterday, plant time. By itself the collector only recomputes
 * the current and previous hour and the hours new rows touch, so the TVs (the last 12 hours) and
 * the shifts of those days would mix the old rule with the new one. Earlier days keep the one
 * they were computed with. Send it after `restart`, so the collector uses what was just saved.
 */
export async function requestCellRecompute(db: Db, tz: string, now: UtcMs = Date.now()): Promise<void> {
  const [year, month, day] = addDays(localDateString(now, tz), -1).split('-').map(Number);
  const from = localToUtc(tz, { year, month, day, hour: 0 });
  await sendControl(db, { cmd: 'recompute_cells', from_utc: from, to_utc: now });
}
