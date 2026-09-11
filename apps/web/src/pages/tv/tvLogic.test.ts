import { describe, expect, it } from 'vitest';
import { TV_CELL_TEXT, TV_COLORS } from '@fld/shared';
import {
  DEVICE_TOKEN_KEY,
  cellClass,
  cellFill,
  cellText,
  cellTextColor,
  clampProgress,
  deviceCookieString,
  formatProgressPct,
  formatStd,
  msUntilNextHour,
  nextHourBoundary,
  readCookie,
  readStoredDeviceToken,
  resolveDeviceToken,
  TV_STYLE_VARS,
} from './tvLogic';

describe('resolveDeviceToken', () => {
  const generate = () => 'generated-uuid';

  it('uses the demo shortcut only in mock mode and never persists it', () => {
    expect(resolveDeviceToken({ search: '?demo=1', stored: null, isMock: true, generate })).toEqual({
      token: 'demo-1',
      persist: false,
      source: 'demo',
    });
    expect(resolveDeviceToken({ search: 'demo=2', stored: 'abc', isMock: true, generate })).toEqual({
      token: 'demo-2',
      persist: false,
      source: 'demo',
    });
    // outside mock mode ?demo is ignored
    expect(resolveDeviceToken({ search: '?demo=1', stored: 'abc', isMock: false, generate }).token).toBe('abc');
  });

  it('prefers ?token= over storage and persists it (spec 8.1 bookmark restore)', () => {
    const r = resolveDeviceToken({ search: '?token=1234-abcd&x=1', stored: 'stored-one', isMock: false, generate });
    expect(r).toEqual({ token: '1234-abcd', persist: true, source: 'query' });
  });

  it('falls back to the stored token, re-persisting so the cookie expiry rolls forward', () => {
    expect(resolveDeviceToken({ search: '', stored: 'stored-one', isMock: false, generate })).toEqual({
      token: 'stored-one',
      persist: true,
      source: 'stored',
    });
  });

  it('generates a new token when nothing is stored', () => {
    expect(resolveDeviceToken({ search: '?', stored: null, isMock: true, generate })).toEqual({
      token: 'generated-uuid',
      persist: true,
      source: 'generated',
    });
    // blank values are treated as absent
    expect(resolveDeviceToken({ search: '?token=%20', stored: '  ', isMock: false, generate }).source).toBe('generated');
  });
});

describe('cookies', () => {
  it('reads a named cookie out of a document.cookie string', () => {
    const c = `other=1; ${DEVICE_TOKEN_KEY}=abc-123; another=2`;
    expect(readCookie(c, DEVICE_TOKEN_KEY)).toBe('abc-123');
    expect(readCookie(c, 'missing')).toBeNull();
    expect(readCookie('', DEVICE_TOKEN_KEY)).toBeNull();
    expect(readCookie(`${DEVICE_TOKEN_KEY}=a%20b`, DEVICE_TOKEN_KEY)).toBe('a b');
  });

  it('writes a 10 year, path=/ cookie', () => {
    const s = deviceCookieString('abc');
    expect(s).toContain(`${DEVICE_TOKEN_KEY}=abc`);
    expect(s).toContain('path=/');
    expect(s).toContain(`max-age=${10 * 365 * 24 * 60 * 60}`);
  });

  it('reading storage outside a browser is safe', () => {
    expect(readStoredDeviceToken()).toBeNull();
  });
});

describe('msUntilNextHour', () => {
  it('lands exactly on the next local hour boundary', () => {
    const now = Date.UTC(2026, 0, 15, 10, 15, 30, 250);
    expect(msUntilNextHour(now, 'UTC')).toBe(2_669_750);
    expect(nextHourBoundary(now, 'UTC')).toBe(Date.UTC(2026, 0, 15, 11, 0, 0, 0));
  });

  it('handles half-hour offset zones', () => {
    const now = Date.UTC(2026, 0, 15, 10, 15, 30, 0);
    // 15:45:30 in Kolkata -> 14m30s until 16:00 local
    expect(msUntilNextHour(now, 'Asia/Kolkata')).toBe(870_000);
    expect(nextHourBoundary(now, 'Asia/Kolkata')).toBe(Date.UTC(2026, 0, 15, 10, 30, 0, 0));
  });

  it('returns a full hour exactly on the hour and never a non-positive delay', () => {
    expect(msUntilNextHour(Date.UTC(2026, 0, 15, 10, 0, 0, 0), 'UTC')).toBe(3_600_000);
    const v = msUntilNextHour(Date.UTC(2026, 0, 15, 10, 59, 59, 900), 'UTC');
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(3_600_000);
  });

  it('falls back to the browser clock for an invalid time zone', () => {
    const v = msUntilNextHour(Date.now(), 'Not/AZone');
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(3_600_000);
  });
});

describe('cell mapping', () => {
  it('maps colors to classes, fills and legible text colors', () => {
    expect(cellClass('red')).toBe('tv-c-red');
    expect(cellFill('red')).toBe(TV_COLORS.red);
    expect(cellFill('visitor')).toBe(TV_COLORS.visitor);
    expect(cellFill('neutral')).toBeNull();
    expect(cellFill('blank')).toBeNull();
    expect(cellTextColor('red')).toBe(TV_CELL_TEXT.red);
    expect(cellTextColor('yellow')).toBe(TV_CELL_TEXT.yellow);
    expect(cellTextColor('green')).toBe(TV_CELL_TEXT.green);
    expect(cellTextColor('blue')).toBe(TV_CELL_TEXT.blue);
    expect(cellTextColor('neutral')).toBe(TV_CELL_TEXT.neutral);
    expect(cellTextColor('visitor')).toBe(TV_CELL_TEXT.visitor);
  });

  it('always shows the number except on blank cells (spec 14)', () => {
    expect(cellText('blank', 0)).toBe('');
    expect(cellText('neutral', 0)).toBe('0');
    expect(cellText('visitor', 6)).toBe('6');
    expect(cellText('green', 43)).toBe('43');
  });

  it('formats standards and progress', () => {
    expect(formatStd(null)).toBe('—');
    expect(formatStd(30)).toBe('30');
    expect(formatStd(28.456)).toBe('28');
    expect(formatStd(28.5)).toBe('29');
    expect(formatProgressPct(0)).toBe('0.00%');
    expect(formatProgressPct(0.1234)).toBe('12.34%');
    expect(formatProgressPct(null)).toBe('0.00%');
    expect(clampProgress(1.4)).toBe(1);
    expect(clampProgress(-1)).toBe(0);
    expect(clampProgress(null)).toBe(0);
  });

  it('exposes the shared palette as CSS variables', () => {
    expect(TV_STYLE_VARS['--tv-bg']).toBe(TV_COLORS.background);
    expect(TV_STYLE_VARS['--tv-fg']).toBe(TV_COLORS.primaryText);
    expect(TV_STYLE_VARS['--tv-on-red']).toBe(TV_CELL_TEXT.red);
  });
});
