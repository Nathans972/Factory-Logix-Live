/** Formatting helpers. All wall-clock formatting takes the plant time zone explicitly. */

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = tz + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

export function formatTime(ms: number | null | undefined, tz: string, withSeconds = false): string {
  if (ms == null) return '—';
  return fmt(tz, { hour: 'numeric', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hour12: true }).format(ms);
}

export function formatTime24(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  return fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

export function formatDate(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  return fmt(tz, { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);
}

export function formatDateTime(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  return fmt(tz, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(ms);
}

export function formatIsoDate(ms: number, tz: string): string {
  const parts = fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function formatPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatNum(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

/** Grouped decimal with a fixed number of digits ("1,226.50"); an em dash when there is no value. */
export function formatDecimal(v: number | null | undefined, digits: number): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Thousands-separated integer ("1,226") for every count the design shows grouped. */
export function formatInt(v: number | null | undefined): string {
  return formatDecimal(v, 0);
}

/**
 * StdHr in the portal: one decimal ("44.2", "48.0"), which is how the product page reads standards.
 * Pass `digits = 0` where the approved design shows a whole number (the shift view).
 * The TV's own whole-number rule lives in `pages/tv/tvLogic.ts` (`formatStd`).
 */
export function formatStdHr(v: number | null | undefined, digits = 1): string {
  return formatDecimal(v, digits);
}

/** "Sep 8" — the design never shows a year inside a line of context. */
export function shortDate(ms: number | null | undefined, tz: string): string {
  if (ms == null) return '—';
  return fmt(tz, { month: 'short', day: 'numeric' }).format(ms);
}

export function formatMinutes(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Math.round(v)} min`;
}

export function formatHours(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(digits)} h`;
}

export function relativeMinutes(ms: number | null | undefined, now: number): string {
  if (ms == null) return '—';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatDays(days: number[]): string {
  if (days.length === 7) return 'Every day';
  if ([1, 2, 3, 4, 5].every((d) => days.includes(d)) && days.length === 5) return 'Mon–Fri';
  return [...days].sort().map((d) => DAY_NAMES[d]).join(' ');
}
