/**
 * 12-hour cell strip for the operator detail page (spec 9.4).
 *
 * Same solid fills as the job page's hourly grid — it renders `HourCellBox` with the hour labels
 * above, so a strip and a grid row read identically.
 */
import type { TvCell } from '@fld/shared';
import { HourCellBox, hourCellTitle } from '../../../ui';
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

/** The strip itself; `labels` (default on) puts the hour row above the cells. */
export function CellStrip({ cells, tz, labels = true }: { cells: TvCell[]; tz: string; labels?: boolean }) {
  return (
    <div className="strip-body">
      {labels && <CellStripLabels cells={cells} tz={tz} />}
      <div className="cell-strip">
        {cells.map((c) => (
          <HourCellBox
            key={c.hour_start_utc}
            units={c.units}
            color={c.color}
            current={c.provisional}
            title={hourCellTitle(c, tz)}
          />
        ))}
      </div>
    </div>
  );
}
