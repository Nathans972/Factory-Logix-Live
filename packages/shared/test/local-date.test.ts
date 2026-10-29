import { describe, expect, it } from 'vitest';
import { breakWriteSchema, localDateSchema, shiftWriteSchema } from '../src/schemas.js';

describe('localDateSchema', () => {
  it.each(['2026-02-28', '2024-02-29', '2000-02-29', '2026-04-30', '2026-12-31', '0001-01-01', '9999-12-31'])(
    'accepts %s',
    (date) => {
      expect(localDateSchema.safeParse(date).success).toBe(true);
    },
  );

  // Each has the YYYY-MM-DD shape, but Postgres refuses it as a date.
  it.each(['2026-02-29', '2100-02-29', '2026-04-31', '2026-06-31', '2026-01-32', '2026-01-00', '2026-00-10', '2026-13-01', '0000-01-01'])(
    'rejects %s, which is not a day on the calendar',
    (date) => {
      const result = localDateSchema.safeParse(date);
      expect(result.error?.issues.map((i) => i.message)).toEqual(['not a day on the calendar']);
    },
  );

  it('reports a malformed date once', () => {
    const result = localDateSchema.safeParse('2026/02/28');
    expect(result.error?.issues.map((i) => i.message)).toEqual(['expected YYYY-MM-DD']);
  });

  it('applies to the effective dates of shifts and breaks', () => {
    const shift = { name: 'Day', start_local: '07:00', end_local: '19:00', days_of_week: [1, 2, 3, 4, 5] };
    const brk = { name: 'Lunch', start_local: '12:00', duration_minutes: 30, days_of_week: [1, 2, 3, 4, 5], shift_ids: null };
    expect(shiftWriteSchema.safeParse({ ...shift, effective_from: '2026-03-01', effective_to: null }).success).toBe(true);
    expect(shiftWriteSchema.safeParse({ ...shift, effective_from: '2026-02-29', effective_to: null }).success).toBe(false);
    expect(shiftWriteSchema.safeParse({ ...shift, effective_from: '2026-03-01', effective_to: '2026-04-31' }).success).toBe(false);
    expect(breakWriteSchema.safeParse({ ...brk, effective_from: '2026-03-01', effective_to: null }).success).toBe(true);
    expect(breakWriteSchema.safeParse({ ...brk, effective_from: '2026-02-29', effective_to: null }).success).toBe(false);
    expect(breakWriteSchema.safeParse({ ...brk, effective_from: '2026-03-01', effective_to: '2026-04-31' }).success).toBe(false);
  });
});
