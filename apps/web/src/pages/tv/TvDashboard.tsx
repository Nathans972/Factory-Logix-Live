/**
 * The dashboard itself (spec 8.3) — pure presentational, no data fetching, no portal styles.
 * Rendered full-screen by `TvPage` and embedded (with `compact`) by the portal job page.
 */
import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  TvCell,
  TvDashboard as TvDashboardData,
  TvDefectRow,
  TvRow,
  WindowColumn,
} from '@fld/shared';
import { TvClock } from './TvClock';
import { TvGauge } from './TvGauge';
import { TV_STYLE_VARS, cellClass, cellText, fitRows, formatStd, rowOperatorLabel, type RowsCut } from './tvLogic';
import './tv.css';

export interface TvDashboardProps {
  dashboard: TvDashboardData;
  /** per-display setting (spec 8.6) */
  showGauge: boolean;
  /** plant time zone for the clock */
  tz: string;
  /** plant-clock time of the last successful refresh */
  updatedAt: number | null;
  /** embedded in the portal: smaller type, in-flow height */
  compact?: boolean;
}

const ROOT_STYLE = TV_STYLE_VARS as unknown as CSSProperties;

/** Layout effects in the browser, so rows are fitted before they are painted; the tests render on the server. */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function TvDashboard({ dashboard, showGauge, tz, updatedAt, compact = false }: TvDashboardProps) {
  const { job, columns, rows, defect_rows, show_std_day } = dashboard;
  const { boxRef, tableRef, cut } = useRowFit(!compact);

  return (
    <div className={`tv-root tv-dash${compact ? ' tv-compact' : ''}`} style={ROOT_STYLE}>
      <TvHeader job={job} />

      <div className="tv-output" ref={boxRef}>
        <table className="tv-table tv-output-table" ref={tableRef}>
          <colgroup>
            <col className="c-op" />
            <col className="c-operator" />
            <col className="c-std" />
            <col className="c-prior" />
            {columns.map((c) => (
              <col key={c.hour_start_utc} className="c-hour" />
            ))}
            <col className="c-shift" />
            {show_std_day && <col className="c-stdday" />}
          </colgroup>
          <thead>
            <tr>
              <th className="t-left">Operation</th>
              <th className="t-left">Operator</th>
              <th>StdHr</th>
              <th>Prior</th>
              {columns.map((c) => (
                <th key={c.hour_start_utc}>{c.label}</th>
              ))}
              <th>Shift</th>
              {show_std_day && <th>StdDay</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <OutputRow key={rowKey(row)} row={row} columns={columns} showStdDay={show_std_day} />
            ))}
          </tbody>
        </table>
        {cut && <MoreRows rows={rows.slice(-cut.hidden)} top={cut.top} />}
      </div>

      <div className="tv-bottom">
        {showGauge && (
          <div className="tv-bottom-left">
            <TvGauge progress={job.progress} />
          </div>
        )}
        <div className="tv-bottom-mid">
          {defect_rows.length > 0 && <DefectTable rows={defect_rows} columns={columns} />}
        </div>
        <div className="tv-bottom-right">
          <TvClock tz={tz} updatedAt={updatedAt} />
        </div>
      </div>
    </div>
  );
}

/**
 * Keeps every output row on screen (`fitRows`). Measured after every render, so a new banner or a
 * longer defect table is fitted before it is painted, and again when the screen is resized. The
 * embedded (compact) dashboard grows with its rows instead.
 */
function useRowFit(enabled: boolean) {
  const boxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [cut, setCut] = useState<RowsCut | null>(null);

  useBrowserLayoutEffect(() => {
    const box = boxRef.current;
    const table = tableRef.current;
    if (!box || !table) return;
    if (!enabled) {
      box.style.removeProperty('--tv-fit');
      setCut(null);
      return;
    }
    const fit = () => {
      const next = fitRows(box, table);
      setCut((prev) => (prev?.hidden === next?.hidden && prev?.top === next?.top ? prev : next));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });

  return { boxRef, tableRef, cut };
}

function rowKey(row: TvRow): string {
  return `${row.operation_seq}|${row.operation}|${row.operator_id ?? '*'}`;
}

/** Covers the rows that do not fit even at the smallest size, and names their operations. */
function MoreRows({ rows, top }: { rows: TvRow[]; top: number }) {
  const operations = [...new Set(rows.map((r) => r.operation))];
  return (
    <div className="tv-more" style={{ top }}>
      +{rows.length} more {rows.length === 1 ? 'row' : 'rows'}: {operations.join(', ')}
    </div>
  );
}

function TvHeader({ job }: { job: TvDashboardData['job'] }) {
  return (
    <header className="tv-header">
      <div className="tv-head-job">{job.job_number}</div>
      <div className="tv-head-product">{job.product_number}</div>
      <div className="tv-head-name">{job.product_name ?? ''}</div>
      <div className="tv-head-qtys">
        <div className="tv-qty">
          <div className="tv-qty-value">{job.qty_complete}</div>
          <div className="tv-qty-label">Qty Complete</div>
        </div>
        <div className="tv-qty">
          <div className="tv-qty-value">{job.qty_released}</div>
          <div className="tv-qty-label">Qty Rel.</div>
        </div>
      </div>
    </header>
  );
}

function OutputRow({ row, columns, showStdDay }: { row: TvRow; columns: WindowColumn[]; showStdDay: boolean }) {
  // Cells arrive in column order; index defensively in case a column is missing.
  const byHour = new Map<number, TvCell>(row.cells.map((c) => [c.hour_start_utc, c]));
  return (
    <tr className={row.visitor_row ? 'tv-row tv-row-visitor' : 'tv-row'}>
      <td className="t-left tv-op">{row.operation}</td>
      {/* FactoryLogix user name (e.g. "NSessions"); grouped rows say "Multiple Operators" when several worked the step */}
      <td className={row.operators.length > 1 ? 't-left tv-operator tv-operator-multi' : 't-left tv-operator'}>
        {rowOperatorLabel(row)}
      </td>
      <td className="tv-num">{formatStd(row.std_hr)}</td>
      <td className="tv-num">{row.prior}</td>
      {columns.map((col, i) => {
        const cell = byHour.get(col.hour_start_utc) ?? row.cells[i];
        return <HourCell key={col.hour_start_utc} cell={cell} />;
      })}
      <td className="tv-num tv-shift">{row.shift}</td>
      {showStdDay && <td className="tv-num">{formatStd(row.std_day)}</td>}
    </tr>
  );
}

function HourCell({ cell }: { cell: TvCell | undefined }) {
  if (!cell) return <td className="tv-cell tv-c-blank" />;
  const classes = ['tv-cell', cellClass(cell.color)];
  if (cell.provisional) classes.push('tv-provisional');
  return (
    <td className={classes.join(' ')}>
      {/* The number is always shown; color is never the only signal (spec 14). */}
      {cellText(cell.color, cell.units)}
      {cell.visitor && cell.color !== 'blank' && (
        <span className="tv-visitor-mark" title="Visitor">
          V
        </span>
      )}
    </td>
  );
}

/** A defect row is shown only when the step actually has defects (before or inside the window). */
function hasDefects(row: TvDefectRow): boolean {
  return row.prior > 0 || row.shift_qty > 0 || row.cells.some((c) => c > 0);
}

function DefectTable({ rows: allRows, columns }: { rows: TvDefectRow[]; columns: WindowColumn[] }) {
  const rows = allRows.filter(hasDefects);
  return (
    <table className="tv-table tv-defect-table">
      <colgroup>
        <col className="c-op" />
        <col className="c-prior" />
        {columns.map((c) => (
          <col key={c.hour_start_utc} className="c-hour" />
        ))}
        <col className="c-shift" />
      </colgroup>
      <thead>
        <tr>
          <th className="t-left">Operation</th>
          <th>Prior</th>
          {columns.map((c) => (
            <th key={c.hour_start_utc}>{c.label}</th>
          ))}
          <th>ShiftQty</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr className="tv-row">
            <td className="t-left tv-op tv-defect-empty" colSpan={columns.length + 3}>
              No defects
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr key={`${row.operation_seq}|${row.operation}`} className="tv-row">
            <td className="t-left tv-op">{row.operation}</td>
            <DefectCell value={row.prior} />
            {columns.map((col, i) => (
              <DefectCell key={col.hour_start_utc} value={row.cells[i] ?? 0} />
            ))}
            <DefectCell value={row.shift_qty} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Non-zero defect counts are red-filled with white text; zeros stay plain (spec 7.9). */
function DefectCell({ value }: { value: number }) {
  return <td className={value > 0 ? 'tv-cell tv-c-red' : 'tv-cell'}>{value}</td>;
}
