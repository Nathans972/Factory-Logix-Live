import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatDays,
  formatDecimal,
  formatHours,
  formatInt,
  formatIsoDate,
  formatMinutes,
  formatNum,
  formatPct,
  formatStdHr,
  formatTime,
  formatTime24,
  relativeMinutes,
  shortDate,
} from './format';

const CHICAGO = 'America/Chicago';
const NO_VALUE = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY];

describe('wall-clock formatting uses the plant time zone', () => {
  // 2026-03-02 05:30:15 UTC is 23:30:15 on Mar 1 in Chicago (CST, UTC-6).
  const lateEvening = Date.UTC(2026, 2, 2, 5, 30, 15);

  it('formats times in the given zone, not UTC', () => {
    expect(formatTime(lateEvening, CHICAGO)).toBe('11:30 PM');
    expect(formatTime(lateEvening, 'UTC')).toBe('5:30 AM');
    expect(formatTime(lateEvening, CHICAGO, true)).toBe('11:30:15 PM');
    expect(formatTime24(lateEvening, CHICAGO)).toBe('23:30');
  });

  it('puts the date on the plant-local day when UTC has already rolled over', () => {
    expect(formatIsoDate(lateEvening, CHICAGO)).toBe('2026-03-01');
    expect(formatIsoDate(lateEvening, 'UTC')).toBe('2026-03-02');
    expect(formatDate(lateEvening, CHICAGO)).toBe('Mar 1, 2026');
    expect(shortDate(lateEvening, CHICAGO)).toBe('Mar 1');
    expect(formatDateTime(lateEvening, CHICAGO)).toBe('Mar 1, 11:30 PM');
  });

  it('shows local midnight as 00:00 on the 24-hour clock', () => {
    // 2026-07-15 05:00 UTC is local midnight in Chicago (CDT, UTC-5).
    expect(formatTime24(Date.UTC(2026, 6, 15, 5, 0), CHICAGO)).toBe('00:00');
    expect(formatIsoDate(Date.UTC(2026, 6, 15, 5, 0), CHICAGO)).toBe('2026-07-15');
  });

  it('follows daylight saving transitions', () => {
    // US spring forward 2026-03-08: 08:00 UTC is 03:00 CDT (2:00 CST never happens).
    expect(formatTime24(Date.UTC(2026, 2, 8, 7, 59), CHICAGO)).toBe('01:59');
    expect(formatTime24(Date.UTC(2026, 2, 8, 8, 0), CHICAGO)).toBe('03:00');
    // US fall back 2026-11-01: 1:30 local happens twice, an hour apart in UTC.
    expect(formatTime(Date.UTC(2026, 10, 1, 6, 30), CHICAGO)).toBe('1:30 AM');
    expect(formatTime(Date.UTC(2026, 10, 1, 7, 30), CHICAGO)).toBe('1:30 AM');
  });

  it('reuses a cached formatter per zone without mixing zones up', () => {
    const t = Date.UTC(2026, 0, 10, 12, 0);
    expect(formatTime24(t, CHICAGO)).toBe('06:00');
    expect(formatTime24(t, 'Europe/London')).toBe('12:00');
    expect(formatTime24(t, CHICAGO)).toBe('06:00');
  });

  it('returns an em dash for a missing timestamp', () => {
    for (const f of [formatTime, formatTime24, formatDate, formatDateTime, shortDate]) {
      expect(f(null, CHICAGO)).toBe('—');
      expect(f(undefined, CHICAGO)).toBe('—');
    }
  });
});

describe('number formatting', () => {
  it('formats fractions as percentages', () => {
    expect(formatPct(0.875)).toBe('88%');
    expect(formatPct(0.875, 1)).toBe('87.5%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(1.234)).toBe('123%');
  });

  it('formats plain, grouped and integer values', () => {
    expect(formatNum(3.14159, 2)).toBe('3.14');
    expect(formatNum(7)).toBe('7');
    expect(formatDecimal(1226.5, 2)).toBe('1,226.50');
    expect(formatDecimal(-1234.567, 1)).toBe('-1,234.6');
    expect(formatInt(1226)).toBe('1,226');
    expect(formatInt(1226.6)).toBe('1,227');
    expect(formatInt(0)).toBe('0');
  });

  it('shows standards with one decimal by default, whole numbers on request', () => {
    expect(formatStdHr(44.2)).toBe('44.2');
    expect(formatStdHr(48)).toBe('48.0');
    expect(formatStdHr(1250.04)).toBe('1,250.0');
    expect(formatStdHr(44.6, 0)).toBe('45');
  });

  it('formats minutes and hours with their units', () => {
    expect(formatMinutes(14.6)).toBe('15 min');
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatHours(7.5)).toBe('7.50 h');
    expect(formatHours(7.456, 1)).toBe('7.5 h');
  });

  it('returns an em dash for missing or non-finite numbers', () => {
    for (const v of NO_VALUE) {
      expect(formatPct(v)).toBe('—');
      expect(formatNum(v)).toBe('—');
      expect(formatDecimal(v, 2)).toBe('—');
      expect(formatInt(v)).toBe('—');
      expect(formatStdHr(v)).toBe('—');
      expect(formatMinutes(v)).toBe('—');
      expect(formatHours(v)).toBe('—');
    }
  });
});

describe('relativeMinutes', () => {
  const now = Date.UTC(2026, 9, 27, 12, 0);
  const ago = (minutes: number) => now - minutes * 60_000;

  it('says "just now" under half a minute, including clock skew into the future', () => {
    expect(relativeMinutes(now, now)).toBe('just now');
    expect(relativeMinutes(ago(0.4), now)).toBe('just now');
    expect(relativeMinutes(now + 5 * 60_000, now)).toBe('just now');
  });

  it('counts minutes, then hours and minutes, then days', () => {
    expect(relativeMinutes(ago(1), now)).toBe('1 min ago');
    expect(relativeMinutes(ago(59), now)).toBe('59 min ago');
    expect(relativeMinutes(ago(60), now)).toBe('1 h 0 min ago');
    expect(relativeMinutes(ago(135), now)).toBe('2 h 15 min ago');
    expect(relativeMinutes(ago(24 * 60 - 1), now)).toBe('23 h 59 min ago');
    expect(relativeMinutes(ago(24 * 60), now)).toBe('1 d ago');
    expect(relativeMinutes(ago(3 * 24 * 60 + 600), now)).toBe('3 d ago');
  });

  it('returns an em dash when there is no timestamp', () => {
    expect(relativeMinutes(null, now)).toBe('—');
    expect(relativeMinutes(undefined, now)).toBe('—');
  });
});

describe('formatDays', () => {
  it('names the common patterns', () => {
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(formatDays([5, 4, 3, 2, 1])).toBe('Mon–Fri');
  });

  it('lists other day sets in week order without changing the input', () => {
    const days = [6, 0, 3];
    expect(formatDays(days)).toBe('Sun Wed Sat');
    expect(days).toEqual([6, 0, 3]);
    expect(formatDays([1, 2, 3, 4, 5, 6])).toBe('Mon Tue Wed Thu Fri Sat');
    expect(formatDays([])).toBe('');
  });
});
