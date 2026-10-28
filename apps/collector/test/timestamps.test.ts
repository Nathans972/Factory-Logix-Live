import { describe, expect, it, vi } from 'vitest';
import { TimestampResolver } from '../src/mapping/extract.js';

/** The instants (ISO, UTC) a run of plant wall-clock times on 2025-11-02 resolves to, in arrival order. */
function readAll(r: TimestampResolver, sourceKey: string, rows: [time: string, rowKey?: string][]): string[] {
  return rows.map(([time, rowKey]) => new Date(r.parse(`2025-11-02T${time}:00`, sourceKey, rowKey) as number).toISOString());
}

const newYork = () => new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York' });

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
  it('reads the epoch milliseconds as UTC, with or without a trailing offset, in utc and offset_present modes', () => {
    for (const mode of ['utc', 'offset_present'] as const) {
      const r = new TimestampResolver({ mode, timezone: 'America/New_York' });
      expect(r.parse('/Date(1735689600000)/')).toBe(1735689600000);
      expect(r.parse('/Date(1735689600000+0300)/')).toBe(1735689600000);
      expect(r.parse('/Date(-10000)/')).toBe(-10000);
    }
  });

  it('local_no_offset: reads an offset-less /Date(ms)/ as plant wall-clock time', () => {
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York' });
    // 2025-01-01 00:00 wall clock in New York (EST, UTC-5).
    expect(r.parse('/Date(1735689600000)/')).toBe(Date.parse('2025-01-01T05:00:00Z'));
    // A trailing offset means the milliseconds already are the UTC instant.
    expect(r.parse('/Date(1735689600000+0300)/')).toBe(1735689600000);
    expect(r.parse('/Date(-10000)/')).toBe(-10000 + 5 * 3_600_000);
  });

  it('local_no_offset: /Date(ms)/ on daylight saving dates', () => {
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York' });
    // Spring forward 2025-03-09: 01:30 is EST (UTC-5), 03:30 is EDT (UTC-4).
    expect(r.parse(`/Date(${Date.UTC(2025, 2, 9, 1, 30)})/`, 'unit_steps')).toBe(Date.parse('2025-03-09T06:30:00Z'));
    expect(r.parse(`/Date(${Date.UTC(2025, 2, 9, 3, 30)})/`, 'unit_steps')).toBe(Date.parse('2025-03-09T07:30:00Z'));
    // Fall back 2025-11-02: 01:45 then 01:05 (40 minutes back) is the second, EST occurrence.
    expect(r.parse(`/Date(${Date.UTC(2025, 10, 2, 1, 45)})/`, 'defects')).toBe(Date.parse('2025-11-02T05:45:00Z'));
    expect(r.parse(`/Date(${Date.UTC(2025, 10, 2, 1, 5)})/`, 'defects')).toBe(Date.parse('2025-11-02T06:05:00Z'));
  });
});

describe('fl_timestamp_mode: local_no_offset', () => {
  // Fall-back night 2025-11-02 in New York: 01:00-01:59 happens at 05:xxZ (EDT), then again at 06:xxZ (EST).

  it('resolves the repeated hour with the monotonic rule: the rest of the hour stays in the second pass', () => {
    // 01:45 then 01:05 goes back 40 minutes => the clock went back; 01:20 is 15 minutes later in that second pass.
    expect(readAll(newYork(), 'unit_steps', [['01:15'], ['01:45'], ['01:05'], ['01:20']])).toEqual([
      '2025-11-02T05:15:00.000Z',
      '2025-11-02T05:45:00.000Z',
      '2025-11-02T06:05:00.000Z',
      '2025-11-02T06:20:00.000Z',
    ]);
  });

  it('stays in the second pass across a gap of more than 30 minutes, and compares instants after the hour', () => {
    expect(readAll(newYork(), 'unit_steps', [['01:40'], ['01:55'], ['01:02'], ['01:45'], ['02:10'], ['01:58']])).toEqual([
      '2025-11-02T05:40:00.000Z',
      '2025-11-02T05:55:00.000Z',
      '2025-11-02T06:02:00.000Z', // the clock went back
      '2025-11-02T06:45:00.000Z', // 43 minutes later, still the second pass
      '2025-11-02T07:10:00.000Z', // 02:10 EST
      '2025-11-02T06:58:00.000Z', // 12 minutes before it: 01:58 EST, not 01:58 EDT 72 minutes before
    ]);
  });

  it('tolerates small out-of-order jitter (<= 30 minutes)', () => {
    expect(readAll(newYork(), 'defects', [['01:40'], ['01:20']])).toEqual(['2025-11-02T05:40:00.000Z', '2025-11-02T05:20:00.000Z']);
  });

  it('keeps a separate cursor per source', () => {
    const r = newYork();
    expect(readAll(r, 'unit_steps', [['01:50']])).toEqual(['2025-11-02T05:50:00.000Z']);
    expect(readAll(r, 'defects', [['01:00']])).toEqual(['2025-11-02T05:00:00.000Z']);
  });

  it('a row read again keeps its reading: the overlap re-pull right after the clock went back', () => {
    const r = newYork();
    expect(readAll(r, 'unit_steps:complete_ts', [['01:45', 'S-1'], ['01:55', 'S-2'], ['01:02', 'S-3']])).toEqual([
      '2025-11-02T05:45:00.000Z',
      '2025-11-02T05:55:00.000Z',
      '2025-11-02T06:02:00.000Z',
    ]);
    // The next poll re-reads the last minutes before the clock went back, then the new row.
    expect(readAll(r, 'unit_steps:complete_ts', [['01:45', 'S-1'], ['01:55', 'S-2'], ['01:02', 'S-3'], ['01:40', 'S-4']])).toEqual([
      '2025-11-02T05:45:00.000Z',
      '2025-11-02T05:55:00.000Z',
      '2025-11-02T06:02:00.000Z',
      '2025-11-02T06:40:00.000Z',
    ]);
  });

  it('a second-pass reading after the read time is the first pass, and does not end the second pass', () => {
    const r = newYork();
    // Before the clock goes back (read at 05:50Z): a step that started 35 minutes before the previous one.
    r.setReadTime(Date.parse('2025-11-02T05:50:00Z'));
    expect(readAll(r, 'unit_steps:start_ts', [['01:45'], ['01:10'], ['01:47']])).toEqual([
      '2025-11-02T05:45:00.000Z',
      '2025-11-02T05:10:00.000Z',
      '2025-11-02T05:47:00.000Z',
    ]);
    // After (read at 06:15Z): a step that started at 01:50 EDT finishes in the second pass.
    r.setReadTime(Date.parse('2025-11-02T06:15:00Z'));
    expect(readAll(r, 'unit_steps:start_ts', [['01:05'], ['01:50'], ['01:08']])).toEqual([
      '2025-11-02T06:05:00.000Z',
      '2025-11-02T05:50:00.000Z',
      '2025-11-02T06:08:00.000Z',
    ]);
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
