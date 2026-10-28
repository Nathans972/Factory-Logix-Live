import type {
  AdjustmentScope,
  FallbackSource,
  OverrideScope,
  Standard,
  StandardAdjustment,
  StandardOverride,
} from '@fld/shared';
import type { Db } from '../pool.js';
import { toMs, toMsOr, toNum, toNumOr } from '../util.js';

type StandardRow = {
  product_number: string;
  operation: string;
  computed_std_hr: number | null;
  median_minutes_per_unit: number | null;
  sample_units: number;
  sample_operators: number;
  sample_from: Date | null;
  sample_to: Date | null;
  computed_at: Date | null;
  fallback_source: FallbackSource;
  fl_std_hr: number | null;
};

function mapStandard(row: StandardRow): Standard {
  return {
    product_number: row.product_number,
    operation: row.operation,
    computed_std_hr: toNum(row.computed_std_hr),
    median_minutes_per_unit: toNum(row.median_minutes_per_unit),
    sample_units: toNumOr(row.sample_units, 0),
    sample_operators: toNumOr(row.sample_operators, 0),
    sample_from: toMs(row.sample_from),
    sample_to: toMs(row.sample_to),
    computed_at: toMsOr(row.computed_at, 0),
    fallback_source: row.fallback_source ?? 'none',
    fl_std_hr: toNum(row.fl_std_hr),
  };
}

export async function getStandardsForProduct(db: Db, productNumber: string): Promise<Standard[]> {
  const { rows } = await db.query<StandardRow>(
    `SELECT s.product_number, o.name AS operation, s.computed_std_hr, s.median_minutes_per_unit,
            s.sample_units, s.sample_operators, s.sample_from, s.sample_to, s.computed_at,
            s.fallback_source, s.fl_std_hr
     FROM standards s JOIN operations o ON o.id = s.operation_id
     WHERE s.product_number = $1
     ORDER BY o.name`,
    [productNumber],
  );
  return rows.map(mapStandard);
}

type AdjustmentRow = {
  id: number;
  scope: AdjustmentScope;
  product_number: string | null;
  operation: string | null;
  percent: number;
  created_by: string | null;
  created_at: Date;
  note: string | null;
};

function mapAdjustment(row: AdjustmentRow): StandardAdjustment {
  return {
    id: row.id,
    scope: row.scope,
    product_number: row.product_number,
    operation: row.operation,
    percent: toNumOr(row.percent, 0),
    created_by: row.created_by,
    created_at: toMsOr(row.created_at, 0),
    note: row.note,
  };
}

const ADJ_SQL = `SELECT a.id, a.scope, a.product_number, o.name AS operation, a.percent, a.created_by, a.created_at, a.note
   FROM standard_adjustments a LEFT JOIN operations o ON o.id = a.operation_id`;

export async function listAdjustments(db: Db, opts: { activeOnly?: boolean } = {}): Promise<StandardAdjustment[]> {
  const where = opts.activeOnly === false ? '' : 'WHERE a.active';
  const { rows } = await db.query<AdjustmentRow>(`${ADJ_SQL} ${where} ORDER BY a.created_at DESC, a.id DESC`);
  return rows.map(mapAdjustment);
}

export async function getAdjustment(db: Db, id: number): Promise<StandardAdjustment | null> {
  const { rows } = await db.query<AdjustmentRow>(`${ADJ_SQL} WHERE a.id = $1`, [id]);
  return rows.length > 0 ? mapAdjustment(rows[0]) : null;
}

export async function insertAdjustment(
  db: Db,
  input: {
    scope: AdjustmentScope;
    product_number: string | null;
    operation_id: number | null;
    percent: number;
    created_by: string | null;
    note: string;
  },
): Promise<StandardAdjustment> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO standard_adjustments (scope, product_number, operation_id, percent, created_by, note, active)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [input.scope, input.product_number, input.operation_id, input.percent, input.created_by, input.note],
  );
  const created = await getAdjustment(db, rows[0].id);
  if (!created) throw new Error('adjustment insert failed');
  return created;
}

export async function deactivateAdjustment(db: Db, id: number): Promise<boolean> {
  const res = await db.query('UPDATE standard_adjustments SET active = false WHERE id = $1 AND active', [id]);
  return (res.rowCount ?? 0) > 0;
}

type OverrideRow = {
  id: number;
  scope: OverrideScope;
  product_number: string;
  operation: string | null;
  std_hr: number;
  created_by: string | null;
  created_at: Date;
  note: string | null;
  active: boolean;
};

function mapOverride(row: OverrideRow): StandardOverride {
  return {
    id: row.id,
    scope: row.scope,
    product_number: row.product_number,
    operation: row.operation,
    std_hr: toNumOr(row.std_hr, 0),
    created_by: row.created_by,
    created_at: toMsOr(row.created_at, 0),
    note: row.note,
    active: row.active,
  };
}

const OVR_SQL = `SELECT v.id, v.scope, v.product_number, o.name AS operation, v.std_hr, v.created_by, v.created_at, v.note, v.active
   FROM standard_overrides v LEFT JOIN operations o ON o.id = v.operation_id`;

export async function listOverrides(
  db: Db,
  opts: { productNumber?: string | null; activeOnly?: boolean } = {},
): Promise<StandardOverride[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.activeOnly !== false) clauses.push('v.active');
  if (opts.productNumber) {
    params.push(opts.productNumber);
    clauses.push(`v.product_number = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<OverrideRow>(`${OVR_SQL} ${where} ORDER BY v.created_at DESC, v.id DESC`, params);
  return rows.map(mapOverride);
}

export async function getOverride(db: Db, id: number): Promise<StandardOverride | null> {
  const { rows } = await db.query<OverrideRow>(`${OVR_SQL} WHERE v.id = $1`, [id]);
  return rows.length > 0 ? mapOverride(rows[0]) : null;
}

export async function insertOverride(
  db: Db,
  input: {
    scope: OverrideScope;
    product_number: string;
    operation_id: number | null;
    std_hr: number;
    created_by: string | null;
    note: string;
  },
): Promise<StandardOverride> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO standard_overrides (scope, product_number, operation_id, std_hr, created_by, note, active)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [input.scope, input.product_number, input.operation_id, input.std_hr, input.created_by, input.note],
  );
  const created = await getOverride(db, rows[0].id);
  if (!created) throw new Error('override insert failed');
  return created;
}

export async function deactivateOverride(db: Db, id: number): Promise<boolean> {
  const res = await db.query('UPDATE standard_overrides SET active = false WHERE id = $1 AND active', [id]);
  return (res.rowCount ?? 0) > 0;
}
