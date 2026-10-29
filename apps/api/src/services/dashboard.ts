/**
 * TV / portal dashboard assembly: query the database, then hand everything to the pure engine
 * (`buildTvDashboard`). Window = the rolling 12 local hours ending with the current hour (spec 7.8).
 */
import {
  pickEngineSettings,
  type Settings,
  type TvDashboard,
  type UtcMs,
  type WindowColumn,
} from '@fld/shared';
import { buildStandardsLookup, buildTvDashboard, effectiveStdHr, rollingWindowColumns } from '@fld/engine';
import type { Db } from '../db/pool.js';
import {
  getCellsForJob,
  getDefectCellsForJob,
  getPriorCountsForJob,
  getPriorDefectsForJob,
} from '../db/repo/cells.js';
import { getOperatorNames } from '../db/repo/operators.js';
import { getRoutesForProducts, getDerivedQtyComplete } from '../db/repo/routes.js';
import { getSettings } from '../db/repo/settings.js';
import { getStandardsForProduct, listAdjustments, listOverrides } from '../db/repo/standards.js';
import { getWorkOrder, getWorkOrderFromActivity } from '../db/repo/work-orders.js';
import { notFound } from '../errors.js';

export interface DashboardOptions {
  grouped: boolean;
  show_std_day: boolean;
  shift_length_hours: number;
}

export const DEFAULT_DASHBOARD_OPTIONS: DashboardOptions = {
  grouped: false,
  show_std_day: true,
  shift_length_hours: 12,
};

/** Effective StdHr per operation for one product. */
export async function standardsByOperation(
  db: Db,
  productNumber: string,
  operations: string[],
): Promise<Record<string, number | null>> {
  const [standards, adjustments, overrides] = await Promise.all([
    getStandardsForProduct(db, productNumber),
    listAdjustments(db, { activeOnly: true }),
    listOverrides(db, { productNumber, activeOnly: true }),
  ]);
  const keys = operations.map((operation) => ({ product_number: productNumber, operation }));
  const lookup = buildStandardsLookup(standards, adjustments, overrides, keys);
  const out: Record<string, number | null> = {};
  for (const operation of operations) out[operation] = effectiveStdHr(lookup, productNumber, operation);
  return out;
}

export async function buildDashboard(
  db: Db,
  jobNumber: string,
  options: Partial<DashboardOptions> = {},
  now: UtcMs = Date.now(),
  settingsOverride?: Settings,
): Promise<TvDashboard> {
  const opts = { ...DEFAULT_DASHBOARD_OPTIONS, ...options };
  const settings = settingsOverride ?? (await getSettings(db));
  const tz = settings.plant_timezone;

  // A job with activity opens before its work order is ingested; only a job with neither is unknown.
  const workOrder = (await getWorkOrder(db, jobNumber)) ?? (await getWorkOrderFromActivity(db, jobNumber));
  if (!workOrder) throw notFound(`unknown job ${jobNumber}`);

  const columns: WindowColumn[] = rollingWindowColumns(now, tz, 12);
  const from = columns.length > 0 ? columns[0].hour_start_utc : now - 12 * 3_600_000;

  const routes = await getRoutesForProducts(db, [workOrder.product_number]);
  const route = routes[workOrder.product_number] ?? [];

  const [cells, prior, defectCells, priorDefects, derivedMap] = await Promise.all([
    getCellsForJob(db, jobNumber, from),
    getPriorCountsForJob(db, jobNumber, from),
    getDefectCellsForJob(db, jobNumber, from),
    getPriorDefectsForJob(db, jobNumber, from),
    getDerivedQtyComplete(db, [{ job_number: jobNumber, product_number: workOrder.product_number }], routes),
  ]);

  // Operations that appear in data but not in the route still need a StdHr entry.
  const operations = [...route];
  for (const source of [cells.map((c) => c.operation), prior.map((p) => p.operation), defectCells.map((d) => d.operation)]) {
    for (const operation of source) if (!operations.includes(operation)) operations.push(operation);
  }

  const [stdHrByOperation, operatorNames] = await Promise.all([
    standardsByOperation(db, workOrder.product_number, operations),
    getOperatorNames(db, [...cells.map((c) => c.operator_id), ...prior.map((p) => p.operator_id ?? '')]),
  ]);

  return buildTvDashboard({
    work_order: workOrder,
    route,
    cells,
    prior,
    defect_cells: defectCells,
    prior_defects: priorDefects,
    columns,
    grouped: opts.grouped,
    show_std_day: opts.show_std_day,
    shift_length_hours: opts.shift_length_hours,
    std_hr_by_operation: stdHrByOperation,
    operator_names: operatorNames,
    derived_qty_complete: derivedMap[jobNumber] ?? null,
    settings: pickEngineSettings(settings),
    now,
  });
}
