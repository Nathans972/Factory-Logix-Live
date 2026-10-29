import { describe, expect, it } from 'vitest';
import { TV_CELL_TEXT, TV_COLORS, tvRegisterSchema } from '@fld/shared';
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
  getDeviceToken,
  operatorLabel,
  rowOperatorLabel,
  msUntilNextHour,
  nextHourBoundary,
  readCookie,
  readStoredDeviceToken,
  resolveDeviceToken,
  TV_STYLE_VARS,
  nextDashboard,
  shouldRefetch,
  tvScreen,
} from './tvLogic';
import type { Display, TvDashboard, TvState } from '@fld/shared';

function tvStateWith(over: Partial<TvState>, display: Partial<Display> = {}): TvState {
  return {
    status: 'assigned',
    device_token: 'tok-12345678',
    pairing_code: '4821',
    display: {
      id: 1,
      pairing_code: '4821',
      name: 'Line 3',
      claimed_at: 1,
      job_number: 'J-100',
      group_operators: false,
      show_std_day: true,
      show_gauge: true,
      shift_length_hours: 12,
      last_seen_at: 1,
      created_at: 1,
      online: true,
      ...display,
    },
    dashboard: null,
    job_status: 'ok',
    sync: { status: 'ok', delayed: false, delayed_since: null, last_success_at: 1 },
    server_time: 1,
    plant_timezone: 'UTC',
    admin_url: 'http://plant/admin',
    ...over,
  };
}
const dash = (job: string) => ({ job: { job_number: job } }) as unknown as TvDashboard;
const titles = (s: ReturnType<typeof tvScreen>) => (s.kind === 'message' ? s.lines.map((l) => l.text) : ['<dashboard>']);

describe('tvScreen', () => {
  const base = { dashboard: null, loading: false, token: 'tok-12345678' };

  it('says "Waiting for data for job …" when the assigned job is not ingested yet', () => {
    const screen = tvScreen({ ...base, state: tvStateWith({ job_status: 'not_found' }) });
    expect(titles(screen)).toEqual(['Waiting for data for job J-100', 'Line 3']);
  });

  it('keeps "No job assigned" for an unassigned display', () => {
    const screen = tvScreen({ ...base, state: tvStateWith({ status: 'unassigned', job_status: null }, { job_number: null }) });
    expect(titles(screen)).toEqual(['No job assigned', 'Line 3', 'Code 4821']);
  });

  it('names the job when its dashboard could not be built', () => {
    const screen = tvScreen({ ...base, state: tvStateWith({ job_status: 'error' }) });
    expect(titles(screen)).toEqual(['Dashboard unavailable for job J-100', 'Line 3']);
  });

  it('shows the dashboard, the pairing code and the connecting states', () => {
    expect(tvScreen({ ...base, state: tvStateWith({ dashboard: dash('J-100') }) }).kind).toBe('dashboard');
    expect(titles(tvScreen({ ...base, state: tvStateWith({ status: 'unclaimed', job_status: null }) }))).toContain('4821');
    expect(titles(tvScreen({ ...base, state: null, loading: true }))).toEqual(['Connecting…']);
    expect(titles(tvScreen({ ...base, state: null }))).toEqual(['Dashboard unavailable', 'Device tok-1234']);
  });
});

describe('nextDashboard', () => {
  it('follows the server, except that a build error on the same job keeps the last dashboard', () => {
    expect(nextDashboard(dash('J-100'), tvStateWith({ dashboard: dash('J-200') }))?.job.job_number).toBe('J-200');
    expect(nextDashboard(dash('J-100'), tvStateWith({ job_status: 'error' }))?.job.job_number).toBe('J-100');
    expect(nextDashboard(dash('J-100'), tvStateWith({ job_status: 'error' }, { job_number: 'J-200' }))).toBeNull();
    expect(nextDashboard(dash('J-100'), tvStateWith({ job_status: 'not_found' }))).toBeNull();
    expect(nextDashboard(dash('J-100'), tvStateWith({ status: 'unassigned', job_status: null }, { job_number: null }))).toBeNull();
  });
});

describe('shouldRefetch', () => {
  it('acts on new data and sync health, and on display changes only for its own display', () => {
    expect(shouldRefetch({ type: 'data_updated', at: 1, hours: [] }, 7)).toBe(true);
    expect(shouldRefetch({ type: 'sync_health', at: 1, status: 'ok', delayed: false }, 7)).toBe(true);
    expect(shouldRefetch({ type: 'display_updated', at: 1, display_id: 7 }, 7)).toBe(true);
    // Another TV registering (anyone may) or being edited is not news to this one.
    expect(shouldRefetch({ type: 'display_updated', at: 1, display_id: 8 }, 7)).toBe(false);
    // Before its first response the TV cannot tell, so any display change counts.
    expect(shouldRefetch({ type: 'display_updated', at: 1, display_id: 8 }, null)).toBe(true);
    expect(shouldRefetch({ type: 'settings_updated', at: 1 }, 7)).toBe(false);
    expect(shouldRefetch({ type: 'heartbeat', at: 1 }, 7)).toBe(false);
  });
});

describe('resolveDeviceToken', () => {
  const generate = () => 'generated-uuid';
  const STORED = '6f1c2b0e-3d4a-4b5c-8d6e-7f8091a2b3c4';

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
    expect(resolveDeviceToken({ search: '?demo=1', stored: STORED, isMock: false, generate }).token).toBe(STORED);
  });

  it('prefers ?token= over storage and persists it (spec 8.1 bookmark restore)', () => {
    const QUERY = '2a7d4e91-8c3b-4f6a-9e1d-0b5c7a3f2e18';
    const r = resolveDeviceToken({ search: `?token=${QUERY}&x=1`, stored: STORED, isMock: false, generate });
    expect(r).toEqual({ token: QUERY, persist: true, source: 'query' });
    // the mock DataSource accepts any token, so a mock bookmark need not be a UUID
    expect(resolveDeviceToken({ search: '?token=demo-2', stored: STORED, isMock: true, generate })).toEqual({
      token: 'demo-2',
      persist: true,
      source: 'query',
    });
  });

  it('falls back to the stored token, re-persisting so the cookie expiry rolls forward', () => {
    expect(resolveDeviceToken({ search: '', stored: STORED, isMock: false, generate })).toEqual({
      token: STORED,
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

  it('replaces a stored token the API can never register (a `tv-…` token from a plain-HTTP page)', () => {
    expect(resolveDeviceToken({ search: '', stored: 'tv-eutgqgrumzomvrxc2pr', isMock: false, generate })).toEqual({
      token: 'generated-uuid',
      persist: true,
      source: 'generated',
    });
    // the mock DataSource accepts any token
    expect(resolveDeviceToken({ search: '', stored: 'tv-eutgqgrumzomvrxc2pr', isMock: true, generate }).source).toBe('stored');
  });
});

describe('getDeviceToken', () => {
  it('generates a fresh v4 UUID the API accepts', () => {
    const a = getDeviceToken(false);
    const b = getDeviceToken(false);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(tvRegisterSchema.safeParse({ device_token: a }).success).toBe(true);
    expect(b).not.toBe(a);
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

describe('operator labels', () => {
  it('shows the FactoryLogix user name as-is', () => {
    expect(operatorLabel('NSessions', 'Nathan Sessions')).toBe('NSessions');
    expect(operatorLabel('JRivera', null)).toBe('JRivera');
  });
  it('derives first initial + last name from a full-name id', () => {
    expect(operatorLabel('Nathan Sessions', null)).toBe('NSessions');
    expect(operatorLabel('  nathan van sessions ', null)).toBe('Nsessions');
  });
  it('falls back to the display name for opaque ids', () => {
    expect(operatorLabel('10423', 'Nathan Sessions')).toBe('NSessions');
    expect(operatorLabel('n.sessions@example.com', 'Nathan Sessions')).toBe('NSessions');
    expect(operatorLabel('10423', null)).toBe('10423');
    expect(operatorLabel(null, 'x')).toBe('');
  });
  it('labels grouped rows', () => {
    expect(rowOperatorLabel({ operator_id: null, operator_name: null, operators: ['A', 'B'] })).toBe('Multiple Operators');
    expect(rowOperatorLabel({ operator_id: 'JRivera', operator_name: 'Jasmine Rivera', operators: ['JRivera'] })).toBe('JRivera');
    expect(rowOperatorLabel({ operator_id: null, operator_name: null, operators: ['LNguyen'] })).toBe('LNguyen');
    expect(rowOperatorLabel({ operator_id: null, operator_name: null, operators: [] })).toBe('');
  });
});
