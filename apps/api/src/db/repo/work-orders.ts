import type { UtcMs, WorkOrder } from '@fld/shared';
import type { Db } from '../pool.js';
import { toMs, toNum, toNumOr } from '../util.js';

type WorkOrderRow = {
  job_number: string;
  product_number: string;
  product_name: string | null;
  qty_released: number;
  qty_complete: number | null;
  status: string | null;
  fl_created_at: Date | null;
  fl_modified_at: Date | null;
};

const WO_COLUMNS =
  'w.job_number, w.product_number, w.product_name, w.qty_released, w.qty_complete, w.status, w.fl_created_at, w.fl_modified_at';

export function mapWorkOrder(row: WorkOrderRow): WorkOrder {
  return {
    job_number: row.job_number,
    product_number: row.product_number,
    product_name: row.product_name,
    qty_released: toNumOr(row.qty_released, 0),
    qty_complete: toNum(row.qty_complete),
    status: row.status,
    fl_created_at: toMs(row.fl_created_at),
    fl_modified_at: toMs(row.fl_modified_at),
  };
}

export async function getWorkOrder(db: Db, job: string): Promise<WorkOrder | null> {
  const { rows } = await db.query<WorkOrderRow>(`SELECT ${WO_COLUMNS} FROM work_orders w WHERE w.job_number = $1`, [job]);
  return rows.length > 0 ? mapWorkOrder(rows[0]) : null;
}

/**
 * Stand-in for a job that has activity but no work_orders row. unit_steps and hour_cells have no
 * foreign key to work_orders, so a job is on the floor, shift and operator pages before its work
 * order is ingested (or when the work order is older than the backfill window). The stand-in takes
 * the product of the job's latest activity and has no quantities or status. Null without activity.
 */
export async function getWorkOrderFromActivity(db: Db, job: string): Promise<WorkOrder | null> {
  const { rows } = await db.query<{ product_number: string; product_name: string | null }>(
    `SELECT a.product_number, p.name AS product_name
     FROM (
       SELECT c.product_number, c.hour_start_utc AS seen_at FROM hour_cells c WHERE c.job_number = $1
       UNION ALL
       SELECT s.product_number, s.start_ts AS seen_at FROM unit_steps s WHERE s.job_number = $1
     ) a
     LEFT JOIN products p ON p.product_number = a.product_number
     ORDER BY a.seen_at DESC
     LIMIT 1`,
    [job],
  );
  if (rows.length === 0) return null;
  return {
    job_number: job,
    product_number: rows[0].product_number,
    product_name: rows[0].product_name ?? null,
    qty_released: 0,
    qty_complete: null,
    status: null,
    fl_created_at: null,
    fl_modified_at: null,
  };
}

export async function getWorkOrders(db: Db, jobs: string[]): Promise<WorkOrder[]> {
  if (jobs.length === 0) return [];
  const { rows } = await db.query<WorkOrderRow>(
    `SELECT ${WO_COLUMNS} FROM work_orders w WHERE w.job_number = ANY($1::text[]) ORDER BY w.job_number`,
    [jobs],
  );
  return rows.map(mapWorkOrder);
}

export interface JobRowWithActivity {
  work_order: WorkOrder;
  last_activity_at: UtcMs | null;
}

const CLOSED_STATUSES = ['Closed', 'Complete', 'Completed', 'Cancelled'];

/**
 * Work orders with their last unit_step activity. A single aggregate over unit_steps is joined to
 * work_orders so ordering by activity does not need one query per job.
 */
export async function listJobsWithActivity(
  db: Db,
  opts: { q?: string | null; active?: boolean | null; limit?: number },
): Promise<JobRowWithActivity[]> {
  const like = opts.q ? `%${opts.q}%` : null;
  const limit = opts.limit ?? 200;
  const { rows } = await db.query<WorkOrderRow & { last_activity_at: Date | null }>(
    `WITH activity AS (
       SELECT s.job_number, GREATEST(max(s.start_ts), max(s.complete_ts)) AS last_activity_at
       FROM unit_steps s
       GROUP BY s.job_number
     )
     SELECT ${WO_COLUMNS}, a.last_activity_at
     FROM work_orders w
     LEFT JOIN activity a ON a.job_number = w.job_number
     WHERE ($1::text IS NULL OR w.job_number ILIKE $1 OR w.product_number ILIKE $1 OR w.product_name ILIKE $1)
       AND (
         $2::boolean IS NOT TRUE
         OR a.last_activity_at >= now() - interval '7 days'
         OR (COALESCE(w.status, '') <> ALL($3::text[]) AND a.last_activity_at >= now() - interval '30 days')
       )
     ORDER BY a.last_activity_at DESC NULLS LAST, w.job_number DESC
     LIMIT $4`,
    [like, opts.active ?? null, CLOSED_STATUSES, limit],
  );
  return rows.map((r) => ({ work_order: mapWorkOrder(r), last_activity_at: toMs(r.last_activity_at) }));
}

export function isJobActive(status: string | null, lastActivityAt: UtcMs | null, now: number): boolean {
  if (lastActivityAt === null) return false;
  const day = 86_400_000;
  if (lastActivityAt >= now - 7 * day) return true;
  const closed = CLOSED_STATUSES.includes(status ?? '');
  return !closed && lastActivityAt >= now - 30 * day;
}
