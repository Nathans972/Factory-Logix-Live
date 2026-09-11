import type { Pin, PinMode, UtcMs } from '@fld/shared';
import type { Db } from '../pool.js';
import { toMs, toMsOr, tsParam } from '../util.js';

type PinRow = {
  id: number;
  operator_id: string;
  job_number: string;
  operation: string | null;
  mode: PinMode;
  created_by: string | null;
  created_at: Date;
  expires_at: Date | null;
};

function mapPin(row: PinRow): Pin {
  return {
    id: row.id,
    operator_id: row.operator_id,
    job_number: row.job_number,
    operation: row.operation,
    mode: row.mode,
    created_by: row.created_by,
    created_at: toMsOr(row.created_at, 0),
    expires_at: toMs(row.expires_at),
  };
}

const PIN_SQL = `SELECT p.id, p.operator_id, p.job_number, o.name AS operation, p.mode, p.created_by, p.created_at, p.expires_at
   FROM operator_pins p LEFT JOIN operations o ON o.id = p.operation_id`;

export async function listPins(
  db: Db,
  filter: { operator_id?: string | null; job_number?: string | null; activeOnly?: boolean } = {},
): Promise<Pin[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.operator_id) {
    params.push(filter.operator_id);
    clauses.push(`p.operator_id = $${params.length}`);
  }
  if (filter.job_number) {
    params.push(filter.job_number);
    clauses.push(`p.job_number = $${params.length}`);
  }
  if (filter.activeOnly) clauses.push('(p.expires_at IS NULL OR p.expires_at > now())');
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<PinRow>(`${PIN_SQL} ${where} ORDER BY p.created_at DESC, p.id DESC`, params as any[]);
  return rows.map(mapPin);
}

export async function getPin(db: Db, id: number): Promise<Pin | null> {
  const { rows } = await db.query<PinRow>(`${PIN_SQL} WHERE p.id = $1`, [id]);
  return rows.length > 0 ? mapPin(rows[0]) : null;
}

export async function insertPin(
  db: Db,
  input: {
    operator_id: string;
    job_number: string;
    operation_id: number | null;
    mode: PinMode;
    created_by: string | null;
    expires_at: UtcMs | null;
  },
): Promise<Pin> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO operator_pins (operator_id, job_number, operation_id, mode, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.operator_id,
      input.job_number,
      input.operation_id,
      input.mode,
      input.created_by,
      input.expires_at === null || input.expires_at === undefined ? null : tsParam(input.expires_at),
    ],
  );
  const created = await getPin(db, rows[0].id);
  if (!created) throw new Error('pin insert failed');
  return created;
}

export async function deletePin(db: Db, id: number): Promise<boolean> {
  const res = await db.query('DELETE FROM operator_pins WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}
