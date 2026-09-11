import type { CellColor, DefectHourCell, HourCell, PriorCount, UtcMs } from '@fld/shared';
import type { Db } from '../pool.js';
import { toBool, toMsOr, toNum, toNumOr, tsParam } from '../util.js';

type CellRow = {
  hour_start_utc: Date;
  job_number: string;
  product_number: string;
  operation: string;
  operator_id: string;
  units: number;
  work_minutes: number;
  window_minutes: number;
  break_minutes: number;
  charged_minutes: number;
  eligible: boolean;
  provisional: boolean;
  std_hr: number | null;
  target_units: number;
  pace: number | null;
  color: CellColor;
};

const CELL_COLUMNS = `c.hour_start_utc, c.job_number, c.product_number, o.name AS operation, c.operator_id,
    c.units, c.work_minutes, c.window_minutes, c.break_minutes, c.charged_minutes,
    c.eligible, c.provisional, c.std_hr, c.target_units, c.pace, c.color`;

const CELL_FROM = 'FROM hour_cells c JOIN operations o ON o.id = c.operation_id';

export function mapHourCell(row: CellRow): HourCell {
  return {
    hour_start_utc: toMsOr(row.hour_start_utc, 0),
    job_number: row.job_number,
    product_number: row.product_number,
    operation: row.operation,
    operator_id: row.operator_id,
    units: toNumOr(row.units, 0),
    work_minutes: toNumOr(row.work_minutes, 0),
    window_minutes: toNumOr(row.window_minutes, 0),
    break_minutes: toNumOr(row.break_minutes, 0),
    charged_minutes: toNumOr(row.charged_minutes, 0),
    eligible: toBool(row.eligible),
    provisional: toBool(row.provisional),
    std_hr: toNum(row.std_hr),
    target_units: toNumOr(row.target_units, 0),
    pace: toNum(row.pace),
    color: row.color,
  };
}

export async function getCellsForJob(db: Db, job: string, fromUtc?: UtcMs, toUtc?: UtcMs): Promise<HourCell[]> {
  const params: unknown[] = [job];
  let sql = `SELECT ${CELL_COLUMNS} ${CELL_FROM} WHERE c.job_number = $1`;
  if (fromUtc !== undefined) {
    params.push(tsParam(fromUtc));
    sql += ` AND c.hour_start_utc >= $${params.length}`;
  }
  if (toUtc !== undefined) {
    params.push(tsParam(toUtc));
    sql += ` AND c.hour_start_utc < $${params.length}`;
  }
  sql += ' ORDER BY c.hour_start_utc, o.name, c.operator_id';
  const { rows } = await db.query<CellRow>(sql, params as any[]);
  return rows.map(mapHourCell);
}

export async function getCellsInRange(db: Db, fromUtc: UtcMs, toUtc: UtcMs): Promise<HourCell[]> {
  const { rows } = await db.query<CellRow>(
    `SELECT ${CELL_COLUMNS} ${CELL_FROM} WHERE c.hour_start_utc >= $1 AND c.hour_start_utc < $2
     ORDER BY c.hour_start_utc, c.job_number, o.name, c.operator_id`,
    [tsParam(fromUtc), tsParam(toUtc)],
  );
  return rows.map(mapHourCell);
}

export async function getCellsForHour(db: Db, hourStartUtc: UtcMs): Promise<HourCell[]> {
  const { rows } = await db.query<CellRow>(
    `SELECT ${CELL_COLUMNS} ${CELL_FROM} WHERE c.hour_start_utc = $1 ORDER BY c.job_number, o.name, c.operator_id`,
    [tsParam(hourStartUtc)],
  );
  return rows.map(mapHourCell);
}

export async function getCellsForOperator(db: Db, operatorId: string, fromUtc: UtcMs, toUtc: UtcMs): Promise<HourCell[]> {
  const { rows } = await db.query<CellRow>(
    `SELECT ${CELL_COLUMNS} ${CELL_FROM}
     WHERE c.operator_id = $1 AND c.hour_start_utc >= $2 AND c.hour_start_utc < $3
     ORDER BY c.hour_start_utc, c.job_number, o.name`,
    [operatorId, tsParam(fromUtc), tsParam(toUtc)],
  );
  return rows.map(mapHourCell);
}

/** Units per (operation, operator) completed on this job before `beforeUtc`. */
export async function getPriorCountsForJob(db: Db, job: string, beforeUtc: UtcMs): Promise<PriorCount[]> {
  const { rows } = await db.query<{ operation: string; operator_id: string; units: number }>(
    `SELECT o.name AS operation, s.operator_id, count(*)::int AS units
     FROM unit_steps s JOIN operations o ON o.id = s.operation_id
     WHERE s.job_number = $1 AND s.complete_ts IS NOT NULL AND s.complete_ts < $2
     GROUP BY 1, 2`,
    [job, tsParam(beforeUtc)],
  );
  return rows.map((r) => ({ operation: r.operation, operator_id: r.operator_id, units: toNumOr(r.units, 0) }));
}

export async function getDefectCellsForJob(db: Db, job: string, fromUtc: UtcMs): Promise<DefectHourCell[]> {
  const { rows } = await db.query<{ hour_start_utc: Date; job_number: string; operation: string; count: number }>(
    `SELECT d.hour_start_utc, d.job_number, o.name AS operation, d.count
     FROM defect_hour_cells d JOIN operations o ON o.id = d.operation_id
     WHERE d.job_number = $1 AND d.hour_start_utc >= $2
     ORDER BY d.hour_start_utc, o.name`,
    [job, tsParam(fromUtc)],
  );
  return rows.map((r) => ({
    hour_start_utc: toMsOr(r.hour_start_utc, 0),
    job_number: r.job_number,
    operation: r.operation,
    count: toNumOr(r.count, 0),
  }));
}

/** Defects per operation on this job before `beforeUtc`. */
export async function getPriorDefectsForJob(
  db: Db,
  job: string,
  beforeUtc: UtcMs,
): Promise<{ operation: string; count: number }[]> {
  const { rows } = await db.query<{ operation: string; count: number }>(
    `SELECT o.name AS operation, count(*)::int AS count
     FROM defects d JOIN operations o ON o.id = d.operation_id
     WHERE d.job_number = $1 AND d.found_ts < $2
     GROUP BY 1`,
    [job, tsParam(beforeUtc)],
  );
  return rows.map((r) => ({ operation: r.operation, count: toNumOr(r.count, 0) }));
}

/** Distinct jobs with a unit_step starting or completing inside [fromUtc, toUtc). */
export async function getActiveJobNumbers(db: Db, fromUtc: UtcMs, toUtc: UtcMs): Promise<string[]> {
  const { rows } = await db.query<{ job_number: string }>(
    `SELECT DISTINCT job_number FROM unit_steps
     WHERE (start_ts >= $1 AND start_ts < $2) OR (complete_ts >= $1 AND complete_ts < $2)`,
    [tsParam(fromUtc), tsParam(toUtc)],
  );
  return rows.map((r) => r.job_number);
}
