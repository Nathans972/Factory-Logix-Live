import type { ShiftDef, ShiftWrite } from '@fld/shared';
import { describe, expect, it } from 'vitest';
import {
  effectiveRangesOverlap,
  findOverlappingShift,
  previousDay,
  shiftDurationMinutes,
  weekIntervals,
} from '../src/services/shift-validation.js';

const WEEKDAYS = [1, 2, 3, 4, 5];

function shift(overrides: Partial<ShiftDef> = {}): ShiftDef {
  return {
    id: 1,
    name: 'Day',
    start_local: '06:00',
    end_local: '18:00',
    days_of_week: WEEKDAYS,
    effective_from: '2024-01-01',
    effective_to: null,
    ...overrides,
  };
}

function write(overrides: Partial<ShiftWrite> = {}): ShiftWrite {
  const { id: _id, ...rest } = shift(overrides as Partial<ShiftDef>);
  return rest;
}

describe('shift duration', () => {
  it('handles same-day shifts', () => {
    expect(shiftDurationMinutes('06:00', '18:00')).toBe(720);
  });

  it('handles shifts ending after midnight', () => {
    expect(shiftDurationMinutes('18:00', '06:00')).toBe(720);
    expect(shiftDurationMinutes('22:30', '02:00')).toBe(210);
  });

  it('treats equal start and end as a full day', () => {
    expect(shiftDurationMinutes('06:00', '06:00')).toBe(1440);
  });
});

describe('weekIntervals', () => {
  it('places a Monday day shift after Sunday', () => {
    expect(weekIntervals({ start_local: '06:00', end_local: '18:00', days_of_week: [1] })).toEqual([
      [1440 + 360, 1440 + 1080],
    ]);
  });

  it('wraps a Saturday night shift into Sunday 00:00', () => {
    const intervals = weekIntervals({ start_local: '18:00', end_local: '06:00', days_of_week: [6] });
    expect(intervals).toEqual([
      [6 * 1440 + 1080, 10080],
      [0, 360],
    ]);
  });
});

describe('findOverlappingShift', () => {
  it('accepts adjacent shifts that only touch at the boundary', () => {
    const day = shift({ id: 1, name: 'Day', start_local: '06:00', end_local: '18:00' });
    const night = write({ name: 'Night', start_local: '18:00', end_local: '06:00' });
    expect(findOverlappingShift(night, [day])).toBeNull();
  });

  it('detects an overlap on a shared day', () => {
    const day = shift({ id: 1, start_local: '06:00', end_local: '18:00' });
    const clash = write({ name: 'Swing', start_local: '17:00', end_local: '23:00' });
    expect(findOverlappingShift(clash, [day])?.id).toBe(1);
  });

  it('detects an overlap created by a shift crossing midnight into the next day', () => {
    const night = shift({ id: 2, name: 'Night', start_local: '20:00', end_local: '04:00', days_of_week: [1] });
    const earlyTuesday = write({ name: 'Early', start_local: '03:00', end_local: '11:00', days_of_week: [2] });
    expect(findOverlappingShift(earlyTuesday, [night])?.id).toBe(2);
  });

  it('ignores shifts on other days', () => {
    const weekday = shift({ id: 1, days_of_week: [1, 2, 3, 4, 5] });
    const weekend = write({ name: 'Weekend', days_of_week: [0, 6] });
    expect(findOverlappingShift(weekend, [weekday])).toBeNull();
  });

  it('ignores shifts whose effective ranges do not overlap', () => {
    const old = shift({ id: 1, effective_from: '2023-01-01', effective_to: '2023-12-31' });
    const next = write({ effective_from: '2024-01-01' });
    expect(findOverlappingShift(next, [old])).toBeNull();
  });

  it('skips the shift being edited', () => {
    const existing = shift({ id: 5 });
    expect(findOverlappingShift(write({ start_local: '07:00' }), [existing], 5)).toBeNull();
    expect(findOverlappingShift(write({ start_local: '07:00' }), [existing])?.id).toBe(5);
  });

  it('wraps around the end of the week', () => {
    const saturdayNight = shift({ id: 3, start_local: '22:00', end_local: '06:00', days_of_week: [6] });
    const sundayMorning = write({ name: 'Sun AM', start_local: '05:00', end_local: '13:00', days_of_week: [0] });
    expect(findOverlappingShift(sundayMorning, [saturdayNight])?.id).toBe(3);
  });
});

describe('effective range helpers', () => {
  it('treats a null effective_to as open ended', () => {
    expect(
      effectiveRangesOverlap({ effective_from: '2024-01-01', effective_to: null }, { effective_from: '2030-01-01', effective_to: null }),
    ).toBe(true);
    expect(
      effectiveRangesOverlap(
        { effective_from: '2024-01-01', effective_to: '2024-06-30' },
        { effective_from: '2024-07-01', effective_to: null },
      ),
    ).toBe(false);
  });

  it('computes the previous day for shift versioning', () => {
    expect(previousDay('2024-03-01')).toBe('2024-02-29');
    expect(previousDay('2024-01-01')).toBe('2023-12-31');
    expect(previousDay('2024-11-04')).toBe('2024-11-03');
  });
});
