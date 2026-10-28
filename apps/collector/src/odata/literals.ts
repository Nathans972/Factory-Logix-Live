/**
 * OData literal formatting for `$filter` expressions.
 *
 * v4 (default): timestamps are bare ISO 8601 (`2025-01-01T00:00:00Z`).
 * v2/v3:        `Edm.DateTime` uses `datetime'2025-01-01T00:00:00'`,
 *               `Edm.DateTimeOffset` uses `datetimeoffset'2025-01-01T00:00:00Z'`.
 */
import { getTzOffsetMs } from '@fld/engine';
import type { FlTimestampMode } from '@fld/shared';

export type LiteralValue =
  /** `lowerBound`: the literal starts a range (`ge`) and must not leave out anything from `ms` on. */
  | { kind: 'timestamp'; ms: number; lowerBound?: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'raw'; value: string };

/** OData service version ("4.0", "2.0", ...). null => assume v4. */
export type ODataVersion = string | null;

export function majorVersion(version: ODataVersion): number {
  if (!version) return 4;
  const n = Number.parseInt(String(version).split('.')[0] ?? '4', 10);
  return Number.isFinite(n) ? n : 4;
}

/** True when the service speaks OData v2/v3 (the `datetime'...'` literal dialect). */
export function isLegacyVersion(version: ODataVersion): boolean {
  return majorVersion(version) < 4;
}

export function quoteString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function isoNoMillis(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function isoNaive(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '');
}

/** Plant wall-clock time of an instant, `YYYY-MM-DDTHH:MM:SS` with no offset. */
export function isoLocalNaive(ms: number, timezone: string): string {
  return isoNaive(ms + getTzOffsetMs(timezone, ms));
}

const HOUR_MS = 3_600_000;

/**
 * Plant wall-clock time for a lower bound at `ms`: no instant from `ms` on reads earlier. On the
 * fall-back night an instant in the first pass through the repeated hour is followed by the second
 * pass, which reads earlier on the wall clock, so it is written with the offset in force after the
 * change: an hour earlier, which reaches back over the whole repeated hour.
 */
export function isoLocalNaiveFrom(ms: number, timezone: string): string {
  return isoNaive(ms + Math.min(getTzOffsetMs(timezone, ms), getTzOffsetMs(timezone, ms + HOUR_MS)));
}

/**
 * How FactoryLogix writes timestamps (`fl_timestamp_mode`). In `local_no_offset` mode the naive
 * `datetime'...'` literal (v2/v3 Edm.DateTime, or an untyped field) carries plant wall-clock time,
 * the same form the service returns. Literals with an explicit offset (v4, Edm.DateTimeOffset)
 * stay UTC: they say which instant they mean either way.
 */
export interface TimestampLiteralOptions {
  mode?: FlTimestampMode;
  timezone?: string;
}

export function formatTimestampLiteral(
  ms: number,
  edmType: string | null,
  version: ODataVersion,
  opts: TimestampLiteralOptions = {},
  lowerBound = false,
): string {
  const type = (edmType ?? '').replace(/^Edm\./, '');
  if (type === 'Date') return new Date(ms).toISOString().slice(0, 10);
  if (isLegacyVersion(version)) {
    if (type === 'DateTimeOffset') return `datetimeoffset'${isoNoMillis(ms)}'`;
    if (opts.mode === 'local_no_offset' && opts.timezone) {
      return `datetime'${lowerBound ? isoLocalNaiveFrom(ms, opts.timezone) : isoLocalNaive(ms, opts.timezone)}'`;
    }
    // v2 default (and Edm.DateTime): naive UTC inside a datetime literal.
    return `datetime'${isoNaive(ms)}'`;
  }
  return isoNoMillis(ms);
}

export function formatNumberLiteral(value: number, edmType: string | null, version: ODataVersion): string {
  const type = (edmType ?? '').replace(/^Edm\./, '');
  if (isLegacyVersion(version)) {
    if (type === 'Int64') return `${value}L`;
    if (type === 'Decimal') return `${value}M`;
  }
  return String(value);
}

export function formatLiteral(
  value: LiteralValue,
  edmType: string | null,
  version: ODataVersion,
  opts: TimestampLiteralOptions = {},
): string {
  switch (value.kind) {
    case 'timestamp':
      return formatTimestampLiteral(value.ms, edmType, version, opts, value.lowerBound);
    case 'string':
      return quoteString(value.value);
    case 'number':
      return formatNumberLiteral(value.value, edmType, version);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'raw':
      return value.value;
    default: {
      const never: never = value;
      throw new Error(`unsupported literal ${JSON.stringify(never)}`);
    }
  }
}

/** `field ge <literal>` / `field le <literal>` helpers. */
export function cmp(field: string, op: 'ge' | 'gt' | 'le' | 'lt' | 'eq', literal: string): string {
  return `${field} ${op} ${literal}`;
}

export function andAll(parts: (string | null | undefined)[]): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0] as string;
  return kept.map((p) => `(${p})`).join(' and ');
}
