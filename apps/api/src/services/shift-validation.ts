/**
 * Overlap validation for shift definitions (spec 10.2: "Validation prevents overlapping shifts on the
 * same day"). Shifts are expanded to absolute week-minute intervals so an end past midnight is
 * compared against the following day correctly.
 */
import type { ShiftDef, ShiftWrite } from '@fld/shared';

const WEEK_MINUTES = 7 * 24 * 60;
const DAY_MINUTES = 24 * 60;
const MAX_DATE = '9999-12-31';

export function parseHhMm(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) throw new Error(`invalid local time: ${time}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Length in minutes of [start,end); an end at or before the start means it crosses midnight. */
export function shiftDurationMinutes(start_local: string, end_local: string): number {
  const start = parseHhMm(start_local);
  const end = parseHhMm(end_local);
  const diff = end - start;
  return diff > 0 ? diff : diff + DAY_MINUTES;
}

/** Absolute [start,end) intervals in week-minute space (0 = Sunday 00:00), split on the week wrap. */
export function weekIntervals(shift: Pick<ShiftDef, 'start_local' | 'end_local' | 'days_of_week'>): [number, number][] {
  const startMin = parseHhMm(shift.start_local);
  const duration = shiftDurationMinutes(shift.start_local, shift.end_local);
  const out: [number, number][] = [];
  for (const day of shift.days_of_week ?? []) {
    const normalizedDay = (((day % 7) + 7) % 7);
    const start = normalizedDay * DAY_MINUTES + startMin;
    const end = start + duration;
    if (end <= WEEK_MINUTES) {
      out.push([start, end]);
    } else {
      out.push([start, WEEK_MINUTES]);
      out.push([0, end - WEEK_MINUTES]);
    }
  }
  return out;
}

function intervalsOverlap(a: [number, number][], b: [number, number][]): boolean {
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      if (aStart < bEnd && bStart < aEnd) return true;
    }
  }
  return false;
}

export function effectiveRangesOverlap(
  a: { effective_from: string; effective_to: string | null },
  b: { effective_from: string; effective_to: string | null },
): boolean {
  return a.effective_from <= (b.effective_to ?? MAX_DATE) && b.effective_from <= (a.effective_to ?? MAX_DATE);
}

/** The first existing shift the candidate collides with, or null. */
export function findOverlappingShift(
  candidate: ShiftWrite,
  existing: ShiftDef[],
  ignoreId?: number | null,
): ShiftDef | null {
  const candidateIntervals = weekIntervals(candidate);
  for (const other of existing) {
    if (ignoreId !== null && ignoreId !== undefined && other.id === ignoreId) continue;
    if (!effectiveRangesOverlap(candidate, other)) continue;
    if (intervalsOverlap(candidateIntervals, weekIntervals(other))) return other;
  }
  return null;
}

/** Whether an edit changes when the shift runs (its times or days), not just its name or dates. */
export function changesShiftTimes(before: ShiftWrite, after: ShiftWrite): boolean {
  const days = (s: ShiftWrite) => [...new Set(s.days_of_week)].sort((a, b) => a - b).join(',');
  return before.start_local !== after.start_local || before.end_local !== after.end_local || days(before) !== days(after);
}

/** effective_from minus one day, as 'YYYY-MM-DD' (used when versioning a shift). */
export function previousDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const ms = Date.UTC(y, (m ?? 1) - 1, d ?? 1) - 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
