import type { OperatorAssignment, OperatorListItem } from '@fld/shared';
import type { Db } from '../pool.js';
import { toMs } from '../util.js';

export async function getOperatorNames(db: Db, operatorIds: string[]): Promise<Record<string, string | null>> {
  const ids = [...new Set(operatorIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const { rows } = await db.query<{ operator_id: string; display_name: string | null }>(
    'SELECT operator_id, display_name FROM operators WHERE operator_id = ANY($1::text[])',
    [ids],
  );
  const out: Record<string, string | null> = {};
  for (const id of ids) out[id] = null;
  for (const r of rows) out[r.operator_id] = r.display_name;
  return out;
}

export async function listOperators(db: Db, q: string | null, limit = 500): Promise<OperatorListItem[]> {
  const like = q ? `%${q}%` : null;
  const { rows } = await db.query<{ operator_id: string; display_name: string | null; last_seen_at: Date | null }>(
    `SELECT operator_id, display_name, last_seen_at FROM operators
     WHERE ($1::text IS NULL OR operator_id ILIKE $1 OR display_name ILIKE $1)
     ORDER BY last_seen_at DESC NULLS LAST, operator_id
     LIMIT $2`,
    [like, limit],
  );
  return rows.map((r) => ({
    operator_id: r.operator_id,
    display_name: r.display_name,
    last_seen_at: toMs(r.last_seen_at),
  }));
}

export async function getOperator(db: Db, operatorId: string): Promise<OperatorListItem | null> {
  const { rows } = await db.query<{ operator_id: string; display_name: string | null; last_seen_at: Date | null }>(
    'SELECT operator_id, display_name, last_seen_at FROM operators WHERE operator_id = $1',
    [operatorId],
  );
  if (rows.length === 0) return null;
  return { operator_id: rows[0].operator_id, display_name: rows[0].display_name, last_seen_at: toMs(rows[0].last_seen_at) };
}

type AssignmentRow = {
  operator_id: string;
  job_number: string | null;
  operation: string | null;
  assigned_since: Date | null;
  last_scan_at: Date | null;
};

function mapAssignment(row: AssignmentRow): OperatorAssignment {
  return {
    operator_id: row.operator_id,
    job_number: row.job_number,
    operation: row.operation,
    assigned_since: toMs(row.assigned_since),
    last_scan_at: toMs(row.last_scan_at),
  };
}

const ASSIGNMENT_SQL = `SELECT a.operator_id, a.job_number, o.name AS operation, a.assigned_since, a.last_scan_at
   FROM operator_assignment_state a LEFT JOIN operations o ON o.id = a.operation_id`;

export async function listAssignments(db: Db): Promise<OperatorAssignment[]> {
  const { rows } = await db.query<AssignmentRow>(`${ASSIGNMENT_SQL} ORDER BY a.operator_id`);
  return rows.map(mapAssignment);
}

export async function getAssignment(db: Db, operatorId: string): Promise<OperatorAssignment | null> {
  const { rows } = await db.query<AssignmentRow>(`${ASSIGNMENT_SQL} WHERE a.operator_id = $1`, [operatorId]);
  return rows.length > 0 ? mapAssignment(rows[0]) : null;
}
