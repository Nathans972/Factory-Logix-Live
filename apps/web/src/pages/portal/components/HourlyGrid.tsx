/**
 * Light-theme hourly output grid for the portal job page (docs/design/job-detail.html).
 *
 * It renders the same `TvDashboard` DTO as the floor TV but with portal tokens: one `HourCellBox`
 * per hour, the current (provisional) hour outlined. The TV component in `pages/tv` keeps its dark
 * legacy look; the only thing shared with it is the pure `rowOperatorLabel` rule.
 */
import type { CellColor, TvCell, TvDashboard } from '@fld/shared';
import { HourCellBox, type Accent } from '../../../ui';
import { formatTime24 } from '../../../lib/format';
import { rowOperatorLabel } from '../../tv/tvLogic';

/** StdHr / StdDay: whole numbers, like the floor TV, so the two screens never disagree. */
export function stdText(v: number | null | undefined): string {
  return intText(v);
}

/** "Sep 8" — the design never shows a year inside a line of context. */
export function shortDate(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(ms);
}

/** Thousands-separated integer ("1,226") for every numeric the design shows grouped. */
export function intText(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

/** Map a pace/efficiency CellColor onto the KPI tile accent names. */
export function cellAccent(color: CellColor | null | undefined): Accent {
  switch (color) {
    case 'red':
      return 'red';
    case 'yellow':
      return 'amber';
    case 'green':
      return 'green';
    case 'blue':
      return 'blue';
    default:
      return 'none';
  }
}

/** Hover text for one hourly cell: hour, pace, charged minutes and the visitor/in-progress flags. */
export function hourCellTitle(cell: TvCell, tz: string): string {
  const parts = [formatTime24(cell.hour_start_utc, tz)];
  parts.push(cell.pace == null ? 'pace —' : `pace ${Math.round(cell.pace * 100)}%`);
  parts.push(`charged ${Math.round(cell.charged_minutes)} min`);
  if (cell.visitor) parts.push('visitor');
  if (cell.provisional) parts.push('in progress');
  return parts.join(' · ');
}

export function HourlyGrid({ dashboard, tz }: { dashboard: TvDashboard; tz: string }) {
  const cols = dashboard.columns;
  const width = 4 + cols.length + 1 + (dashboard.show_std_day ? 1 : 0);

  return (
    <div className="hgrid">
      <table className="tbl hgrid-table">
        <thead>
          <tr>
            <th>Operation</th>
            <th>Operator</th>
            <th className="n">StdHr</th>
            <th className="n">Prior</th>
            {cols.map((c) => (
              <th className="c" key={c.hour_start_utc}>
                {c.label}
              </th>
            ))}
            <th className="n">Shift</th>
            {dashboard.show_std_day && <th className="n">StdDay</th>}
          </tr>
        </thead>
        <tbody>
          {dashboard.rows.length === 0 && (
            <tr>
              <td className="dt-empty" colSpan={width}>
                No scans in the last 12 hours
              </td>
            </tr>
          )}
          {dashboard.rows.map((r) => (
            <tr key={`${r.operation}|${r.operator_id ?? r.operators.join('+')}`}>
              <td className="hgrid-op">{r.operation}</td>
              <td>{rowOperatorLabel(r)}</td>
              <td className="n">{stdText(r.std_hr)}</td>
              <td className="n">{intText(r.prior)}</td>
              {r.cells.map((cell) => (
                <td className="c" key={cell.hour_start_utc}>
                  <HourCellBox units={cell.units} color={cell.color} current={cell.provisional} title={hourCellTitle(cell, tz)} />
                </td>
              ))}
              <td className="n">{intText(r.shift)}</td>
              {dashboard.show_std_day && <td className="n">{stdText(r.std_day)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
