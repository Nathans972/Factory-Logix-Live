/**
 * OData literal formatting for `$filter` expressions.
 *
 * v4 (default): timestamps are bare ISO 8601 (`2025-01-01T00:00:00Z`).
 * v2/v3:        `Edm.DateTime` uses `datetime'2025-01-01T00:00:00'`,
 *               `Edm.DateTimeOffset` uses `datetimeoffset'2025-01-01T00:00:00Z'`.
 */

export type LiteralValue =
  | { kind: 'timestamp'; ms: number }
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

export function formatTimestampLiteral(ms: number, edmType: string | null, version: ODataVersion): string {
  const type = (edmType ?? '').replace(/^Edm\./, '');
  if (type === 'Date') return new Date(ms).toISOString().slice(0, 10);
  if (isLegacyVersion(version)) {
    if (type === 'DateTimeOffset') return `datetimeoffset'${isoNoMillis(ms)}'`;
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

export function formatLiteral(value: LiteralValue, edmType: string | null, version: ODataVersion): string {
  switch (value.kind) {
    case 'timestamp':
      return formatTimestampLiteral(value.ms, edmType, version);
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
