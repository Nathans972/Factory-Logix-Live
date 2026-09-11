import { describe, expect, it } from 'vitest';
import { HOUR_MS, countHours, hoursInRange, mergeHourRanges } from '../src/engine/hours.js';

const H = (n: number) => Date.UTC(2025, 0, 1, n, 0, 0);

describe('touched hour merging', () => {
  it('merges contiguous hours into one range', () => {
    expect(mergeHourRanges([H(1), H(2), H(3)])).toEqual([{ from: H(1), to: H(4) }]);
  });

  it('keeps gaps apart and sorts/deduplicates the input', () => {
    expect(mergeHourRanges([H(5), H(1), H(5), H(2)])).toEqual([
      { from: H(1), to: H(3) },
      { from: H(5), to: H(6) },
    ]);
  });

  it('handles an empty or invalid input', () => {
    expect(mergeHourRanges([])).toEqual([]);
    expect(mergeHourRanges([Number.NaN])).toEqual([]);
  });

  it('expands a range back into hour starts', () => {
    const range = { from: H(9), to: H(12) };
    expect(hoursInRange(range)).toEqual([H(9), H(10), H(11)]);
    expect(countHours([range])).toBe(3);
    expect(range.to - range.from).toBe(3 * HOUR_MS);
  });
});
