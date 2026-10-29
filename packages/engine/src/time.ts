/**
 * Time-zone and calendar helpers (spec section 5).
 *
 * Pure: no Date.now(), no I/O. All time-zone math goes through Intl.DateTimeFormat; formatters and
 * resolved offsets are cached so hot paths (200k+ steps) never pay the formatting cost twice.
 */
import type {
  BreakDef,
  BreakInterval,
  LocalDate,
  LocalTime,
  ShiftDef,
  ShiftInstance,
  UtcMs,
  WindowColumn,
} from '@fld/shared';
import type { LocalParts, LocalPartsInput } from './index.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const LOOKBACK_SHIFT_DAYS = 14;

// ---------------------------------------------------------------------------
// Formatter / offset caches
// ---------------------------------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

function utcFromParts(y: number, m: number, d: number, h: number, mi: number, s: number): number {
  const t = Date.UTC(y, m - 1, d, h, mi, s);
  if (y >= 0 && y < 100) {
    const dd = new Date(t);
    dd.setUTCFullYear(y);
    return dd.getTime();
  }
  return t;
}

/** Uncached offset lookup: one Intl format call. */
function rawOffsetMs(tz: string, utcMs: UtcMs): number {
  const parts = getFormatter(tz).formatToParts(new Date(utcMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    switch (p.type) {
      case 'year':
        year = Number(p.value);
        break;
      case 'month':
        month = Number(p.value);
        break;
      case 'day':
        day = Number(p.value);
        break;
      case 'hour':
        hour = Number(p.value);
        break;
      case 'minute':
        minute = Number(p.value);
        break;
      case 'second':
        second = Number(p.value);
        break;
      default:
        break;
    }
  }
  if (hour === 24) hour = 0;
  const asUtc = utcFromParts(year, month, day, hour, minute, second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Offsets are cached per UTC hour bucket. A bucket that contains a DST transition is marked
 * "variable" (NaN) and falls back to an exact lookup, so the cache never lies.
 */
const offsetCache = new Map<string, Map<number, number>>();
const CACHE_LIMIT = 400_000;

export function getTzOffsetMs(tz: string, utcMs: UtcMs): number {
  const bucket = Math.floor(utcMs / HOUR_MS);
  let m = offsetCache.get(tz);
  if (m === undefined) {
    m = new Map<number, number>();
    offsetCache.set(tz, m);
  } else {
    const hit = m.get(bucket);
    if (hit !== undefined) return Number.isNaN(hit) ? rawOffsetMs(tz, utcMs) : hit;
  }
  const lo = bucket * HOUR_MS;
  const a = rawOffsetMs(tz, lo);
  const b = rawOffsetMs(tz, lo + HOUR_MS - 1);
  if (m.size >= CACHE_LIMIT) m.clear();
  if (a === b) {
    m.set(bucket, a);
    return a;
  }
  m.set(bucket, Number.NaN);
  return rawOffsetMs(tz, utcMs);
}

// ---------------------------------------------------------------------------
// Local parts
// ---------------------------------------------------------------------------

export function utcToLocalParts(utcMs: UtcMs, tz: string): LocalParts {
  const d = new Date(utcMs + getTzOffsetMs(tz, utcMs));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

function partsMatch(a: LocalParts, b: LocalPartsInput): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === (b.minute ?? 0) &&
    a.second === (b.second ?? 0)
  );
}

export function localToUtc(
  tz: string,
  parts: LocalPartsInput,
  opts?: { ambiguous?: 'earlier' | 'later' },
): UtcMs {
  const target = utcFromParts(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  let guess = target - getTzOffsetMs(tz, target);
  guess = target - getTzOffsetMs(tz, guess);

  if (!partsMatch(utcToLocalParts(guess, tz), parts)) {
    // Non-existent local time (spring forward): shift forward by the size of the gap.
    const usedOffset = target - guess;
    const gap = usedOffset - getTzOffsetMs(tz, guess);
    return guess + gap;
  }

  const prefer = opts?.ambiguous ?? 'earlier';
  const later = guess + HOUR_MS;
  if (partsMatch(utcToLocalParts(later, tz), parts)) {
    return prefer === 'later' ? later : guess;
  }
  const earlier = guess - HOUR_MS;
  if (partsMatch(utcToLocalParts(earlier, tz), parts)) {
    return prefer === 'later' ? guess : earlier;
  }
  return guess;
}

// ---------------------------------------------------------------------------
// Hour buckets and labels
// ---------------------------------------------------------------------------

export function hourStartUtc(utcMs: UtcMs, tz: string): UtcMs {
  const local = utcMs + getTzOffsetMs(tz, utcMs);
  const rem = ((local % HOUR_MS) + HOUR_MS) % HOUR_MS;
  return utcMs - rem;
}

/** The start of the hour bucket following `hourStart` (handles whole- and part-hour DST shifts). */
export function nextHourStartUtc(hourStart: UtcMs, tz: string): UtcMs {
  const n = hourStartUtc(hourStart + HOUR_MS, tz);
  return n > hourStart ? n : hourStart + HOUR_MS;
}

/** The start of the hour bucket preceding `hourStart`. */
export function prevHourStartUtc(hourStart: UtcMs, tz: string): UtcMs {
  return hourStartUtc(hourStart - 1, tz);
}

/** Index of the first of the ascending hour starts `hours` at or after `t` (`hours.length` if none is). */
export function firstHourAtOrAfter(hours: UtcMs[], t: UtcMs): number {
  let lo = 0;
  let hi = hours.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hours[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function hourLabel(hourStartUtcMs: UtcMs, tz: string): string {
  return pad2(utcToLocalParts(hourStartUtcMs, tz).hour);
}

export function localDateString(utcMs: UtcMs, tz: string): LocalDate {
  const p = utcToLocalParts(utcMs, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function parseDateString(date: LocalDate): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

export function addDays(date: LocalDate, n: number): LocalDate {
  const { year, month, day } = parseDateString(date);
  const d = new Date(utcFromParts(year, month, day, 0, 0, 0) + n * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function dayOfWeek(date: LocalDate): number {
  const { year, month, day } = parseDateString(date);
  return new Date(utcFromParts(year, month, day, 0, 0, 0)).getUTCDay();
}

export function parseLocalTime(t: LocalTime): number {
  const colon = t.indexOf(':');
  if (colon < 0) return Number(t) * 60;
  return Number(t.slice(0, colon)) * 60 + Number(t.slice(colon + 1));
}

function localDateTimeToUtc(date: LocalDate, minutesOfDay: number, tz: string): UtcMs {
  const { year, month, day } = parseDateString(date);
  return localToUtc(tz, {
    year,
    month,
    day,
    hour: Math.floor(minutesOfDay / 60),
    minute: minutesOfDay % 60,
  });
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export function expandShiftInstance(shift: ShiftDef, date: LocalDate, tz: string): ShiftInstance {
  const startMin = parseLocalTime(shift.start_local);
  const endMin = parseLocalTime(shift.end_local);
  const start_utc = localDateTimeToUtc(date, startMin, tz);
  let end_utc = localDateTimeToUtc(date, endMin, tz);
  if (end_utc <= start_utc) {
    end_utc = localDateTimeToUtc(addDays(date, 1), endMin, tz);
  }
  return { shift_id: shift.id, name: shift.name, date, start_utc, end_utc };
}

function appliesOn(
  def: { days_of_week: number[]; effective_from: LocalDate; effective_to: LocalDate | null },
  date: LocalDate,
): boolean {
  if (date < def.effective_from) return false;
  if (def.effective_to !== null && date > def.effective_to) return false;
  return def.days_of_week.includes(dayOfWeek(date));
}

/**
 * The version of `shift` in effect on `date` (spec 10.2: past shifts are evaluated against the
 * definition in effect that day). A versioned edit gives the new version a new id, so another
 * version's id resolves to the same-named one whose effective range covers `date`; null if none does.
 */
export function resolveShiftVersion(shifts: ShiftDef[], shift: ShiftDef, date: LocalDate): ShiftDef | null {
  const inEffect = (s: ShiftDef) => date >= s.effective_from && (s.effective_to === null || date <= s.effective_to);
  if (inEffect(shift)) return shift;
  const versions = shifts.filter((s) => s.name === shift.name && inEffect(s));
  return versions.find((s) => s.days_of_week.includes(dayOfWeek(date))) ?? versions[0] ?? null;
}

function localDateRange(fromUtc: UtcMs, toUtc: UtcMs, tz: string): LocalDate[] {
  const first = addDays(localDateString(fromUtc, tz), -1);
  const last = localDateString(Math.max(toUtc, fromUtc), tz);
  const out: LocalDate[] = [];
  let d = first;
  // Guard against pathological ranges; callers use windows of days, not centuries.
  for (let i = 0; i < 4000; i++) {
    out.push(d);
    if (d >= last) break;
    d = addDays(d, 1);
  }
  return out;
}

export function listShiftInstances(
  shifts: ShiftDef[],
  fromUtc: UtcMs,
  toUtc: UtcMs,
  tz: string,
): ShiftInstance[] {
  const out: ShiftInstance[] = [];
  const seen = new Set<string>();
  for (const date of localDateRange(fromUtc, toUtc, tz)) {
    for (const shift of shifts) {
      if (!appliesOn(shift, date)) continue;
      const key = `${shift.id}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inst = expandShiftInstance(shift, date, tz);
      if (inst.start_utc < toUtc && inst.end_utc > fromUtc) out.push(inst);
    }
  }
  out.sort((a, b) => a.start_utc - b.start_utc || a.shift_id - b.shift_id);
  return out;
}

export function findCurrentShift(shifts: ShiftDef[], now: UtcMs, tz: string): ShiftInstance | null {
  const candidates = listShiftInstances(shifts, now, now + 1, tz).filter(
    (s) => s.start_utc <= now && now < s.end_utc,
  );
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (const c of candidates) {
    if (
      c.start_utc > best.start_utc ||
      (c.start_utc === best.start_utc && c.shift_id > best.shift_id)
    ) {
      best = c;
    }
  }
  return best;
}

export function findCurrentOrMostRecentShift(
  shifts: ShiftDef[],
  now: UtcMs,
  tz: string,
): ShiftInstance | null {
  const current = findCurrentShift(shifts, now, tz);
  if (current !== null) return current;
  const past = listShiftInstances(shifts, now - LOOKBACK_SHIFT_DAYS * DAY_MS, now, tz).filter(
    (s) => s.end_utc <= now,
  );
  if (past.length === 0) return null;
  let best = past[0]!;
  for (const c of past) {
    if (c.end_utc > best.end_utc || (c.end_utc === best.end_utc && c.start_utc > best.start_utc)) {
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------

export function expandBreaks(
  breaks: BreakDef[],
  shifts: ShiftDef[],
  fromUtc: UtcMs,
  toUtc: UtcMs,
  tz: string,
): BreakInterval[] {
  if (breaks.length === 0) return [];
  const dates = localDateRange(fromUtc, toUtc, tz);

  const needsShifts = breaks.some((b) => b.shift_ids !== null && b.shift_ids !== undefined);
  const instancesByShift = new Map<number, ShiftInstance[]>();
  if (needsShifts) {
    for (const date of dates) {
      for (const shift of shifts) {
        if (!appliesOn(shift, date)) continue;
        const inst = expandShiftInstance(shift, date, tz);
        let list = instancesByShift.get(shift.id);
        if (list === undefined) {
          list = [];
          instancesByShift.set(shift.id, list);
        }
        list.push(inst);
      }
    }
  }

  const out: BreakInterval[] = [];
  const seen = new Set<string>();
  for (const date of dates) {
    for (const def of breaks) {
      if (!appliesOn(def, date)) continue;
      const key = `${def.id}|${date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start_utc = localDateTimeToUtc(date, parseLocalTime(def.start_local), tz);
      const end_utc = start_utc + def.duration_minutes * MINUTE_MS;
      if (def.shift_ids !== null && def.shift_ids !== undefined) {
        let covered = false;
        for (const sid of def.shift_ids) {
          const list = instancesByShift.get(sid);
          if (list === undefined) continue;
          for (const inst of list) {
            if (inst.start_utc <= start_utc && start_utc < inst.end_utc) {
              covered = true;
              break;
            }
          }
          if (covered) break;
        }
        if (!covered) continue;
      }
      if (start_utc < toUtc && end_utc > fromUtc) {
        out.push({ break_id: def.id, name: def.name, start_utc, end_utc });
      }
    }
  }
  out.sort((a, b) => a.start_utc - b.start_utc || a.end_utc - b.end_utc || a.break_id - b.break_id);
  return out;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export function rollingWindowColumns(now: UtcMs, tz: string, hours = 12): WindowColumn[] {
  const h0 = hourStartUtc(now, tz);
  const out: WindowColumn[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const h = h0 - i * HOUR_MS;
    out.push({ hour_start_utc: h, label: hourLabel(h, tz) });
  }
  return out;
}

export function hourColumns(fromUtc: UtcMs, toUtc: UtcMs, tz: string): WindowColumn[] {
  const out: WindowColumn[] = [];
  let h = hourStartUtc(fromUtc, tz);
  while (h < toUtc) {
    out.push({ hour_start_utc: h, label: hourLabel(h, tz) });
    h += HOUR_MS;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function nextLocalTime(tz: string, time: LocalTime, afterUtc: UtcMs): UtcMs {
  const minutes = parseLocalTime(time);
  let date = localDateString(afterUtc, tz);
  let candidate = localDateTimeToUtc(date, minutes, tz);
  for (let i = 0; i < 4; i++) {
    if (candidate > afterUtc) return candidate;
    date = addDays(date, 1);
    candidate = localDateTimeToUtc(date, minutes, tz);
  }
  return candidate;
}

export function inLocalWindow(tz: string, utcMs: UtcMs, start: LocalTime, end: LocalTime): boolean {
  const p = utcToLocalParts(utcMs, tz);
  const mins = p.hour * 60 + p.minute;
  const s = parseLocalTime(start);
  const e = parseLocalTime(end);
  if (e > s) return mins >= s && mins < e;
  return mins >= s || mins < e;
}

/** Sorted, non-overlapping union of the given intervals. */
export function mergeIntervals(
  intervals: { start_utc: UtcMs; end_utc: UtcMs }[],
): { start_utc: UtcMs; end_utc: UtcMs }[] {
  if (intervals.length === 0) return [];
  const sorted = intervals
    .filter((iv) => iv.end_utc > iv.start_utc)
    .slice()
    .sort((a, b) => a.start_utc - b.start_utc || a.end_utc - b.end_utc);
  const out: { start_utc: UtcMs; end_utc: UtcMs }[] = [];
  for (const iv of sorted) {
    const last = out.length > 0 ? out[out.length - 1]! : null;
    if (last !== null && iv.start_utc <= last.end_utc) {
      if (iv.end_utc > last.end_utc) last.end_utc = iv.end_utc;
    } else {
      out.push({ start_utc: iv.start_utc, end_utc: iv.end_utc });
    }
  }
  return out;
}

export function overlapWithIntervals(
  aStart: UtcMs,
  aEnd: UtcMs,
  intervals: { start_utc: UtcMs; end_utc: UtcMs }[],
): number {
  if (aEnd <= aStart || intervals.length === 0) return 0;
  return overlapWithMerged(aStart, aEnd, mergeIntervals(intervals));
}

/** Same as overlapWithIntervals but for an already-merged, sorted list (hot path). */
export function overlapWithMerged(
  aStart: UtcMs,
  aEnd: UtcMs,
  merged: { start_utc: UtcMs; end_utc: UtcMs }[],
): number {
  if (aEnd <= aStart) return 0;
  let total = 0;
  for (let i = 0; i < merged.length; i++) {
    const iv = merged[i]!;
    if (iv.start_utc >= aEnd) break;
    if (iv.end_utc <= aStart) continue;
    total += Math.min(aEnd, iv.end_utc) - Math.max(aStart, iv.start_utc);
  }
  return total;
}
