/** 12-hour cell strip reusing the TV colors (spec 9.4). */
import type { TvCell } from '@fld/shared';
import { formatTime24 } from '../../../lib/format';

export function hourLabel(hourStartUtc: number, tz: string): string {
  return formatTime24(hourStartUtc, tz).slice(0, 2);
}

export function CellStripLabels({ cells, tz }: { cells: TvCell[]; tz: string }) {
  return (
    <div className="strip-labels">
      {cells.map((c) => (
        <span className="lbl" key={c.hour_start_utc}>
          {hourLabel(c.hour_start_utc, tz)}
        </span>
      ))}
    </div>
  );
}

export function CellStrip({ cells, tz }: { cells: TvCell[]; tz: string }) {
  return (
    <div className="cell-strip">
      {cells.map((c) => {
        const parts = [formatTime24(c.hour_start_utc, tz)];
        parts.push(c.pace == null ? 'pace —' : `pace ${Math.round(c.pace * 100)}%`);
        parts.push(`charged ${Math.round(c.charged_minutes)} min`);
        if (c.visitor) parts.push('visitor');
        if (c.provisional) parts.push('in progress');
        return (
          <div className={`cell c-${c.color}`} key={c.hour_start_utc} title={parts.join(' · ')}>
            {c.color === 'blank' ? '' : c.units}
            {c.visitor && <sup>V</sup>}
          </div>
        );
      })}
    </div>
  );
}
