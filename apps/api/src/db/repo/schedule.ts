/** Shift and break definitions (local times are always selected as 'HH:MM' / 'YYYY-MM-DD' strings). */
import type { BreakDef, BreakWrite, ShiftDef, ShiftWrite } from '@fld/shared';
import type { Db } from '../pool.js';
import { toNumOr } from '../util.js';

type ShiftRow = {
  id: number;
  name: string;
  start_local: string;
  end_local: string;
  days_of_week: number[];
  effective_from: string;
  effective_to: string | null;
};

const SHIFT_COLUMNS = `id, name, to_char(start_local, 'HH24:MI') AS start_local, to_char(end_local, 'HH24:MI') AS end_local,
   days_of_week, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
   to_char(effective_to, 'YYYY-MM-DD') AS effective_to`;

function mapShift(row: ShiftRow): ShiftDef {
  return {
    id: row.id,
    name: row.name,
    start_local: row.start_local,
    end_local: row.end_local,
    days_of_week: (row.days_of_week ?? []).map((d) => Number(d)),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  };
}

export async function listShifts(db: Db): Promise<ShiftDef[]> {
  const { rows } = await db.query<ShiftRow>(
    `SELECT ${SHIFT_COLUMNS} FROM shifts ORDER BY effective_from, start_local, id`,
  );
  return rows.map(mapShift);
}

export async function getShift(db: Db, id: number): Promise<ShiftDef | null> {
  const { rows } = await db.query<ShiftRow>(`SELECT ${SHIFT_COLUMNS} FROM shifts WHERE id = $1`, [id]);
  return rows.length > 0 ? mapShift(rows[0]) : null;
}

export async function insertShift(db: Db, input: ShiftWrite, createdBy: string | null): Promise<ShiftDef> {
  const { rows } = await db.query<ShiftRow>(
    `INSERT INTO shifts (name, start_local, end_local, days_of_week, effective_from, effective_to, created_by)
     VALUES ($1, $2::time, $3::time, $4::int[], $5::date, $6::date, $7)
     RETURNING ${SHIFT_COLUMNS}`,
    [input.name, input.start_local, input.end_local, input.days_of_week, input.effective_from, input.effective_to, createdBy],
  );
  return mapShift(rows[0]);
}

export async function updateShift(db: Db, id: number, input: ShiftWrite): Promise<ShiftDef | null> {
  const { rows } = await db.query<ShiftRow>(
    `UPDATE shifts SET name = $1, start_local = $2::time, end_local = $3::time, days_of_week = $4::int[],
            effective_from = $5::date, effective_to = $6::date
     WHERE id = $7 RETURNING ${SHIFT_COLUMNS}`,
    [input.name, input.start_local, input.end_local, input.days_of_week, input.effective_from, input.effective_to, id],
  );
  return rows.length > 0 ? mapShift(rows[0]) : null;
}

export async function closeShiftVersion(db: Db, id: number, effectiveTo: string): Promise<void> {
  await db.query('UPDATE shifts SET effective_to = $1::date WHERE id = $2', [effectiveTo, id]);
}

export async function deleteShift(db: Db, id: number): Promise<boolean> {
  const res = await db.query('DELETE FROM shifts WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

type BreakRow = {
  id: number;
  name: string;
  start_local: string;
  duration_minutes: number;
  days_of_week: number[];
  shift_ids: number[] | null;
  effective_from: string;
  effective_to: string | null;
};

const BREAK_COLUMNS = `id, name, to_char(start_local, 'HH24:MI') AS start_local, duration_minutes,
   days_of_week, shift_ids, to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
   to_char(effective_to, 'YYYY-MM-DD') AS effective_to`;

function mapBreak(row: BreakRow): BreakDef {
  return {
    id: row.id,
    name: row.name,
    start_local: row.start_local,
    duration_minutes: toNumOr(row.duration_minutes, 0),
    days_of_week: (row.days_of_week ?? []).map((d) => Number(d)),
    shift_ids: row.shift_ids === null || row.shift_ids === undefined ? null : row.shift_ids.map((n) => Number(n)),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  };
}

export async function listBreaks(db: Db): Promise<BreakDef[]> {
  const { rows } = await db.query<BreakRow>(`SELECT ${BREAK_COLUMNS} FROM breaks ORDER BY effective_from, start_local, id`);
  return rows.map(mapBreak);
}

export async function getBreak(db: Db, id: number): Promise<BreakDef | null> {
  const { rows } = await db.query<BreakRow>(`SELECT ${BREAK_COLUMNS} FROM breaks WHERE id = $1`, [id]);
  return rows.length > 0 ? mapBreak(rows[0]) : null;
}

export async function insertBreak(db: Db, input: BreakWrite, createdBy: string | null): Promise<BreakDef> {
  const { rows } = await db.query<BreakRow>(
    `INSERT INTO breaks (name, start_local, duration_minutes, days_of_week, shift_ids, effective_from, effective_to, created_by)
     VALUES ($1, $2::time, $3, $4::int[], $5::int[], $6::date, $7::date, $8)
     RETURNING ${BREAK_COLUMNS}`,
    [
      input.name,
      input.start_local,
      input.duration_minutes,
      input.days_of_week,
      input.shift_ids,
      input.effective_from,
      input.effective_to,
      createdBy,
    ],
  );
  return mapBreak(rows[0]);
}

export async function updateBreak(db: Db, id: number, input: BreakWrite): Promise<BreakDef | null> {
  const { rows } = await db.query<BreakRow>(
    `UPDATE breaks SET name = $1, start_local = $2::time, duration_minutes = $3, days_of_week = $4::int[],
            shift_ids = $5::int[], effective_from = $6::date, effective_to = $7::date
     WHERE id = $8 RETURNING ${BREAK_COLUMNS}`,
    [
      input.name,
      input.start_local,
      input.duration_minutes,
      input.days_of_week,
      input.shift_ids,
      input.effective_from,
      input.effective_to,
      id,
    ],
  );
  return rows.length > 0 ? mapBreak(rows[0]) : null;
}

/**
 * Breaks scoped to shift `shiftId` also apply to `versionId`, the version a versioned edit inserted for
 * it. Without this they stay on a row that stops applying at its effective_to. Returns the changed breaks.
 */
export async function addShiftVersionToBreaks(db: Db, shiftId: number, versionId: number): Promise<BreakDef[]> {
  const { rows } = await db.query<BreakRow>(
    `UPDATE breaks SET shift_ids = array_append(shift_ids, $2::int)
     WHERE $1::int = ANY(shift_ids) AND NOT ($2::int = ANY(shift_ids))
     RETURNING ${BREAK_COLUMNS}`,
    [shiftId, versionId],
  );
  return rows.map(mapBreak);
}

export async function deleteBreak(db: Db, id: number): Promise<boolean> {
  const res = await db.query('DELETE FROM breaks WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}
