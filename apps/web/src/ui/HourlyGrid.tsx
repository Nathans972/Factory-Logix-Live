/**
 * Light-theme hourly output grid (docs/design/job-detail.html).
 *
 * It renders the same `TvDashboard` DTO as the floor TV but with portal tokens: one `HourCellBox`
 * per hour, the current (provisional) hour outlined. The TV component in `pages/tv` keeps its dark
 * legacy look; the only things shared with it are the pure `rowOperatorLabel` / `formatStd` rules.
 */
import type { TvCell, TvDashboard } from '@fld/shared';
import { HourCellBox } from './components';
import { formatInt, formatTime24 } from '../lib/format';
import { formatStd, rowOperatorLabel } from '../pages/tv/tvLogic';

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
              <td className="n">{formatStd(r.std_hr)}</td>
              <td className="n">{formatInt(r.prior)}</td>
              {r.cells.map((cell) => (
                <td className="c" key={cell.hour_start_utc}>
                  <HourCellBox units={cell.units} color={cell.color} current={cell.provisional} title={hourCellTitle(cell, tz)} />
                </td>
              ))}
              <td className="n">{formatInt(r.shift)}</td>
              {dashboard.show_std_day && <td className="n">{formatStd(r.std_day)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
