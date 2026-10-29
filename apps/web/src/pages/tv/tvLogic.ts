/**
 * Pure helpers for the TV display (spec 8).
 *
 * Everything in this module is side-effect free and unit tested (`tvLogic.test.ts`), except the
 * three thin wrappers at the bottom that touch `window` / `localStorage` / `document.cookie`.
 * Those guard every browser access so the module can also be imported in a node test environment.
 */
import { TV_CELL_TEXT, TV_COLORS, type CellColor, type SseEvent, type TvDashboard, type TvRow, type TvState } from '@fld/shared';

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

/** StdHr / StdDay display: rounded to the nearest whole number; an em dash when unavailable (spec 15 scenario 11). */
export function formatStd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return String(Math.round(v));
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

/** Mirrors `tvRegisterSchema`: the API only registers a UUID (`displays.device_token` is a uuid column). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Outside mock mode a token that is not a UUID can never register, so it is skipped, never adopted
 * or persisted: a bookmark typed with the pairing code (`?token=4821`) falls through to the stored
 * token, and a stored `tv-…` token (older builds wrote one on TVs that loaded the page over plain
 * HTTP) is replaced.
 */
export function resolveDeviceToken(input: ResolveTokenInput): TokenResolution {
  const params = new URLSearchParams(input.search.startsWith('?') ? input.search.slice(1) : input.search);
  // The mock DataSource accepts any token.
  const usable = (token: string) => token !== '' && (input.isMock || UUID_RE.test(token));

  if (input.isMock) {
    const demo = (params.get('demo') ?? '').trim();
    if (/^\d+$/.test(demo)) return { token: `demo-${demo}`, persist: false, source: 'demo' };
  }

  const fromQuery = (params.get('token') ?? '').trim();
  if (usable(fromQuery)) return { token: fromQuery, persist: true, source: 'query' };

  const stored = (input.stored ?? '').trim();
  if (usable(stored)) return { token: stored, persist: true, source: 'stored' };

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

/**
 * A random v4 UUID. Built from `crypto.getRandomValues()` because `crypto.randomUUID()` only exists
 * in secure contexts (HTTPS or localhost) and TVs load the page over plain HTTP; one path everywhere,
 * so development exercises what the TVs run. No Math.random fallback: the token is the TV's only
 * credential.
 */
function randomToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Resolve (and persist) this device's token. Safe to call outside a browser. */
export function getDeviceToken(isMock: boolean): string {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  const res = resolveDeviceToken({ search, stored: readStoredDeviceToken(), isMock, generate: randomToken });
  if (res.persist) persistDeviceToken(res.token);
  return res.token;
}

/**
 * Operator label for the TV: the FactoryLogix user name (e.g. "NSessions"). When the id is opaque
 * (an email or a number) or is a full name with spaces, derive first initial + last name from the
 * best available name so the column always reads like a user name.
 */
export function operatorLabel(operator_id: string | null, operator_name: string | null): string {
  if (operator_id === null) return '';
  const opaque = operator_id.includes('@') || /^\d+$/.test(operator_id);
  const source = (opaque && operator_name ? operator_name : operator_id).trim();
  const parts = source.split(/\s+/);
  if (parts.length < 2) return source;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  return `${first.charAt(0).toUpperCase()}${last}`;
}

export const MULTIPLE_OPERATORS = 'Multiple Operators';

/** Operator column text for a row: the single operator's user name, or "Multiple Operators". */
export function rowOperatorLabel(row: Pick<TvRow, 'operator_id' | 'operator_name' | 'operators'>): string {
  if (row.operators.length > 1) return MULTIPLE_OPERATORS;
  const id = row.operator_id ?? row.operators[0] ?? null;
  return operatorLabel(id, row.operator_name);
}

// ---------------------------------------------------------------- live refresh (spec 8.4)

/**
 * Whether a live event is a reason for the TV to fetch its state again. Every page gets a
 * `display_updated` for every display, including each new TV that registers (no login needed), so
 * a TV acts only on its own display's, or on any while it does not know which display it is yet.
 */
export function shouldRefetch(event: SseEvent, displayId: number | null): boolean {
  if (event.type === 'display_updated') return displayId === null || event.display_id === displayId;
  return event.type === 'data_updated' || event.type === 'sync_health';
}

// ---------------------------------------------------------------- screen selection (spec 8.2)

/** The "Data delayed since …" banner input: shown while the collector is behind, with the last success time. */
export function tvDelay(state: TvState | null): { delayed: boolean; delayedSince: number | null } {
  if (!state?.sync.delayed) return { delayed: false, delayedSince: null };
  return { delayed: true, delayedSince: state.sync.delayed_since ?? state.sync.last_success_at ?? null };
}

/**
 * The dashboard to keep after a successful response. A transient build error on the same job
 * keeps the last one on screen; anything else (new job, unassigned, not found) follows the server.
 */
export function nextDashboard(prev: TvDashboard | null, next: TvState): TvDashboard | null {
  if (next.dashboard) return next.dashboard;
  if (next.job_status === 'error' && prev && prev.job.job_number === next.display?.job_number) return prev;
  return null;
}

export type TvMessageLine = { text: string; kind: 'title' | 'sub' | 'code' };

export type TvScreen = { kind: 'dashboard'; dashboard: TvDashboard } | { kind: 'message'; lines: TvMessageLine[] };

/** Which of the spec 8.2 states the TV shows, from the last good state and dashboard. */
export function tvScreen(input: { state: TvState | null; dashboard: TvDashboard | null; loading: boolean; token: string }): TvScreen {
  const { state, loading, token } = input;
  const message = (...lines: TvMessageLine[]): TvScreen => ({ kind: 'message', lines });

  // No response yet at all.
  if (state == null) {
    if (loading) return message({ text: 'Connecting…', kind: 'title' });
    return message({ text: 'Dashboard unavailable', kind: 'title' }, { text: `Device ${token.slice(0, 8)}`, kind: 'sub' });
  }

  // Unclaimed: pairing screen (spec 8.1).
  if (state.status === 'unclaimed') {
    return message(
      { text: 'This TV is', kind: 'sub' },
      { text: state.pairing_code, kind: 'code' },
      { text: 'Claim it in the admin portal.', kind: 'title' },
      { text: state.admin_url, kind: 'sub' },
    );
  }

  const name = { text: state.display?.name ?? 'Unnamed display', kind: 'sub' } as const;
  const job = state.display?.job_number ?? null;

  // Assigned: the dashboard. `input.dashboard` is the last successfully fetched one, so it
  // survives a backend outage (the banner explains the staleness).
  const dashboard = state.status === 'assigned' ? (input.dashboard ?? state.dashboard) : null;
  if (dashboard) return { kind: 'dashboard', dashboard };

  if (state.status === 'assigned' && job) {
    // Assigned to a job FactoryLogix has not sent yet: it appears once the collector ingests it.
    if (state.job_status === 'not_found') return message({ text: `Waiting for data for job ${job}`, kind: 'title' }, name);
    if (state.job_status === 'error') return message({ text: `Dashboard unavailable for job ${job}`, kind: 'title' }, name);
  }

  // Claimed but no job assigned.
  return message(
    { text: 'No job assigned', kind: 'title' },
    name,
    { text: `Code ${state.display?.pairing_code ?? state.pairing_code}`, kind: 'sub' },
  );
}
