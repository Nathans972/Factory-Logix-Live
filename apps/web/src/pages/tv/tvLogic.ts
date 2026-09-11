/**
 * Pure helpers for the TV display (spec 8).
 *
 * Everything in this module is side-effect free and unit tested (`tvLogic.test.ts`), except the
 * three thin wrappers at the bottom that touch `window` / `localStorage` / `document.cookie`.
 * Those guard every browser access so the module can also be imported in a node test environment.
 */
import { TV_CELL_TEXT, TV_COLORS, type CellColor } from '@fld/shared';

export const DEVICE_TOKEN_KEY = 'fld_device_token';
/** 10 years, in seconds (spec 8.1: the token survives reboots and normal cache behavior). */
export const DEVICE_TOKEN_MAX_AGE = 10 * 365 * 24 * 60 * 60;

// ---------------------------------------------------------------- style tokens

export const CELL_COLORS: CellColor[] = ['blank', 'neutral', 'red', 'yellow', 'green', 'blue', 'visitor'];

/** Class name for an hour cell fill (spec 7.5 colors, 8.3 tokens). */
export function cellClass(color: CellColor): string {
  return `tv-c-${color}`;
}

/** Legible text color on top of a filled cell (single source: `TV_CELL_TEXT`). */
export function cellTextColor(color: CellColor): string {
  return TV_CELL_TEXT[color] ?? TV_CELL_TEXT.blank;
}

/** Fill color for a cell; `blank` and `neutral` have no fill (spec 7.5). */
export function cellFill(color: CellColor): string | null {
  switch (color) {
    case 'red':
      return TV_COLORS.red;
    case 'yellow':
      return TV_COLORS.yellow;
    case 'green':
      return TV_COLORS.green;
    case 'blue':
      return TV_COLORS.blue;
    case 'visitor':
      return TV_COLORS.visitor;
    default:
      return null;
  }
}

/**
 * CSS custom properties derived from the shared tokens (`TV_COLORS` / `TV_CELL_TEXT`) so the
 * palette has a single source of truth. Applied inline on every `.tv-root` element; `tv.css`
 * only ever refers to the variables.
 */
export const TV_STYLE_VARS: Record<string, string> = (() => {
  const vars: Record<string, string> = {
    '--tv-bg': TV_COLORS.background,
    '--tv-fg': TV_COLORS.primaryText,
    '--tv-label': TV_COLORS.headerText,
    '--tv-grid': TV_COLORS.grid,
    '--tv-neutral': TV_COLORS.neutral,
  };
  for (const c of CELL_COLORS) {
    const fill = cellFill(c);
    if (fill) vars[`--tv-${c}`] = fill;
    vars[`--tv-on-${c}`] = cellTextColor(c);
  }
  return vars;
})();

/**
 * Text shown in an hour cell. The number is always shown (spec 14: color is never the only
 * signal); only `blank` cells are empty. Never a projection (spec 7.5).
 */
export function cellText(color: CellColor, units: number): string {
  if (color === 'blank') return '';
  return String(units);
}

/** StdHr / StdDay display: an em dash when the standard is unavailable (spec 15 scenario 11). */
export function formatStd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(Math.round(v * 100) / 100);
}

/** Ring gauge label, matching the old dashboard's "0.00%" (spec 8.3). */
export function formatProgressPct(progress: number | null | undefined): string {
  const p = progress == null || !Number.isFinite(progress) ? 0 : progress;
  return `${(p * 100).toFixed(2)}%`;
}

/** Fraction of the ring to paint, clamped to [0, 1] (the label may still read > 100%). */
export function clampProgress(progress: number | null | undefined): number {
  if (progress == null || !Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

// ---------------------------------------------------------------- hour boundary

/**
 * Milliseconds until the top of the next hour in `tz`. The TV re-renders then so the rolling
 * window rolls even if no data event arrives (spec 8.4 / 7.8).
 * Works for whole-, half- and quarter-hour offsets because it reads the zone's own wall clock.
 */
export function msUntilNextHour(now: number, tz: string): number {
  let minute = new Date(now).getMinutes();
  let second = new Date(now).getSeconds();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
    minute = get('minute');
    second = get('second');
  } catch {
    /* invalid tz: fall back to the browser's local clock */
  }
  const remaining = ((59 - minute) * 60 + (60 - second)) * 1000 - (now % 1000);
  // Never schedule a zero/negative timeout: clamp into (0, 3600000].
  return Math.min(3_600_000, Math.max(1_000, remaining));
}

/** Absolute timestamp of the next local hour boundary in `tz`. */
export function nextHourBoundary(now: number, tz: string): number {
  return now + msUntilNextHour(now, tz);
}

// ---------------------------------------------------------------- device identity

export type TokenSource = 'demo' | 'query' | 'stored' | 'generated';

export interface TokenResolution {
  token: string;
  /** whether the token should be written to localStorage + cookie */
  persist: boolean;
  source: TokenSource;
}

export interface ResolveTokenInput {
  /** `location.search`, with or without the leading '?' */
  search: string;
  /** token already in localStorage (or the cookie) */
  stored: string | null;
  /** `IS_MOCK` — enables the `?demo=1` / `?demo=2` reviewer shortcuts (spec 12) */
  isMock: boolean;
  generate: () => string;
}

/**
 * Identity resolution (spec 8.1):
 *   `?demo=N` in mock mode (never persisted) → `?token=<uuid>` (persisted) →
 *   stored token (re-persisted so the cookie expiry rolls forward) → a fresh UUID.
 */
export function resolveDeviceToken(input: ResolveTokenInput): TokenResolution {
  const params = new URLSearchParams(input.search.startsWith('?') ? input.search.slice(1) : input.search);

  if (input.isMock) {
    const demo = (params.get('demo') ?? '').trim();
    if (/^\d+$/.test(demo)) return { token: `demo-${demo}`, persist: false, source: 'demo' };
  }

  const fromQuery = (params.get('token') ?? '').trim();
  if (fromQuery) return { token: fromQuery, persist: true, source: 'query' };

  const stored = (input.stored ?? '').trim();
  if (stored) return { token: stored, persist: true, source: 'stored' };

  return { token: input.generate(), persist: true, source: 'generated' };
}

/** Read one cookie value out of a `document.cookie` string. */
export function readCookie(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || null;
    } catch {
      return raw || null;
    }
  }
  return null;
}

/** The `Set-Cookie`-style string used to persist the device token for 10 years, path `/`. */
export function deviceCookieString(token: string): string {
  return `${DEVICE_TOKEN_KEY}=${encodeURIComponent(token)}; path=/; max-age=${DEVICE_TOKEN_MAX_AGE}; SameSite=Lax`;
}

// ------------------------------------------------- thin browser wrappers (guarded)

function safeLocalStorageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    /* private mode / storage disabled: the cookie still carries the identity */
  }
}

/** localStorage first, then the cookie (so a cleared localStorage can still be recovered). */
export function readStoredDeviceToken(): string | null {
  const fromStorage = safeLocalStorageGet(DEVICE_TOKEN_KEY);
  if (fromStorage) return fromStorage;
  if (typeof document === 'undefined') return null;
  return readCookie(document.cookie ?? '', DEVICE_TOKEN_KEY);
}

export function persistDeviceToken(token: string): void {
  safeLocalStorageSet(DEVICE_TOKEN_KEY, token);
  try {
    if (typeof document !== 'undefined') document.cookie = deviceCookieString(token);
  } catch {
    /* ignore */
  }
}

function randomToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `tv-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Resolve (and persist) this device's token. Safe to call outside a browser. */
export function getDeviceToken(isMock: boolean): string {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const res = resolveDeviceToken({ search, stored: readStoredDeviceToken(), isMock, generate: randomToken });
  if (res.persist) persistDeviceToken(res.token);
  return res.token;
}
