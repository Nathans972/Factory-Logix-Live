import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  expandBreaks,
  expandShiftInstance,
  findCurrentOrMostRecentShift,
  findCurrentShift,
  getTzOffsetMs,
  hourColumns,
  hourLabel,
  hourStartUtc,
  inLocalWindow,
  listShiftInstances,
  localDateString,
  localToUtc,
  nextLocalTime,
  overlapWithIntervals,
  parseLocalTime,
  rollingWindowColumns,
  utcToLocalParts,
} from '../src/time.js';
import { HOUR, KOLKATA, TZ, breakDef, ms, shiftDef } from './helpers.js';

describe('offsets and local parts', () => {
  it('reports the plant offset either side of the DST transitions', () => {
    expect(getTzOffsetMs(TZ, ms('2025-01-15T12:00:00Z'))).toBe(-5 * HOUR);
    expect(getTzOffsetMs(TZ, ms('2025-06-15T12:00:00Z'))).toBe(-4 * HOUR);
    expect(getTzOffsetMs(KOLKATA, ms('2025-06-15T12:00:00Z'))).toBe(5.5 * HOUR);
  });

  it('converts an instant to local wall-clock parts', () => {
    expect(utcToLocalParts(ms('2025-06-10T19:47:23Z'), TZ)).toEqual({
      year: 2025,
      month: 6,
      day: 10,
      hour: 15,
      minute: 47,
      second: 23,
      weekday: 2,
    });
  });

  it('is exact inside the hour that contains a transition', () => {
    // 2025-11-02: 06:00Z is the fall-back instant (02:00 EDT -> 01:00 EST).
    expect(getTzOffsetMs(TZ, ms('2025-11-02T05:59:59Z'))).toBe(-4 * HOUR);
    expect(getTzOffsetMs(TZ, ms('2025-11-02T06:00:00Z'))).toBe(-5 * HOUR);
    expect(getTzOffsetMs(TZ, ms('2025-03-09T06:59:59Z'))).toBe(-5 * HOUR);
    expect(getTzOffsetMs(TZ, ms('2025-03-09T07:00:00Z'))).toBe(-4 * HOUR);
  });
});

describe('hourStartUtc / hourLabel', () => {
  it('truncates the local clock hour', () => {
    expect(hourStartUtc(ms('2025-06-10T15:47:23.456-04:00'), TZ)).toBe(ms('2025-06-10T15:00-04:00'));
    expect(hourLabel(ms('2025-06-10T15:00-04:00'), TZ)).toBe('15');
    expect(hourLabel(ms('2025-06-10T09:00-04:00'), TZ)).toBe('09');
  });

  it('works in a half-hour time zone', () => {
    // 10:17:23.456Z is 15:47:23.456 in Kolkata; the local hour starts at 09:30Z.
    const t = ms('2025-06-10T10:17:23.456Z');
    expect(hourStartUtc(t, KOLKATA)).toBe(ms('2025-06-10T09:30:00Z'));
    expect(hourLabel(hourStartUtc(t, KOLKATA), KOLKATA)).toBe('15');
    expect(hourStartUtc(ms('2025-06-10T09:30:00Z'), KOLKATA)).toBe(ms('2025-06-10T09:30:00Z'));
  });

  it('keeps the two fall-back 01:00 hours distinct', () => {
    const edt = hourStartUtc(ms('2025-11-02T05:30:00Z'), TZ);
    const est = hourStartUtc(ms('2025-11-02T06:30:00Z'), TZ);
    expect(edt).toBe(ms('2025-11-02T05:00:00Z'));
    expect(est).toBe(ms('2025-11-02T06:00:00Z'));
    expect(est - edt).toBe(HOUR);
    expect(hourLabel(edt, TZ)).toBe('01');
    expect(hourLabel(est, TZ)).toBe('01');
  });
});

describe('localToUtc', () => {
  it('round-trips a normal local time', () => {
    expect(localToUtc(TZ, { year: 2025, month: 6, day: 10, hour: 15, minute: 20 })).toBe(
      ms('2025-06-10T15:20-04:00'),
    );
    expect(localToUtc(KOLKATA, { year: 2025, month: 6, day: 10, hour: 15, minute: 0 })).toBe(
      ms('2025-06-10T09:30:00Z'),
    );
  });

  it('shifts non-existent spring-forward times forward by the gap', () => {
    // 2025-03-09 02:30 does not exist in New York; it becomes 03:30 EDT.
    const t = localToUtc(TZ, { year: 2025, month: 3, day: 9, hour: 2, minute: 30 });
    expect(t).toBe(ms('2025-03-09T07:30:00Z'));
    expect(utcToLocalParts(t, TZ).hour).toBe(3);
    expect(utcToLocalParts(t, TZ).minute).toBe(30);
  });

  it('resolves ambiguous fall-back times per opts.ambiguous (default earlier)', () => {
    const parts = { year: 2025, month: 11, day: 2, hour: 1, minute: 30 };
    expect(localToUtc(TZ, parts)).toBe(ms('2025-11-02T05:30:00Z'));
    expect(localToUtc(TZ, parts, { ambiguous: 'earlier' })).toBe(ms('2025-11-02T05:30:00Z'));
    expect(localToUtc(TZ, parts, { ambiguous: 'later' })).toBe(ms('2025-11-02T06:30:00Z'));
  });
});

describe('calendar helpers', () => {
  it('formats and shifts local dates', () => {
    expect(localDateString(ms('2025-06-11T03:00:00Z'), TZ)).toBe('2025-06-10');
    expect(addDays('2025-06-30', 1)).toBe('2025-07-01');
    expect(addDays('2025-03-01', -1)).toBe('2025-02-28');
    expect(addDays('2025-11-01', 1)).toBe('2025-11-02');
    expect(dayOfWeek('2025-06-10')).toBe(2); // Tuesday
    expect(dayOfWeek('2025-06-08')).toBe(0); // Sunday
    expect(parseLocalTime('07:30')).toBe(450);
    expect(parseLocalTime('00:00')).toBe(0);
  });
});

describe('shifts', () => {
  const day = shiftDef({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' });
  const night = shiftDef({ id: 2, name: 'Night', start_local: '19:00', end_local: '07:00' });

  it('expands a shift that crosses midnight', () => {
    const inst = expandShiftInstance(night, '2025-06-10', TZ);
    expect(inst.start_utc).toBe(ms('2025-06-10T19:00-04:00'));
    expect(inst.end_utc).toBe(ms('2025-06-11T07:00-04:00'));
    expect(inst.end_utc - inst.start_utc).toBe(12 * HOUR);
    expect(inst.shift_id).toBe(2);
    expect(inst.date).toBe('2025-06-10');
  });

  it('expands a 13-hour night across the fall-back transition', () => {
    const inst = expandShiftInstance(night, '2025-11-01', TZ);
    expect(inst.start_utc).toBe(ms('2025-11-01T23:00:00Z'));
    expect(inst.end_utc).toBe(ms('2025-11-02T12:00:00Z'));
    expect(inst.end_utc - inst.start_utc).toBe(13 * HOUR);
  });

  it('lists overlapping instances sorted by start, honouring days_of_week', () => {
    const weekdayDay = shiftDef({
      id: 3,
      name: 'WeekdayDay',
      start_local: '07:00',
      end_local: '19:00',
      days_of_week: [1, 2, 3, 4, 5],
    });
    const from = ms('2025-06-07T00:00-04:00'); // Saturday
    const to = ms('2025-06-10T00:00-04:00');
    const list = listShiftInstances([weekdayDay, night], from, to, TZ);
    const weekdayDates = list.filter((s) => s.shift_id === 3).map((s) => s.date);
    expect(weekdayDates).toEqual(['2025-06-09']); // Sat/Sun excluded
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.start_utc).toBeGreaterThanOrEqual(list[i - 1]!.start_utc);
    }
  });

  it('honours the effective range', () => {
    const bounded = shiftDef({
      id: 4,
      name: 'Bounded',
      effective_from: '2025-06-09',
      effective_to: '2025-06-09',
    });
    const list = listShiftInstances(
      [bounded],
      ms('2025-06-08T00:00-04:00'),
      ms('2025-06-12T00:00-04:00'),
      TZ,
    );
    expect(list.map((s) => s.date)).toEqual(['2025-06-09']);
  });

  it('finds the current shift across midnight', () => {
    const now = ms('2025-06-11T02:00-04:00');
    const current = findCurrentShift([day, night], now, TZ);
    expect(current).not.toBeNull();
    expect(current!.shift_id).toBe(2);
    expect(current!.date).toBe('2025-06-10');
    expect(current!.start_utc).toBeLessThanOrEqual(now);
    expect(current!.end_utc).toBeGreaterThan(now);
  });

  it('returns null when nothing is in progress and falls back to the most recent', () => {
    const now = ms('2025-06-11T08:00-04:00');
    expect(findCurrentShift([night], now, TZ)).toBeNull();
    const recent = findCurrentOrMostRecentShift([night], now, TZ);
    expect(recent).not.toBeNull();
    expect(recent!.date).toBe('2025-06-10');
    expect(recent!.end_utc).toBe(ms('2025-06-11T07:00-04:00'));
  });

  it('prefers the shift in progress over the most recent one', () => {
    const now = ms('2025-06-10T12:00-04:00');
    const r = findCurrentOrMostRecentShift([day, night], now, TZ);
    expect(r!.shift_id).toBe(1);
  });
});

describe('expandBreaks', () => {
  const day = shiftDef({ id: 1, name: 'Day', start_local: '07:00', end_local: '19:00' });
  const night = shiftDef({ id: 2, name: 'Night', start_local: '19:00', end_local: '07:00' });
  const from = ms('2025-06-10T00:00-04:00');
  const to = ms('2025-06-11T00:00-04:00');

  it('expands to concrete UTC intervals', () => {
    const b = breakDef({ id: 1, name: 'Morning', start_local: '10:00', duration_minutes: 15 });
    const out = expandBreaks([b], [day], from, to, TZ);
    expect(out).toHaveLength(1);
    expect(out[0]!.start_utc).toBe(ms('2025-06-10T10:00-04:00'));
    expect(out[0]!.end_utc).toBe(ms('2025-06-10T10:15-04:00'));
    expect(out[0]!.break_id).toBe(1);
  });

  it('filters by shift_ids using the shift in progress at the break start', () => {
    const dayBreak = breakDef({ id: 10, name: 'DayBreak', start_local: '10:00', shift_ids: [1] });
    const nightOnlyAt10 = breakDef({ id: 11, name: 'NightBreak?', start_local: '10:00', shift_ids: [2] });
    const nightBreak = breakDef({
      id: 12,
      name: 'NightBreak',
      start_local: '23:00',
      duration_minutes: 30,
      shift_ids: [2],
    });
    const allShifts = breakDef({ id: 13, name: 'AllShifts', start_local: '10:00', shift_ids: null });

    const out = expandBreaks([dayBreak, nightOnlyAt10, nightBreak, allShifts], [day, night], from, to, TZ);
    expect(out.map((b) => b.break_id).sort((a, b) => a - b)).toEqual([10, 12, 13]);
  });

  it('filters by days_of_week', () => {
    const weekdayBreak = breakDef({ id: 20, name: 'Weekday', days_of_week: [1, 2, 3, 4, 5] });
    const saturday = expandBreaks(
      [weekdayBreak],
      [day],
      ms('2025-06-07T00:00-04:00'),
      ms('2025-06-08T00:00-04:00'),
      TZ,
    );
    expect(saturday).toHaveLength(0);
  });

  it('does not merge overlapping break definitions', () => {
    const a = breakDef({ id: 30, name: 'A', start_local: '10:00', duration_minutes: 20 });
    const b = breakDef({ id: 31, name: 'B', start_local: '10:10', duration_minutes: 20 });
    const out = expandBreaks([a, b], [day], from, to, TZ);
    expect(out).toHaveLength(2);
    expect(out[0]!.break_id).toBe(30);
  });
});

describe('columns', () => {
  it('rolls the 12-hour window at the top of the hour', () => {
    const before = rollingWindowColumns(ms('2025-06-10T21:59-04:00'), TZ);
    const after = rollingWindowColumns(ms('2025-06-10T22:00-04:00'), TZ);
    expect(before.map((c) => c.label)).toEqual([
      '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21',
    ]);
    expect(after.map((c) => c.label)).toEqual([
      '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22',
    ]);
    expect(after[0]!.hour_start_utc).toBe(before[1]!.hour_start_utc);
  });

  it('stays 12 consecutive UTC hours across the fall-back night, with a duplicated label', () => {
    const cols = rollingWindowColumns(ms('2025-11-02T07:30:00Z'), TZ);
    expect(cols).toHaveLength(12);
    expect(cols.map((c) => c.label)).toEqual([
      '16', '17', '18', '19', '20', '21', '22', '23', '00', '01', '01', '02',
    ]);
    for (let i = 1; i < cols.length; i++) {
      expect(cols[i]!.hour_start_utc - cols[i - 1]!.hour_start_utc).toBe(HOUR);
    }
    const labels = cols.map((c) => c.label);
    expect(labels.filter((l) => l === '01')).toHaveLength(2);
  });

  it('covers [from,to) with hourColumns, 13 columns on the fall-back night shift', () => {
    const cols = hourColumns(ms('2025-11-01T23:00:00Z'), ms('2025-11-02T12:00:00Z'), TZ);
    expect(cols).toHaveLength(13);
    expect(cols[0]!.label).toBe('19');
    expect(cols.at(-1)!.label).toBe('06');
    expect(cols.filter((c) => c.label === '01')).toHaveLength(2);
  });

  it('supports a custom column count', () => {
    expect(rollingWindowColumns(ms('2025-06-10T12:30-04:00'), TZ, 3).map((c) => c.label)).toEqual([
      '10', '11', '12',
    ]);
  });
});

describe('misc time helpers', () => {
  it('finds the next local time strictly after an instant', () => {
    expect(nextLocalTime(TZ, '02:00', ms('2025-06-10T01:00-04:00'))).toBe(
      ms('2025-06-10T02:00-04:00'),
    );
    expect(nextLocalTime(TZ, '02:00', ms('2025-06-10T02:00-04:00'))).toBe(
      ms('2025-06-11T02:00-04:00'),
    );
    // 02:30 does not exist on 2025-03-09: it lands on 03:30 EDT.
    expect(nextLocalTime(TZ, '02:30', ms('2025-03-09T00:00-05:00'))).toBe(
      ms('2025-03-09T07:30:00Z'),
    );
  });

  it('evaluates a local window that wraps midnight', () => {
    expect(inLocalWindow(TZ, ms('2025-06-10T23:00-04:00'), '22:00', '05:00')).toBe(true);
    expect(inLocalWindow(TZ, ms('2025-06-10T04:00-04:00'), '22:00', '05:00')).toBe(true);
    expect(inLocalWindow(TZ, ms('2025-06-10T12:00-04:00'), '22:00', '05:00')).toBe(false);
    expect(inLocalWindow(TZ, ms('2025-06-10T10:00-04:00'), '07:00', '19:00')).toBe(true);
    expect(inLocalWindow(TZ, ms('2025-06-10T19:00-04:00'), '07:00', '19:00')).toBe(false);
  });

  it('unions overlapping intervals before measuring overlap', () => {
    const a = ms('2025-06-10T10:00:00Z');
    const intervals = [
      { start_utc: a, end_utc: a + 20 * 60_000 },
      { start_utc: a + 10 * 60_000, end_utc: a + 30 * 60_000 },
    ];
    expect(overlapWithIntervals(a, a + 60 * 60_000, intervals)).toBe(30 * 60_000);
    expect(overlapWithIntervals(a + 40 * 60_000, a + 60 * 60_000, intervals)).toBe(0);
    expect(overlapWithIntervals(a, a, intervals)).toBe(0);
  });
});
