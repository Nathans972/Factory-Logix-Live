/** Operator detail (spec 9.4): range from from/to, date+shift_id, or the last 12 hours. */
import { pickEngineSettings, type OperatorDetail, type UtcMs } from '@fld/shared';
import { buildOperatorDetail, hourColumns, hourStartUtc } from '@fld/engine';
import type { Db } from '../db/pool.js';
import { getCellsForOperator } from '../db/repo/cells.js';
import { getAssignment, getOperator, getOperatorNames } from '../db/repo/operators.js';
import { listPins } from '../db/repo/pins.js';
import { getProductNames } from '../db/repo/products.js';
import { getSettings } from '../db/repo/settings.js';
import { badRequest } from '../errors.js';
import { resolveShiftInstance } from './shift-view.js';

const HOUR_MS = 3_600_000;
const STRIP_HOURS = 12;

export interface OperatorDetailQuery {
  from?: UtcMs | null;
  to?: UtcMs | null;
  date?: string | null;
  shift_id?: number | null;
}

export async function buildOperatorDetailForQuery(
  db: Db,
  operatorId: string,
  query: OperatorDetailQuery,
  now: UtcMs = Date.now(),
): Promise<OperatorDetail> {
  const settings = await getSettings(db);
  const tz = settings.plant_timezone;

  let from: UtcMs;
  let to: UtcMs;
  if (query.from !== null && query.from !== undefined && query.to !== null && query.to !== undefined) {
    from = query.from;
    to = query.to;
    if (!(to > from)) throw badRequest('to must be greater than from');
  } else if (query.date || (query.shift_id !== null && query.shift_id !== undefined)) {
    const shift = await resolveShiftInstance(db, { date: query.date, shift_id: query.shift_id }, now);
    from = shift.start_utc;
    to = shift.end_utc;
  } else {
    const currentHour = hourStartUtc(now, tz);
    from = currentHour - (STRIP_HOURS - 1) * HOUR_MS;
    to = currentHour + HOUR_MS;
  }

  // The strips only show the last 12 hours of the range; the full range is still passed as cells.
  const columnsFrom = Math.max(from, to - STRIP_HOURS * HOUR_MS);
  const columns = hourColumns(columnsFrom, to, tz);

  const [cells, assignment, pins, operator] = await Promise.all([
    getCellsForOperator(db, operatorId, from, to),
    getAssignment(db, operatorId),
    listPins(db, { operator_id: operatorId, activeOnly: true }),
    getOperator(db, operatorId),
  ]);

  let operatorName = operator?.display_name ?? null;
  if (!operator) {
    const names = await getOperatorNames(db, [operatorId]);
    operatorName = names[operatorId] ?? null;
  }

  const productNames = await getProductNames(db, cells.map((c) => c.product_number));

  return buildOperatorDetail({
    operator_id: operatorId,
    operator_name: operatorName,
    cells,
    columns,
    assignment,
    pins,
    product_names: productNames,
    settings: pickEngineSettings(settings),
    now,
    range: { from_utc: from, to_utc: to },
  });
}
