/**
 * Earned-hours roll-ups (spec 7.11).
 *
 * Visitor cells contribute their units to `visitor_units` only: no charged minutes, no earned
 * hours, no operator count. Cells without a StdHr count in units and charged time but are left
 * out of efficiency (both its earned and its charged hours) and counted in `rows_without_std`.
 */
import type { CellColor, HourCell } from '@fld/shared';
import type { EngineSettings, RollupRow, Rollups } from '@fld/shared';
import { colorForPace } from './cells.js';

export function colorForEfficiency(efficiency: number | null, settings: EngineSettings): CellColor {
  return colorForPace(efficiency, settings);
}

interface Acc {
  key: string;
  label: string;
  job_number: string | null;
  product_number: string | null;
  operation: string | null;
  operator_id: string | null;
  units: number;
  visitor_units: number;
  charged_minutes: number;
  /** charged minutes of the cells with a StdHr: the efficiency's denominator */
  std_charged_minutes: number;
  earned_hours: number;
  rows_without_std: number;
  operators: Set<string>;
}

function newAcc(
  key: string,
  label: string,
  ids: {
    job_number?: string | null;
    product_number?: string | null;
    operation?: string | null;
    operator_id?: string | null;
  },
): Acc {
  return {
    key,
    label,
    job_number: ids.job_number ?? null,
    product_number: ids.product_number ?? null,
    operation: ids.operation ?? null,
    operator_id: ids.operator_id ?? null,
    units: 0,
    visitor_units: 0,
    charged_minutes: 0,
    std_charged_minutes: 0,
    earned_hours: 0,
    rows_without_std: 0,
    operators: new Set<string>(),
  };
}

function addCell(acc: Acc, cell: HourCell): void {
  if (!cell.eligible) {
    acc.visitor_units += cell.units;
    return;
  }
  acc.units += cell.units;
  acc.charged_minutes += cell.charged_minutes;
  acc.operators.add(cell.operator_id);
  if (cell.std_hr !== null && cell.std_hr > 0) {
    acc.std_charged_minutes += cell.charged_minutes;
    acc.earned_hours += cell.units / cell.std_hr;
  } else {
    acc.rows_without_std += 1;
  }
}

function finish(acc: Acc, settings: EngineSettings): RollupRow {
  const charged_hours = acc.charged_minutes / 60;
  const std_charged_hours = acc.std_charged_minutes / 60;
  const efficiency = std_charged_hours > 0 ? acc.earned_hours / std_charged_hours : null;
  return {
    key: acc.key,
    label: acc.label,
    job_number: acc.job_number,
    product_number: acc.product_number,
    operation: acc.operation,
    operator_id: acc.operator_id,
    units: acc.units,
    visitor_units: acc.visitor_units,
    charged_minutes: acc.charged_minutes,
    charged_hours,
    earned_hours: acc.earned_hours,
    efficiency,
    color: colorForEfficiency(efficiency, settings),
    eligible_operators: acc.operators.size,
    rows_without_std: acc.rows_without_std,
    charged_hours_without_std: charged_hours - std_charged_hours,
  };
}

function collect(
  map: Map<string, Acc>,
  settings: EngineSettings,
): RollupRow[] {
  const rows = [...map.values()].map((a) => finish(a, settings));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

export function computeRollups(
  cells: HourCell[],
  settings: EngineSettings,
  labels?: { operator_names?: Record<string, string | null> },
): Rollups {
  const names = labels?.operator_names ?? {};
  const overall = newAcc('overall', 'Overall', {});
  const byJob = new Map<string, Acc>();
  const byOperation = new Map<string, Acc>();
  const byOperator = new Map<string, Acc>();
  const byJobOperation = new Map<string, Acc>();

  for (const cell of cells) {
    addCell(overall, cell);

    let job = byJob.get(cell.job_number);
    if (job === undefined) {
      job = newAcc(cell.job_number, cell.job_number, {
        job_number: cell.job_number,
        product_number: cell.product_number,
      });
      byJob.set(cell.job_number, job);
    }
    addCell(job, cell);

    let op = byOperation.get(cell.operation);
    if (op === undefined) {
      op = newAcc(cell.operation, cell.operation, { operation: cell.operation });
      byOperation.set(cell.operation, op);
    }
    addCell(op, cell);

    let operator = byOperator.get(cell.operator_id);
    if (operator === undefined) {
      operator = newAcc(cell.operator_id, names[cell.operator_id] ?? cell.operator_id, {
        operator_id: cell.operator_id,
      });
      byOperator.set(cell.operator_id, operator);
    }
    addCell(operator, cell);

    const joKey = `${cell.job_number}|${cell.operation}`;
    let jo = byJobOperation.get(joKey);
    if (jo === undefined) {
      jo = newAcc(joKey, `${cell.job_number} ${cell.operation}`, {
        job_number: cell.job_number,
        product_number: cell.product_number,
        operation: cell.operation,
      });
      byJobOperation.set(joKey, jo);
    }
    addCell(jo, cell);
  }

  return {
    overall: finish(overall, settings),
    by_job: collect(byJob, settings),
    by_operation: collect(byOperation, settings),
    by_operator: collect(byOperator, settings),
    by_job_operation: collect(byJobOperation, settings),
  };
}
