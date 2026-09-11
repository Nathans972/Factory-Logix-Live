import { describe, expect, it, vi } from 'vitest';
import { TimestampResolver, type LocalToUtcFn } from '../src/mapping/extract.js';

/** Deterministic stand-in for the engine helper: records how ambiguity was resolved. */
function fakeLocalToUtc(calls: { ambiguous: string | undefined; hour: number; minute: number }[]): LocalToUtcFn {
  return (_tz, parts, opts) => {
    calls.push({ ambiguous: opts?.ambiguous, hour: parts.hour, minute: parts.minute ?? 0 });
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute ?? 0, parts.second ?? 0);
  };
}

describe('fl_timestamp_mode: offset_present', () => {
  it('parses strings that carry an offset', () => {
    const r = new TimestampResolver({ mode: 'offset_present', timezone: 'America/New_York' });
    expect(r.parse('2025-03-09T06:30:00Z')).toBe(Date.parse('2025-03-09T06:30:00Z'));
    expect(r.parse('2025-03-09T01:30:00-05:00')).toBe(Date.parse('2025-03-09T01:30:00-05:00'));
  });

  it('falls back to UTC and warns once when the offset is missing', () => {
    const onWarn = vi.fn();
    const r = new TimestampResolver({ mode: 'offset_present', timezone: 'America/New_York', onWarn });
    expect(r.parse('2025-03-09T06:30:00')).toBe(Date.UTC(2025, 2, 9, 6, 30, 0));
    expect(r.parse('2025-03-09T07:30:00')).toBe(Date.UTC(2025, 2, 9, 7, 30, 0));
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toBe('missing_offset');
  });
});

describe('fl_timestamp_mode: utc', () => {
  it('reads naive strings as UTC', () => {
    const r = new TimestampResolver({ mode: 'utc', timezone: 'America/New_York' });
    expect(r.parse('2025-07-04 13:45:30')).toBe(Date.UTC(2025, 6, 4, 13, 45, 30));
    expect(r.parse('2025-07-04')).toBe(Date.UTC(2025, 6, 4, 0, 0, 0));
    expect(r.parse('2025-07-04T13:45:30.250')).toBe(Date.UTC(2025, 6, 4, 13, 45, 30, 250));
  });
});

describe('JSON /Date(...)/ values', () => {
  it('reads the epoch milliseconds, with or without a trailing offset', () => {
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York' });
    expect(r.parse('/Date(1735689600000)/')).toBe(1735689600000);
    expect(r.parse('/Date(1735689600000+0300)/')).toBe(1735689600000);
    expect(r.parse('/Date(-10000)/')).toBe(-10000);
  });
});

describe('fl_timestamp_mode: local_no_offset', () => {
  it('resolves the repeated hour with the monotonic rule', () => {
    const calls: { ambiguous: string | undefined; hour: number; minute: number }[] = [];
    const r = new TimestampResolver({
      mode: 'local_no_offset',
      timezone: 'America/New_York',
      localToUtc: fakeLocalToUtc(calls),
    });

    // Fall-back night 2025-11-02: 01:45 then 01:05 goes back 40 minutes => second occurrence.
    r.parse('2025-11-02T01:15:00', 'unit_steps');
    r.parse('2025-11-02T01:45:00', 'unit_steps');
    r.parse('2025-11-02T01:05:00', 'unit_steps');
    r.parse('2025-11-02T01:20:00', 'unit_steps');

    expect(calls.map((c) => c.ambiguous)).toEqual(['earlier', 'earlier', 'later', 'earlier']);
  });

  it('tolerates small out-of-order jitter (<= 30 minutes)', () => {
    const calls: { ambiguous: string | undefined; hour: number; minute: number }[] = [];
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York', localToUtc: fakeLocalToUtc(calls) });
    r.parse('2025-11-02T01:40:00', 'defects');
    r.parse('2025-11-02T01:20:00', 'defects');
    expect(calls.map((c) => c.ambiguous)).toEqual(['earlier', 'earlier']);
  });

  it('keeps a separate cursor per source', () => {
    const calls: { ambiguous: string | undefined; hour: number; minute: number }[] = [];
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York', localToUtc: fakeLocalToUtc(calls) });
    r.parse('2025-11-02T01:50:00', 'unit_steps');
    r.parse('2025-11-02T01:00:00', 'defects');
    expect(calls.map((c) => c.ambiguous)).toEqual(['earlier', 'earlier']);
  });

  it('still honours an explicit offset when one is present', () => {
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York' });
    expect(r.parse('2025-11-02T01:30:00-04:00')).toBe(Date.parse('2025-11-02T01:30:00-04:00'));
  });

  it('returns null for unusable values', () => {
    const r = new TimestampResolver({ mode: 'utc', timezone: 'America/New_York' });
    expect(r.parse(null)).toBeNull();
    expect(r.parse('')).toBeNull();
    expect(r.parse('not a date')).toBeNull();
  });
});
