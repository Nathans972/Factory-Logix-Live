/**
 * The TV's output table sits in a box that clips (spec 8.3: the TV never scrolls), above a bottom
 * strip at least 30vh tall. On a 1080p screen the box holds about 15 full rows. Separate mode has
 * one row per (operation, operator) over 12 hours, so around a shift change a job easily has 20 or
 * more, and the rows past the 15th were cut off: no scaling, no scrolling, no marker. Rows follow
 * the route, so the lost ones were the last operations (Final Inspection, Pack).
 *
 * The web tests run in plain node (no browser, no layout), so `fitRows` runs here against a box and
 * a table whose heights follow tv.css at 1920×1080, as measured on docs/screenshots/tv-separate.png:
 * rows 38.7 px apart, the header row 39 px, the box from y≈82 to y≈734 (652 px).
 */
import { describe, expect, it } from 'vitest';
import { MIN_ROW_SCALE, fitRows } from './tvLogic';

const VH = 10.8;
const TOP = 82;
const SPACE = 652;

/** A body row at scale s: 2.6vh type at line height 1.15, 2 × 0.25vh padding, the 1 px grid line. */
const row = (s: number) => (2.6 * 1.15 + 0.5) * VH * s + 1;
/** The header row: 0.78 × 2.6vh labels at normal line height and padding, the 0.3vh cyan rule, the grid line. */
const header = (s: number) => 34.5 * s + 0.3 * VH + 1;
const rows = (n: number) => Array.from({ length: n }, () => row);

/** A box and table that lay out again whenever `--tv-fit` changes, like the browser does. */
function screen(initial: Array<(s: number) => number>, space = SPACE) {
  const tv = { fit: 1, rows: initial, set: [] as string[] };
  const rects = () => {
    let y = TOP + header(tv.fit);
    return tv.rows.map((h) => {
      const height = h(tv.fit);
      y += height;
      return { top: y - height, bottom: y, height };
    });
  };
  const height = () => rects().reduce((sum, r) => sum + r.height, header(tv.fit));
  const box = {
    style: {
      setProperty(name: string, value: string) {
        if (name !== '--tv-fit') throw new Error(`fitRows set ${name}`);
        tv.fit = Number(value);
        tv.set.push(value);
      },
    },
    getBoundingClientRect: () => ({ top: TOP, height: space }),
  };
  const table = {
    getBoundingClientRect: () => ({ height: height() }),
    get tBodies() {
      return [{ rows: tv.rows.map((_, i) => ({ getBoundingClientRect: () => rects()[i]! })) }];
    },
  };
  return { box, table, tv, height, rects };
}

describe('fitRows keeps every TV output row on screen', () => {
  it('leaves the rows at full size while they fit (the 10 rows of the screenshot)', () => {
    const s = screen(rows(10));
    expect(fitRows(s.box, s.table)).toBeNull();
    expect(s.tv.fit).toBe(1);
  });

  it('shrinks 16 to 30 rows until all of them fit, and no further than it needs', () => {
    for (const n of [16, 20, 26, 30]) {
      const s = screen(rows(n));
      expect(s.height()).toBeGreaterThan(SPACE); // cut off at full size
      expect(fitRows(s.box, s.table)).toBeNull();
      expect(s.tv.fit).toBeLessThan(1);
      expect(s.tv.fit).toBeGreaterThanOrEqual(MIN_ROW_SCALE);
      expect(s.height()).toBeLessThanOrEqual(SPACE);
      expect(s.height()).toBeGreaterThan(SPACE * 0.97);
      expect(s.tv.set.length).toBeLessThanOrEqual(5);
    }
  });

  it('fits again when a banner or a longer defect table takes space from the box', () => {
    const s = screen(rows(20), SPACE - 2 * row(1) - 3 * 33);
    expect(fitRows(s.box, s.table)).toBeNull();
    expect(s.height()).toBeLessThanOrEqual(SPACE - 2 * row(1) - 3 * 33);
  });

  it('copes with an operation name that wraps onto two lines until the type gets smaller', () => {
    const wrapping = (s: number) => (s > 0.8 ? row(s) + 2.6 * 1.15 * VH * s : row(s));
    const s = screen([...rows(5), wrapping, ...rows(15)]);
    expect(fitRows(s.box, s.table)).toBeNull();
    expect(s.height()).toBeLessThanOrEqual(SPACE);
  });

  it('past half size, covers the rows that still do not fit with a "+N more rows" line instead of cutting them off', () => {
    const s = screen(rows(40));
    const cut = fitRows(s.box, s.table);
    expect(s.tv.fit).toBe(MIN_ROW_SCALE);
    expect(cut).not.toBeNull();
    const shown = 40 - cut!.hidden;
    const r = s.rects();
    expect(cut!.hidden).toBe(10);
    // The line starts where the first covered row starts, and has room for one row below it.
    expect(cut!.top).toBe(Math.floor(r[shown]!.top - TOP));
    expect(r[shown - 1]!.bottom - TOP).toBeLessThanOrEqual(SPACE - row(MIN_ROW_SCALE));
    expect(cut!.top + row(MIN_ROW_SCALE)).toBeLessThanOrEqual(SPACE);
  });

  it('starts from full size every time, so the rows grow back when there are fewer', () => {
    const s = screen(rows(40));
    expect(fitRows(s.box, s.table)).not.toBeNull();
    s.tv.rows = rows(24);
    expect(fitRows(s.box, s.table)).toBeNull();
    expect(s.tv.fit).toBeGreaterThan(MIN_ROW_SCALE);
    s.tv.rows = rows(10);
    expect(fitRows(s.box, s.table)).toBeNull();
    expect(s.tv.fit).toBe(1);
  });
});
