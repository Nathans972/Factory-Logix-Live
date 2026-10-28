import { describe, expect, it } from 'vitest';
import { TimestampResolver } from '../src/mapping/extract.js';

/**
 * docs/MAPPING.md and SPEC 5.5 (`local_no_offset` mode): on the fall-back night the second pass through
 * the repeated 01:00 hour must resolve to EST. The collector detects the second pass when a naive value goes
 * back by more than 30 minutes, but it only compares with the PREVIOUS value, so only the single row right
 * after the jump is read as the second occurrence; the next row (a few minutes later in the same second
 * pass) compares as "later than the previous one" and is read as the FIRST occurrence again, one hour early.
 */
describe('local_no_offset fall-back night 2026-11-01 (America/New_York)', () => {
  it('keeps reading rows as the second occurrence for the rest of the repeated hour', () => {
    const r = new TimestampResolver({ mode: 'local_no_offset', timezone: 'America/New_York' });
    const key = 'unit_steps:complete_ts';
    // Completions in the order they arrive: the first pass up to 01:45 EDT, then the clock falls back
    // and the second pass starts at 01:05 EST and keeps counting up.
    const naive = [
      '2026-11-01T01:15:00',
      '2026-11-01T01:45:00',
      '2026-11-01T01:05:00',
      '2026-11-01T01:20:00',
      '2026-11-01T01:50:00',
    ];
    const got = naive.map((v) => new Date(r.parse(v, key) as number).toISOString());
    expect(got).toEqual([
      '2026-11-01T05:15:00.000Z', // 01:15 EDT
      '2026-11-01T05:45:00.000Z', // 01:45 EDT
      '2026-11-01T06:05:00.000Z', // 01:05 EST (second pass)
      '2026-11-01T06:20:00.000Z', // 01:20 EST (second pass)
      '2026-11-01T06:50:00.000Z', // 01:50 EST (second pass)
    ]);
  });
});
