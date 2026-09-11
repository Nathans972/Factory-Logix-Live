/** Row-value helpers: the wire format is always epoch milliseconds / plain numbers. */

export function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function toMsOr(value: unknown, fallback: number): number {
  const ms = toMs(value);
  return ms === null ? fallback : ms;
}

export function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toNumOr(value: unknown, fallback: number): number {
  const n = toNum(value);
  return n === null ? fallback : n;
}

export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value === 't' || value === 'true' || value === '1';
  return Boolean(value);
}

export function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** JS Date for a UTC-ms parameter (node-pg serializes Date with an explicit offset). */
export function tsParam(ms: number): Date {
  return new Date(ms);
}
