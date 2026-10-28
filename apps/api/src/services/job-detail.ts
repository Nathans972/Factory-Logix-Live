/** Job detail (spec 9.5): both dashboards + whole-life cells + shift history + displays showing it. */
import { pickEngineSettings, type JobDetail, type UtcMs } from '@fld/shared';
import { buildJobDetail, listShiftInstances } from '@fld/engine';
import type { Db } from '../db/pool.js';
import { getCellsForJob } from '../db/repo/cells.js';
import { listDisplayRowsForJob } from '../db/repo/displays.js';
import { getOperatorNames } from '../db/repo/operators.js';
import { listShifts } from '../db/repo/schedule.js';
import { getSettings } from '../db/repo/settings.js';
import { buildDashboard } from './dashboard.js';

const HOUR_MS = 3_600_000;

export async function buildJobDetailForJob(db: Db, jobNumber: string, now: UtcMs = Date.now()): Promise<JobDetail> {
  const settings = await getSettings(db);

  const [separate, grouped, allCells, displays, shifts] = await Promise.all([
    buildDashboard(db, jobNumber, { grouped: false, shift_length_hours: 12, show_std_day: true }, now, settings),
    buildDashboard(db, jobNumber, { grouped: true, shift_length_hours: 12, show_std_day: true }, now, settings),
    getCellsForJob(db, jobNumber),
    listDisplayRowsForJob(db, jobNumber),
    listShifts(db),
  ]);

  // A loop, not Math.min/max over a spread: a long-running job has more cells than fit on the call stack as arguments.
  let firstHour = Infinity;
  let lastHour = -Infinity;
  for (const c of allCells) {
    if (c.hour_start_utc < firstHour) firstHour = c.hour_start_utc;
    if (c.hour_start_utc > lastHour) lastHour = c.hour_start_utc;
  }
  const fromUtc = allCells.length > 0 ? firstHour : now - 12 * HOUR_MS;
  const toUtc = allCells.length > 0 ? lastHour + HOUR_MS : now;
  const shiftInstances = shifts.length > 0 ? listShiftInstances(shifts, fromUtc, toUtc, settings.plant_timezone) : [];

  const operatorNames = await getOperatorNames(db, allCells.map((c) => c.operator_id));

  return buildJobDetail({
    dashboard_separate: separate,
    dashboard_grouped: grouped,
    all_cells: allCells,
    shift_instances: shiftInstances,
    operator_names: operatorNames,
    displays_showing: displays.map((d) => ({ id: d.id, name: d.name })),
    settings: pickEngineSettings(settings),
    now,
  });
}
