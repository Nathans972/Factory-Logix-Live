/**
 * Pure view builders for the TV display and the manager portal (spec 8.3, 8.5, 9.2-9.6).
 */
import type {
  CellColor,
  GroupedHourCell,
  HourCell,
  Standard,
  StandardAdjustment,
  UtcMs,
  WindowColumn,
} from '@fld/shared';
import type {
  EngineSettings,
  FloorRow,
  FloorView,
  FloorViewInput,
  JobDetail,
  JobDetailInput,
  JobOperatorTotal,
  JobShiftHistoryRow,
  OperatorDetail,
  OperatorDetailInput,
  OperatorRangeRow,
  OperatorStrip,
  PinModeOrNull,
  ProductOperationRow,
  ProductView,
  ProductViewInput,
  ShiftJobSection,
  ShiftOperationRow,
  ShiftOperatorRow,
  ShiftView,
  ShiftViewInput,
  TvCell,
  TvDashboard,
  TvDashboardInput,
  TvDefectRow,
  TvRow,
} from '@fld/shared';
import { colorForPace, groupCells } from './cells.js';
import { computeRollups } from './rollups.js';
import { resolveEffectiveStandard } from './standards.js';
import { hourStartUtc } from './time.js';

const UNKNOWN_OP_SEQ_BASE = 1000;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function blankCell(hour_start_utc: UtcMs): TvCell {
  return {
    hour_start_utc,
    units: 0,
    color: 'blank',
    pace: null,
    charged_minutes: 0,
    eligible: false,
    visitor: false,
    provisional: false,
  };
}

function blankRow(columns: WindowColumn[]): TvCell[] {
  return columns.map((c) => blankCell(c.hour_start_utc));
}

/** Route sequencer: 1-based route index, unknown operations get 1000+ in first-seen order. */
function makeSeq(route: string[]): (operation: string) => number {
  const idx = new Map<string, number>();
  route.forEach((op, i) => {
    if (!idx.has(op)) idx.set(op, i + 1);
  });
  const unknown = new Map<string, number>();
  return (operation: string): number => {
    const known = idx.get(operation);
    if (known !== undefined) return known;
    let u = unknown.get(operation);
    if (u === undefined) {
      u = unknown.size;
      unknown.set(operation, u);
    }
    return UNKNOWN_OP_SEQ_BASE + u;
  };
}

function tvCellFromHourCell(c: HourCell): TvCell {
  return {
    hour_start_utc: c.hour_start_utc,
    units: c.units,
    color: c.color,
    pace: c.pace,
    charged_minutes: c.charged_minutes,
    eligible: c.eligible,
    visitor: !c.eligible,
    provisional: c.provisional,
  };
}

function tvCellFromGrouped(g: GroupedHourCell): TvCell {
  const eligible = g.eligible_operators.length > 0;
  return {
    hour_start_utc: g.hour_start_utc,
    units: g.units,
    color: g.color,
    pace: g.pace,
    charged_minutes: g.charged_minutes,
    eligible,
    visitor: !eligible && g.visitor_units > 0,
    provisional: g.provisional,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Color for an aggregate row: neutral when there is no standard or too little charged time. */
function aggregateColor(
  std_hr: number | null,
  charged_minutes: number,
  pace: number | null,
  settings: EngineSettings,
): CellColor {
  if (std_hr === null) return 'neutral';
  if (charged_minutes < settings.neutral_minutes) return 'neutral';
  return colorForPace(pace, settings);
}

/**
 * Totals of a row that adds up hour cells (spec 7.11). A cell keeps the StdHr in force when it was
 * computed, so a standard changed mid-range gives one row several: the target is the sum of the cells'
 * own targets and the pace is earned hours over charged hours, the arithmetic of computeRollups, so the
 * row agrees with the efficiency of the same cells (with a single StdHr that is units / target). A cell
 * without a StdHr leaves the row unjudged, as it does a roll-up.
 */
interface RowTotals {
  charged_minutes: number;
  target_units: number;
  earned_hours: number;
  cells_without_std: number;
}

function newRowTotals(): RowTotals {
  return { charged_minutes: 0, target_units: 0, earned_hours: 0, cells_without_std: 0 };
}

function addToRow(t: RowTotals, c: HourCell): void {
  t.charged_minutes += c.charged_minutes;
  if (c.std_hr !== null && c.std_hr > 0) {
    t.target_units += (c.std_hr * c.charged_minutes) / 60;
    t.earned_hours += c.units / c.std_hr;
  } else {
    t.cells_without_std += 1;
  }
}

function rowPace(t: RowTotals): number | null {
  const charged_hours = t.charged_minutes / 60;
  return charged_hours > 0 && t.cells_without_std === 0 ? t.earned_hours / charged_hours : null;
}

/**
 * The later of two cells that carry a StdHr. A row shows the StdHr of its latest hour: the standard in
 * force now, as the TV and the product page show it (earlier hours may have run against another).
 */
function laterStdCell(cur: HourCell | null, c: HourCell): HourCell | null {
  if (c.std_hr === null) return cur;
  return cur === null || c.hour_start_utc >= cur.hour_start_utc ? c : cur;
}

// ---------------------------------------------------------------------------
// TV dashboard (8.3, 8.5)
// ---------------------------------------------------------------------------

interface TvRowAcc {
  operation: string;
  operator_id: string | null;
  cells: TvCell[];
  anyEligible: boolean;
  anyVisitor: boolean;
  eligibleOps: Set<string>;
  visitorOps: Set<string>;
}

export function buildTvDashboard(input: TvDashboardInput): TvDashboard {
  const {
    work_order,
    route,
    cells,
    prior,
    defect_cells,
    prior_defects,
    columns,
    grouped,
    show_std_day,
    shift_length_hours,
    std_hr_by_operation,
    operator_names,
    derived_qty_complete,
    settings,
    now,
  } = input;

  const colIndex = new Map<number, number>();
  columns.forEach((c, i) => colIndex.set(c.hour_start_utc, i));
  const seq = makeSeq(route);

  const rowAccs = new Map<string, TvRowAcc>();
  const ensureRow = (operation: string, operator_id: string | null): TvRowAcc => {
    const key = `${operation}|${operator_id ?? ''}`;
    let acc = rowAccs.get(key);
    if (acc === undefined) {
      acc = {
        operation,
        operator_id,
        cells: blankRow(columns),
        anyEligible: false,
        anyVisitor: false,
        eligibleOps: new Set<string>(),
        visitorOps: new Set<string>(),
      };
      rowAccs.set(key, acc);
    }
    return acc;
  };

  if (grouped) {
    for (const g of groupCells(cells, settings, now)) {
      const col = colIndex.get(g.hour_start_utc);
      if (col === undefined) continue;
      const acc = ensureRow(g.operation, null);
      const cell = tvCellFromGrouped(g);
      acc.cells[col] = cell;
      if (cell.eligible) acc.anyEligible = true;
      if (cell.visitor) acc.anyVisitor = true;
      for (const o of g.eligible_operators) acc.eligibleOps.add(o);
      for (const o of g.visitor_operators) acc.visitorOps.add(o);
    }
  } else {
    for (const c of cells) {
      const col = colIndex.get(c.hour_start_utc);
      if (col === undefined) continue;
      const acc = ensureRow(c.operation, c.operator_id);
      const cell = tvCellFromHourCell(c);
      acc.cells[col] = cell;
      if (c.eligible) {
        acc.anyEligible = true;
        acc.eligibleOps.add(c.operator_id);
      } else {
        acc.anyVisitor = true;
        acc.visitorOps.add(c.operator_id);
      }
    }
  }

  // Prior counts.
  const priorSeparate = new Map<string, number>();
  const priorGrouped = new Map<string, number>();
  for (const p of prior) {
    priorGrouped.set(p.operation, (priorGrouped.get(p.operation) ?? 0) + p.units);
    const key = `${p.operation}|${p.operator_id ?? ''}`;
    priorSeparate.set(key, (priorSeparate.get(key) ?? 0) + p.units);
  }

  const rows: TvRow[] = [];
  for (const acc of rowAccs.values()) {
    const visitor_row = !acc.anyEligible && acc.anyVisitor;
    // Spec 8.5: an operator who is a visitor in every hour of the window is omitted.
    if (!grouped && visitor_row) continue;

    const std_hr = std_hr_by_operation[acc.operation] ?? null;
    const shift = acc.cells.reduce((sum, c) => sum + c.units, 0);
    const priorUnits = grouped
      ? priorGrouped.get(acc.operation) ?? 0
      : priorSeparate.get(`${acc.operation}|${acc.operator_id ?? ''}`) ?? 0;

    // Distinct operators inside the window: the eligible ones when there are any, else the visitors.
    const operators = (acc.eligibleOps.size > 0 ? [...acc.eligibleOps] : [...acc.visitorOps]).sort(cmp);
    // Grouped rows name their operator only when exactly one operator worked the step.
    const rowOperator = acc.operator_id ?? (operators.length === 1 ? operators[0]! : null);
    rows.push({
      operation: acc.operation,
      operation_seq: seq(acc.operation),
      operator_id: rowOperator,
      operator_name: rowOperator === null ? null : operator_names[rowOperator] ?? rowOperator,
      operators,
      std_hr,
      prior: priorUnits,
      cells: acc.cells,
      shift,
      std_day: std_hr === null ? null : std_hr * shift_length_hours,
      visitor_row: grouped ? false : visitor_row,
    });
  }
  rows.sort(
    (a, b) =>
      a.operation_seq - b.operation_seq ||
      cmp(a.operation, b.operation) ||
      cmp(a.operator_name ?? a.operator_id ?? '', b.operator_name ?? b.operator_id ?? ''),
  );

  // Defect rows.
  const defectOps: string[] = [];
  const seenDefectOp = new Set<string>();
  const addDefectOp = (op: string): void => {
    if (seenDefectOp.has(op)) return;
    seenDefectOp.add(op);
    defectOps.push(op);
  };
  for (const op of route) addDefectOp(op);
  for (const d of defect_cells) {
    if (d.count !== 0 && colIndex.has(d.hour_start_utc)) addDefectOp(d.operation);
  }
  for (const p of prior_defects) {
    if (p.count !== 0) addDefectOp(p.operation);
  }

  const priorDefectByOp = new Map<string, number>();
  for (const p of prior_defects) {
    priorDefectByOp.set(p.operation, (priorDefectByOp.get(p.operation) ?? 0) + p.count);
  }
  const defectCellsByOp = new Map<string, number[]>();
  for (const op of defectOps) defectCellsByOp.set(op, columns.map(() => 0));
  for (const d of defect_cells) {
    const col = colIndex.get(d.hour_start_utc);
    if (col === undefined) continue;
    const arr = defectCellsByOp.get(d.operation);
    if (arr === undefined) continue;
    arr[col] = (arr[col] ?? 0) + d.count;
  }

  const defect_rows: TvDefectRow[] = defectOps.map((operation) => {
    const cellCounts = defectCellsByOp.get(operation) ?? columns.map(() => 0);
    return {
      operation,
      operation_seq: seq(operation),
      prior: priorDefectByOp.get(operation) ?? 0,
      cells: cellCounts,
      shift_qty: cellCounts.reduce((a, b) => a + b, 0),
    };
  });
  defect_rows.sort((a, b) => a.operation_seq - b.operation_seq || cmp(a.operation, b.operation));

  const qty_complete = work_order.qty_complete ?? derived_qty_complete ?? 0;
  const progress = work_order.qty_released > 0 ? clamp01(qty_complete / work_order.qty_released) : 0;

  return {
    job: {
      job_number: work_order.job_number,
      product_number: work_order.product_number,
      product_name: work_order.product_name,
      qty_released: work_order.qty_released,
      qty_complete,
      progress,
    },
    grouped,
    show_std_day,
    columns,
    rows,
    defect_rows,
    generated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Shift view (9.2)
// ---------------------------------------------------------------------------

export function buildShiftView(input: ShiftViewInput): ShiftView {
  const {
    shift,
    cells,
    work_orders,
    routes,
    active_job_numbers,
    operator_names,
    derived_qty_complete,
    filters,
    settings,
    now,
  } = input;

  const f = filters ?? {};
  const jobFilter = f.job != null && f.job !== '' ? f.job : null;
  const productFilter = f.product != null && f.product !== '' ? f.product : null;
  const operationFilter = f.operation != null && f.operation !== '' ? f.operation : null;
  const operatorFilter = f.operator != null && f.operator !== '' ? f.operator : null;

  const filtered = cells.filter(
    (c) =>
      (jobFilter === null || c.job_number === jobFilter) &&
      (productFilter === null || c.product_number === productFilter) &&
      (operationFilter === null || c.operation === operationFilter) &&
      (operatorFilter === null || c.operator_id === operatorFilter),
  );

  const woByJob = new Map(work_orders.map((w) => [w.job_number, w]));
  const cellsByJob = new Map<string, HourCell[]>();
  for (const c of filtered) {
    let list = cellsByJob.get(c.job_number);
    if (list === undefined) {
      list = [];
      cellsByJob.set(c.job_number, list);
    }
    list.push(c);
  }

  const jobs: ShiftJobSection[] = [];
  for (const job_number of [...active_job_numbers].sort(cmp)) {
    if (jobFilter !== null && job_number !== jobFilter) continue;
    const wo = woByJob.get(job_number);
    const jobCells = cellsByJob.get(job_number) ?? [];
    const product_number = wo?.product_number ?? jobCells[0]?.product_number ?? '';
    if (productFilter !== null && product_number !== productFilter) continue;

    const route = routes[product_number] ?? [];
    const seq = makeSeq(route);

    const byOperation = new Map<string, HourCell[]>();
    for (const c of jobCells) {
      let list = byOperation.get(c.operation);
      if (list === undefined) {
        list = [];
        byOperation.set(c.operation, list);
      }
      list.push(c);
    }

    const operations: ShiftOperationRow[] = [];
    for (const [operation, opCells] of byOperation) {
      let units = 0;
      let visitor_units = 0;
      const totals = newRowTotals();
      let stdCell: HourCell | null = null;
      const operatorAccs = new Map<
        string,
        { units: number; visitorUnits: number; totals: RowTotals; eligible: boolean }
      >();

      for (const c of opCells) {
        stdCell = laterStdCell(stdCell, c);
        let acc = operatorAccs.get(c.operator_id);
        if (acc === undefined) {
          acc = { units: 0, visitorUnits: 0, totals: newRowTotals(), eligible: false };
          operatorAccs.set(c.operator_id, acc);
        }
        if (c.eligible) {
          units += c.units;
          addToRow(totals, c);
          acc.units += c.units;
          addToRow(acc.totals, c);
          acc.eligible = true;
        } else {
          visitor_units += c.units;
          acc.visitorUnits += c.units;
        }
      }

      const std_hr = stdCell?.std_hr ?? null;
      const { charged_minutes, target_units } = totals;
      const pace = rowPace(totals);

      const operators: ShiftOperatorRow[] = [];
      for (const [operator_id, acc] of operatorAccs) {
        if (acc.eligible) {
          const p = rowPace(acc.totals);
          operators.push({
            operator_id,
            operator_name: operator_names[operator_id] ?? operator_id,
            units: acc.units,
            charged_minutes: acc.totals.charged_minutes,
            target_units: acc.totals.target_units,
            pace: p,
            color: aggregateColor(std_hr, acc.totals.charged_minutes, p, settings),
            eligible: true,
            visitor: false,
          });
        } else {
          operators.push({
            operator_id,
            operator_name: operator_names[operator_id] ?? operator_id,
            units: acc.visitorUnits,
            charged_minutes: 0,
            target_units: 0,
            pace: null,
            color: 'visitor',
            eligible: false,
            visitor: true,
          });
        }
      }
      operators.sort(
        (a, b) =>
          cmp(a.operator_name ?? a.operator_id, b.operator_name ?? b.operator_id) ||
          cmp(a.operator_id, b.operator_id),
      );

      operations.push({
        operation,
        operation_seq: seq(operation),
        std_hr,
        eligible_operators: operators.filter((o) => o.eligible).length,
        units,
        visitor_units,
        charged_minutes,
        target_units,
        pace,
        color: aggregateColor(std_hr, charged_minutes, pace, settings),
        operators,
      });
    }
    operations.sort(
      (a, b) => a.operation_seq - b.operation_seq || cmp(a.operation, b.operation),
    );

    const jobRollups = computeRollups(jobCells, settings, { operator_names });
    const qty_complete = wo?.qty_complete ?? derived_qty_complete[job_number] ?? 0;
    const qty_released = wo?.qty_released ?? 0;

    jobs.push({
      job_number,
      product_number,
      product_name: wo?.product_name ?? null,
      qty_released,
      qty_complete,
      progress: qty_released > 0 ? clamp01(qty_complete / qty_released) : 0,
      units: jobRollups.overall.units,
      charged_hours: jobRollups.overall.charged_hours,
      earned_hours: jobRollups.overall.earned_hours,
      efficiency: jobRollups.overall.efficiency,
      color: jobRollups.overall.color,
      operations,
    });
  }

  const rollups = computeRollups(filtered, settings, { operator_names });
  const eligibleOperators = new Set<string>();
  for (const c of filtered) {
    if (c.eligible) eligibleOperators.add(c.operator_id);
  }

  return {
    shift,
    in_progress: shift.start_utc <= now && now < shift.end_utc,
    summary: {
      efficiency: rollups.overall.efficiency,
      color: rollups.overall.color,
      total_units: rollups.overall.units,
      total_charged_hours: rollups.overall.charged_hours,
      total_earned_hours: rollups.overall.earned_hours,
      active_jobs: jobs.length,
      eligible_operators: eligibleOperators.size,
      rows_without_std: rollups.overall.rows_without_std,
    },
    jobs,
    rollups,
    generated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Floor view (9.3)
// ---------------------------------------------------------------------------

export function buildFloorView(input: FloorViewInput): FloorView {
  const { current_cells, window_cells, assignments, operator_names, product_names, settings, now } =
    input;
  const hour_start_utc = hourStartUtc(now, settings.plant_timezone);

  const units12h = new Map<string, number>();
  for (const c of window_cells) {
    units12h.set(c.operator_id, (units12h.get(c.operator_id) ?? 0) + c.units);
  }
  const assignmentByOperator = new Map(assignments.map((a) => [a.operator_id, a]));

  const rows: FloorRow[] = [];
  for (const c of current_cells) {
    if (c.hour_start_utc !== hour_start_utc) continue;
    const assignment = assignmentByOperator.get(c.operator_id);
    const last_scan_at = assignment?.last_scan_at ?? null;
    const minutes_since_scan = last_scan_at === null ? null : (now - last_scan_at) / 60_000;
    rows.push({
      operator_id: c.operator_id,
      operator_name: operator_names[c.operator_id] ?? c.operator_id,
      job_number: c.job_number,
      product_number: c.product_number,
      product_name: product_names[c.product_number] ?? null,
      operation: c.operation,
      units_hour: c.units,
      pace: c.pace,
      color: c.color,
      units_12h: units12h.get(c.operator_id) ?? 0,
      last_scan_at,
      minutes_since_scan,
      idle_flag:
        minutes_since_scan !== null && minutes_since_scan > settings.floor_idle_flag_minutes,
      visitor: !c.eligible,
    });
  }
  rows.sort(
    (a, b) =>
      cmp(a.operator_name ?? a.operator_id, b.operator_name ?? b.operator_id) ||
      cmp(a.operator_id, b.operator_id) ||
      cmp(a.job_number, b.job_number) ||
      cmp(a.operation, b.operation),
  );

  return { hour_start_utc, rows, generated_at: now };
}

// ---------------------------------------------------------------------------
// Operator detail (9.4)
// ---------------------------------------------------------------------------

export function buildOperatorDetail(input: OperatorDetailInput): OperatorDetail {
  const {
    operator_id,
    operator_name,
    cells,
    columns,
    assignment,
    pins,
    product_names,
    settings,
    now,
    range,
  } = input;

  const colIndex = new Map<number, number>();
  columns.forEach((c, i) => colIndex.set(c.hour_start_utc, i));

  interface StripAcc {
    job: string;
    product: string;
    op: string;
    std_cell: HourCell | null;
    cells: TvCell[];
    total_units: number;
  }
  const stripAccs = new Map<string, StripAcc>();

  interface RowAcc {
    job: string;
    product: string;
    op: string;
    std_cell: HourCell | null;
    window_minutes: number;
    totals: RowTotals;
    units: number;
    eligible_hours: number;
    visitor_hours: number;
  }
  const rowAccs = new Map<string, RowAcc>();

  for (const c of cells) {
    if (c.operator_id !== operator_id) continue;
    const key = `${c.job_number}|${c.operation}`;

    const col = colIndex.get(c.hour_start_utc);
    if (col !== undefined) {
      let strip = stripAccs.get(key);
      if (strip === undefined) {
        strip = {
          job: c.job_number,
          product: c.product_number,
          op: c.operation,
          std_cell: null,
          cells: blankRow(columns),
          total_units: 0,
        };
        stripAccs.set(key, strip);
      }
      strip.cells[col] = tvCellFromHourCell(c);
      strip.total_units += c.units;
      strip.std_cell = laterStdCell(strip.std_cell, c);
    }

    if (c.hour_start_utc >= range.from_utc && c.hour_start_utc < range.to_utc) {
      let row = rowAccs.get(key);
      if (row === undefined) {
        row = {
          job: c.job_number,
          product: c.product_number,
          op: c.operation,
          std_cell: null,
          window_minutes: 0,
          totals: newRowTotals(),
          units: 0,
          eligible_hours: 0,
          visitor_hours: 0,
        };
        rowAccs.set(key, row);
      }
      row.std_cell = laterStdCell(row.std_cell, c);
      row.window_minutes += c.window_minutes;
      addToRow(row.totals, c);
      row.units += c.units;
      if (c.eligible) row.eligible_hours += 1;
      else row.visitor_hours += 1;
    }
  }

  const activePin = (job_number: string, operation: string): PinModeOrNull => {
    let best: { mode: PinModeOrNull; rank: number; created_at: UtcMs } | null = null;
    for (const p of pins) {
      if (p.operator_id !== operator_id || p.job_number !== job_number) continue;
      if (p.expires_at !== null && p.expires_at !== undefined && p.expires_at <= now) continue;
      const rank = p.operation === operation ? 2 : p.operation === null ? 1 : 0;
      if (rank === 0) continue;
      if (best === null || rank > best.rank || (rank === best.rank && p.created_at > best.created_at)) {
        best = { mode: p.mode, rank, created_at: p.created_at };
      }
    }
    return best?.mode ?? null;
  };

  const strips: OperatorStrip[] = [...stripAccs.values()]
    .map((s) => ({
      job_number: s.job,
      product_number: s.product,
      operation: s.op,
      std_hr: s.std_cell?.std_hr ?? null,
      cells: s.cells,
      total_units: s.total_units,
    }))
    .sort((a, b) => cmp(a.job_number, b.job_number) || cmp(a.operation, b.operation));

  const rows: OperatorRangeRow[] = [...rowAccs.values()]
    .map((r) => {
      const std_hr = r.std_cell?.std_hr ?? null;
      const pace = rowPace(r.totals);
      return {
        job_number: r.job,
        product_number: r.product,
        product_name: product_names[r.product] ?? null,
        operation: r.op,
        std_hr,
        window_minutes: r.window_minutes,
        charged_minutes: r.totals.charged_minutes,
        units: r.units,
        target_units: r.totals.target_units,
        pace,
        color: aggregateColor(std_hr, r.totals.charged_minutes, pace, settings),
        eligible_hours: r.eligible_hours,
        visitor_hours: r.visitor_hours,
        pinned: activePin(r.job, r.op),
      };
    })
    .sort((a, b) => cmp(a.job_number, b.job_number) || cmp(a.operation, b.operation));

  return {
    operator_id,
    operator_name,
    assignment,
    strips,
    rows,
    range,
    generated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Job detail (9.5)
// ---------------------------------------------------------------------------

export function buildJobDetail(input: JobDetailInput): JobDetail {
  const {
    dashboard_separate,
    dashboard_grouped,
    all_cells,
    shift_instances,
    operator_names,
    displays_showing,
    settings,
    now,
  } = input;

  interface OpAcc {
    units: number;
    charged_minutes: number;
    operations: Set<string>;
  }
  const byOperator = new Map<string, OpAcc>();
  for (const c of all_cells) {
    let acc = byOperator.get(c.operator_id);
    if (acc === undefined) {
      acc = { units: 0, charged_minutes: 0, operations: new Set<string>() };
      byOperator.set(c.operator_id, acc);
    }
    acc.units += c.units;
    acc.operations.add(c.operation);
    if (c.eligible) acc.charged_minutes += c.charged_minutes;
  }

  const operators: JobOperatorTotal[] = [...byOperator.entries()]
    .map(([operator_id, acc]) => ({
      operator_id,
      operator_name: operator_names[operator_id] ?? operator_id,
      units: acc.units,
      charged_minutes: acc.charged_minutes,
      operations: [...acc.operations].sort(cmp),
    }))
    .sort(
      (a, b) =>
        cmp(a.operator_name ?? a.operator_id, b.operator_name ?? b.operator_id) ||
        cmp(a.operator_id, b.operator_id),
    );

  const shift_history: JobShiftHistoryRow[] = [];
  for (const shift of [...shift_instances].sort((a, b) => a.start_utc - b.start_utc)) {
    const shiftCells = all_cells.filter(
      (c) => c.hour_start_utc >= shift.start_utc && c.hour_start_utc < shift.end_utc,
    );
    if (shiftCells.length === 0) continue;
    const r = computeRollups(shiftCells, settings, { operator_names }).overall;
    shift_history.push({
      shift,
      units: r.units,
      charged_hours: r.charged_hours,
      earned_hours: r.earned_hours,
      efficiency: r.efficiency,
      color: r.color,
    });
  }

  return {
    dashboard_separate,
    dashboard_grouped,
    operators,
    shift_history,
    displays_showing,
    generated_at: now,
  };
}

// ---------------------------------------------------------------------------
// Product view (9.6)
// ---------------------------------------------------------------------------

export function buildProductView(input: ProductViewInput): ProductView {
  const { product_number, product_name, route, standards, adjustments, overrides } = input;

  const standardByOp = new Map<string, Standard>();
  for (const s of standards) {
    if (s.product_number !== product_number) continue;
    standardByOp.set(s.operation, s);
  }

  const operations: string[] = [];
  const seen = new Set<string>();
  for (const op of route) {
    if (seen.has(op)) continue;
    seen.add(op);
    operations.push(op);
  }
  for (const op of standardByOp.keys()) {
    if (seen.has(op)) continue;
    seen.add(op);
    operations.push(op);
  }

  const seq = makeSeq(route);
  const rows: ProductOperationRow[] = operations.map((operation) => {
    const standard = standardByOp.get(operation) ?? null;
    return {
      operation,
      operation_seq: seq(operation),
      standard,
      effective: resolveEffectiveStandard(
        standard,
        adjustments,
        overrides,
        product_number,
        operation,
      ),
    };
  });

  const opSet = new Set(operations);
  const inScope: StandardAdjustment[] = adjustments.filter((a) => {
    switch (a.scope) {
      case 'global':
        return true;
      case 'product':
        return a.product_number === product_number;
      case 'operation':
        return a.operation !== null && opSet.has(a.operation);
      case 'product_operation':
        return (
          a.product_number === product_number && a.operation !== null && opSet.has(a.operation)
        );
      default:
        return false;
    }
  });

  return {
    product_number,
    product_name,
    rows,
    adjustments: inScope,
    overrides: overrides.filter((o) => o.product_number === product_number),
  };
}
