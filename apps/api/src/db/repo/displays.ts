import type { Display } from '@fld/shared';
import { isUniqueViolation, type Db } from '../pool.js';
import { toBool, toMs, toMsOr, toNumOr } from '../util.js';

export type DisplayRow = {
  id: number;
  pairing_code: string;
  device_token: string;
  name: string | null;
  claimed_at: Date | null;
  job_number: string | null;
  group_operators: boolean;
  show_std_day: boolean;
  show_gauge: boolean;
  shift_length_hours: number;
  last_seen_at: Date | null;
  created_at: Date;
};

const COLUMNS =
  'id, pairing_code, device_token::text AS device_token, name, claimed_at, job_number, group_operators, show_std_day, show_gauge, shift_length_hours, last_seen_at, created_at';

/** `online` = seen within 3 poll intervals. */
export function mapDisplay(row: DisplayRow, pollIntervalSeconds: number, now = Date.now()): Display {
  const lastSeen = toMs(row.last_seen_at);
  const onlineWindowMs = Math.max(30, pollIntervalSeconds) * 3 * 1000;
  return {
    id: row.id,
    pairing_code: row.pairing_code,
    name: row.name,
    claimed_at: toMs(row.claimed_at),
    job_number: row.job_number,
    group_operators: toBool(row.group_operators),
    show_std_day: toBool(row.show_std_day, true),
    show_gauge: toBool(row.show_gauge, true),
    shift_length_hours: toNumOr(row.shift_length_hours, 12),
    last_seen_at: lastSeen,
    created_at: toMsOr(row.created_at, 0),
    online: lastSeen !== null && now - lastSeen <= onlineWindowMs,
  };
}

export async function listDisplayRows(db: Db): Promise<DisplayRow[]> {
  const { rows } = await db.query<DisplayRow>(
    `SELECT ${COLUMNS} FROM displays ORDER BY claimed_at IS NULL, name NULLS LAST, id`,
  );
  return rows;
}

export async function getDisplayRowById(db: Db, id: number): Promise<DisplayRow | null> {
  const { rows } = await db.query<DisplayRow>(`SELECT ${COLUMNS} FROM displays WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getDisplayRowByToken(db: Db, token: string): Promise<DisplayRow | null> {
  const { rows } = await db.query<DisplayRow>(`SELECT ${COLUMNS} FROM displays WHERE device_token = $1::uuid`, [token]);
  return rows[0] ?? null;
}

export async function getDisplayRowByCode(db: Db, code: string): Promise<DisplayRow | null> {
  const { rows } = await db.query<DisplayRow>(`SELECT ${COLUMNS} FROM displays WHERE pairing_code = $1`, [code]);
  return rows[0] ?? null;
}

export async function listDisplayRowsForJob(db: Db, job: string): Promise<DisplayRow[]> {
  const { rows } = await db.query<DisplayRow>(`SELECT ${COLUMNS} FROM displays WHERE job_number = $1 ORDER BY name NULLS LAST, id`, [
    job,
  ]);
  return rows;
}

function randomPairingCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Insert a display for a new device token with a fresh unique 4-digit pairing code. */
export async function insertDisplay(db: Db, deviceToken: string): Promise<DisplayRow> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const code = randomPairingCode();
    try {
      const { rows } = await db.query<DisplayRow>(
        `INSERT INTO displays (pairing_code, device_token, last_seen_at) VALUES ($1, $2::uuid, now())
         RETURNING ${COLUMNS}`,
        [code, deviceToken],
      );
      return rows[0];
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // device_token collision means the row already exists: return it.
      const existing = await getDisplayRowByToken(db, deviceToken);
      if (existing) return existing;
      // otherwise it was a pairing_code collision: retry with a new code.
    }
  }
  throw new Error('could not allocate a unique pairing code');
}

export async function touchDisplay(db: Db, id: number): Promise<void> {
  await db.query('UPDATE displays SET last_seen_at = now() WHERE id = $1', [id]);
}

export interface DisplayPatch {
  name?: string | null;
  job_number?: string | null;
  group_operators?: boolean;
  show_std_day?: boolean;
  show_gauge?: boolean;
  shift_length_hours?: number;
  claim?: boolean;
}

export async function updateDisplayRow(db: Db, id: number, patch: DisplayPatch): Promise<DisplayRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, value: unknown): void => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.job_number !== undefined) set('job_number', patch.job_number);
  if (patch.group_operators !== undefined) set('group_operators', patch.group_operators);
  if (patch.show_std_day !== undefined) set('show_std_day', patch.show_std_day);
  if (patch.show_gauge !== undefined) set('show_gauge', patch.show_gauge);
  if (patch.shift_length_hours !== undefined) set('shift_length_hours', patch.shift_length_hours);
  if (patch.claim) sets.push('claimed_at = COALESCE(claimed_at, now())');
  if (sets.length === 0) return getDisplayRowById(db, id);
  params.push(id);
  const { rows } = await db.query<DisplayRow>(
    `UPDATE displays SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params as any[],
  );
  return rows[0] ?? null;
}

export async function deleteDisplay(db: Db, id: number): Promise<boolean> {
  const res = await db.query('DELETE FROM displays WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Move `sourceId`'s device_token onto `targetId` and delete the temporary row. */
export async function repairDisplayToken(db: Db, targetId: number, sourceId: number): Promise<DisplayRow | null> {
  const source = await getDisplayRowById(db, sourceId);
  if (!source) return null;
  await db.query('DELETE FROM displays WHERE id = $1', [sourceId]);
  const { rows } = await db.query<DisplayRow>(
    `UPDATE displays SET device_token = $1::uuid, last_seen_at = now() WHERE id = $2 RETURNING ${COLUMNS}`,
    [source.device_token, targetId],
  );
  return rows[0] ?? null;
}
