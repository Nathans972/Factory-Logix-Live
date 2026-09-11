/** Floor overview (spec 9.3): current-hour cells + a 12 hour window for units_12h. */
import { pickEngineSettings, type FloorView, type UtcMs } from '@fld/shared';
import { buildFloorView, hourStartUtc } from '@fld/engine';
import type { Db } from '../db/pool.js';
import { getCellsForHour, getCellsInRange } from '../db/repo/cells.js';
import { listAssignments, getOperatorNames } from '../db/repo/operators.js';
import { getProductNames } from '../db/repo/products.js';
import { getSettings } from '../db/repo/settings.js';

const HOUR_MS = 3_600_000;

export async function buildFloor(db: Db, showVisitors: boolean, now: UtcMs = Date.now()): Promise<FloorView> {
  const settings = await getSettings(db);
  const currentHour = hourStartUtc(now, settings.plant_timezone);

  const [currentCells, windowCells, assignments] = await Promise.all([
    getCellsForHour(db, currentHour),
    getCellsInRange(db, currentHour - 11 * HOUR_MS, currentHour + HOUR_MS),
    listAssignments(db),
  ]);

  const operatorIds = [
    ...currentCells.map((c) => c.operator_id),
    ...windowCells.map((c) => c.operator_id),
    ...assignments.map((a) => a.operator_id),
  ];
  const productNumbers = [...currentCells.map((c) => c.product_number), ...windowCells.map((c) => c.product_number)];

  const [operatorNames, productNames] = await Promise.all([
    getOperatorNames(db, operatorIds),
    getProductNames(db, productNumbers),
  ]);

  const view = buildFloorView({
    current_cells: currentCells,
    window_cells: windowCells,
    assignments,
    operator_names: operatorNames,
    product_names: productNames,
    settings: pickEngineSettings(settings),
    now,
  });

  if (!showVisitors) return { ...view, rows: view.rows.filter((r) => !r.visitor) };
  return view;
}
