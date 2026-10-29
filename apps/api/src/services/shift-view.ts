/** Shift view + shift picker assembly (spec 9.2). */
import {
  pickEngineSettings,
  type ShiftInstance,
  type ShiftInstanceListItem,
  type ShiftPickerResponse,
  type ShiftView,
  type ShiftViewFilters,
  type UtcMs,
} from '@fld/shared';
import {
  buildShiftView,
  expandShiftInstance,
  findCurrentOrMostRecentShift,
  findCurrentShift,
  hourStartUtc,
  listShiftInstances,
  resolveShiftVersion,
} from '@fld/engine';
import type { Db } from '../db/pool.js';
import { getActiveJobNumbers, getCellsInRange } from '../db/repo/cells.js';
import { getOperatorNames } from '../db/repo/operators.js';
import { getDerivedQtyComplete, getRoutesForProducts } from '../db/repo/routes.js';
import { listShifts } from '../db/repo/schedule.js';
import { getSettings } from '../db/repo/settings.js';
import { getWorkOrders } from '../db/repo/work-orders.js';
import { badRequest, notFound } from '../errors.js';

export interface ShiftViewQuery extends ShiftViewFilters {
  date?: string | null;
  shift_id?: number | null;
}

export async function buildShiftPicker(db: Db, now: UtcMs = Date.now()): Promise<ShiftPickerResponse> {
  const settings = await getSettings(db);
  const shifts = await listShifts(db);
  const tz = settings.plant_timezone;
  if (shifts.length === 0) return { current: null, most_recent: null, shifts };
  return {
    current: findCurrentShift(shifts, now, tz),
    most_recent: findCurrentOrMostRecentShift(shifts, now, tz),
    shifts,
  };
}

export async function listShiftInstancesInRange(
  db: Db,
  fromUtc: UtcMs,
  toUtc: UtcMs,
  now: UtcMs = Date.now(),
): Promise<ShiftInstanceListItem[]> {
  const settings = await getSettings(db);
  const shifts = await listShifts(db);
  if (shifts.length === 0) return [];
  const instances = listShiftInstances(shifts, fromUtc, toUtc, settings.plant_timezone);
  return instances.map((instance) => ({
    ...instance,
    in_progress: now >= instance.start_utc && now < instance.end_utc,
  }));
}

/** date + shift_id selects an explicit instance; otherwise the current (or most recent) shift. */
export async function resolveShiftInstance(
  db: Db,
  query: { date?: string | null; shift_id?: number | null },
  now: UtcMs = Date.now(),
): Promise<ShiftInstance> {
  const settings = await getSettings(db);
  const shifts = await listShifts(db);
  const tz = settings.plant_timezone;
  if (shifts.length === 0) throw notFound('no shifts are configured');

  if (query.date && query.shift_id !== null && query.shift_id !== undefined) {
    const requested = shifts.find((s) => s.id === query.shift_id);
    if (!requested) throw notFound(`unknown shift ${query.shift_id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) throw badRequest('date must be YYYY-MM-DD');
    // The page keeps the shift id when the date changes: use the version in effect that day, not this id's times.
    const shift = resolveShiftVersion(shifts, requested, query.date);
    if (!shift) throw notFound(`shift ${requested.name} was not in effect on ${query.date}`);
    return expandShiftInstance(shift, query.date, tz);
  }
  if (query.date || (query.shift_id !== null && query.shift_id !== undefined)) {
    throw badRequest('date and shift_id must be provided together');
  }

  const instance = findCurrentOrMostRecentShift(shifts, now, tz);
  if (!instance) throw notFound('no shift instance found for the current time');
  return instance;
}

export async function buildShiftViewForQuery(db: Db, query: ShiftViewQuery, now: UtcMs = Date.now()): Promise<ShiftView> {
  const settings = await getSettings(db);
  const shift = await resolveShiftInstance(db, query, now);

  const [cells, activeJobNumbers] = await Promise.all([
    // From the start of the shift's first hour: a shift starting mid-hour (06:30) takes part of it.
    getCellsInRange(db, hourStartUtc(shift.start_utc, settings.plant_timezone), shift.end_utc),
    getActiveJobNumbers(db, shift.start_utc, shift.end_utc),
  ]);

  const jobNumbers = [...new Set([...activeJobNumbers, ...cells.map((c) => c.job_number)])];
  const workOrders = await getWorkOrders(db, jobNumbers);
  const productNumbers = [...new Set(workOrders.map((w) => w.product_number))];
  const routes = await getRoutesForProducts(db, productNumbers);

  const [operatorNames, derivedQtyComplete] = await Promise.all([
    getOperatorNames(db, cells.map((c) => c.operator_id)),
    getDerivedQtyComplete(
      db,
      workOrders.map((w) => ({ job_number: w.job_number, product_number: w.product_number })),
      routes,
    ),
  ]);

  return buildShiftView({
    shift,
    cells,
    work_orders: workOrders,
    routes,
    active_job_numbers: activeJobNumbers,
    operator_names: operatorNames,
    derived_qty_complete: derivedQtyComplete,
    filters: {
      job: query.job ?? null,
      product: query.product ?? null,
      operation: query.operation ?? null,
      operator: query.operator ?? null,
    },
    settings: pickEngineSettings(settings),
    now,
  });
}
