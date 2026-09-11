/** Collector control channel (docs/API.md: Postgres NOTIFY channel `fld_control`). */
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
