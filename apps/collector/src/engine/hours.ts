/** Hour-bucket bookkeeping for incremental recompute (spec 3.3, 7.7). */

export const HOUR_MS = 3_600_000;

export interface HourRange {
  /** inclusive hour start */
  from: number;
  /** exclusive end (last hour start + 1h) */
  to: number;
}

/** Merge a set of hour starts into contiguous [from, to) ranges of at most `maxHours` hours each. */
export function mergeHourRanges(hourStarts: Iterable<number>, maxHours = Infinity): HourRange[] {
  const unique = [...new Set([...hourStarts].filter((h) => Number.isFinite(h)))].sort((a, b) => a - b);
  const ranges: HourRange[] = [];
  for (const hour of unique) {
    const last = ranges[ranges.length - 1];
    if (last && hour === last.to && last.to - last.from < maxHours * HOUR_MS) {
      last.to = hour + HOUR_MS;
    } else {
      ranges.push({ from: hour, to: hour + HOUR_MS });
    }
  }
  return ranges;
}

export function hoursInRange(range: HourRange): number[] {
  const out: number[] = [];
  for (let h = range.from; h < range.to; h += HOUR_MS) out.push(h);
  return out;
}

export function countHours(ranges: HourRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.round((r.to - r.from) / HOUR_MS), 0);
}
