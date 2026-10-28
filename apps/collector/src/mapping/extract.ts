/**
 * Row -> normalized record using the MappingConfig (spec 4.8) and timestamp parsing
 * per `fl_timestamp_mode` (spec 5.5).
 */
import { localToUtc as engineLocalToUtc } from '@fld/engine';
import { DATASET_SPECS, type DatasetMapping, type DatasetName, type FieldType, type FlTimestampMode } from '@fld/shared';

export type FieldValue = string | number | boolean | null;

export type LocalToUtcFn = (
  tz: string,
  parts: { year: number; month: number; day: number; hour: number; minute?: number; second?: number },
  opts?: { ambiguous?: 'earlier' | 'later' },
) => number;

export interface NaiveParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const NAIVE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,7}))?)?)?$/;
const OFFSET_RE = /(?:Z|z|[+-]\d{2}:?\d{2})$/;
const MS_DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** ISO-8601-ish string with an explicit UTC offset? */
export function hasOffset(value: string): boolean {
  return OFFSET_RE.test(value.trim());
}

export function parseNaiveParts(value: string): NaiveParts | null {
  const m = NAIVE_RE.exec(value.trim());
  if (!m) return null;
  const frac = m[7] ?? '';
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? '0'),
    minute: Number(m[5] ?? '0'),
    second: Number(m[6] ?? '0'),
    millisecond: frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0,
  };
}

export function naiveToUtcMs(p: NaiveParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);
}

export interface TimestampResolverOptions {
  mode: FlTimestampMode;
  timezone: string;
  /** Injected for tests; defaults to the engine implementation. */
  localToUtc?: LocalToUtcFn;
  /** Called at most once per warning code. */
  onWarn?: (code: string, message: string) => void;
}

/**
 * Parses FactoryLogix timestamps. Keeps the last naive value per source so that the
 * `local_no_offset` fall-back hour can be disambiguated by monotonic ordering (spec 5.5).
 */
export class TimestampResolver {
  mode: FlTimestampMode;
  timezone: string;
  private readonly localToUtc: LocalToUtcFn;
  private readonly onWarn?: (code: string, message: string) => void;
  private readonly warned = new Set<string>();
  private readonly lastNaive = new Map<string, number>();

  /** More backwards movement than this means we crossed into the repeated hour. */
  static readonly MONOTONIC_TOLERANCE_MS = 30 * 60 * 1000;

  constructor(opts: TimestampResolverOptions) {
    this.mode = opts.mode;
    this.timezone = opts.timezone;
    this.localToUtc = opts.localToUtc ?? engineLocalToUtc;
    this.onWarn = opts.onWarn;
  }

  configure(mode: FlTimestampMode, timezone: string): void {
    if (mode !== this.mode || timezone !== this.timezone) {
      this.mode = mode;
      this.timezone = timezone;
      this.lastNaive.clear();
    }
  }

  /** Forget the monotonic cursor (used between backfill chunks / datasets). */
  resetSource(sourceKey: string): void {
    this.lastNaive.delete(sourceKey);
  }

  private warn(code: string, message: string): void {
    if (this.warned.has(code)) return;
    this.warned.add(code);
    this.onWarn?.(code, message);
  }

  private resolveNaive(parts: NaiveParts, sourceKey: string): number {
    const naiveMs = naiveToUtcMs(parts);
    if (this.mode === 'local_no_offset') {
      const previous = this.lastNaive.get(sourceKey);
      const ambiguous: 'earlier' | 'later' =
        previous !== undefined && naiveMs < previous - TimestampResolver.MONOTONIC_TOLERANCE_MS ? 'later' : 'earlier';
      this.lastNaive.set(sourceKey, naiveMs);
      const utc = this.localToUtc(
        this.timezone,
        { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second },
        { ambiguous },
      );
      return utc + parts.millisecond;
    }
    if (this.mode === 'offset_present') {
      this.warn(
        'missing_offset',
        'fl_timestamp_mode is offset_present but FactoryLogix returned timestamps without an offset; interpreting them as UTC',
      );
    }
    return naiveMs;
  }

  parse(value: unknown, sourceKey = 'default'): number | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;

    const text = value.trim();
    if (!text) return null;

    const msDate = MS_DATE_RE.exec(text);
    if (msDate) {
      const ms = Number(msDate[1]);
      if (!Number.isFinite(ms)) return null;
      // OData v2 JSON writes an offset-less Edm.DateTime as its wall-clock value counted as if it
      // were UTC. In local_no_offset mode that wall clock is plant time; a trailing offset
      // (`/Date(ms+0300)/`) means the milliseconds are a real UTC instant.
      if (this.mode === 'local_no_offset' && !msDate[2]) {
        const d = new Date(ms);
        return this.resolveNaive(
          {
            year: d.getUTCFullYear(),
            month: d.getUTCMonth() + 1,
            day: d.getUTCDate(),
            hour: d.getUTCHours(),
            minute: d.getUTCMinutes(),
            second: d.getUTCSeconds(),
            millisecond: d.getUTCMilliseconds(),
          },
          sourceKey,
        );
      }
      return ms;
    }

    if (hasOffset(text)) {
      const parsed = Date.parse(text);
      if (!Number.isNaN(parsed)) return parsed;
    }

    const parts = parseNaiveParts(text);
    if (parts) return this.resolveNaive(parts, sourceKey);

    const fallback = Date.parse(text);
    if (!Number.isNaN(fallback)) return fallback;
    this.warn('unparsable_timestamp', `could not parse FactoryLogix timestamp ${text.slice(0, 40)}`);
    return null;
  }
}

/** Read a source field from a row; tolerates case differences and A/B navigation paths. */
export function getField(row: Record<string, unknown>, field: string): unknown {
  if (field in row) return row[field];
  const lower = field.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === lower) return row[key];
  }
  if (field.includes('/') || field.includes('.')) {
    const segments = field.split(/[/.]/);
    let current: unknown = row;
    for (const segment of segments) {
      if (!current || typeof current !== 'object') return undefined;
      const obj = current as Record<string, unknown>;
      if (segment in obj) {
        current = obj[segment];
        continue;
      }
      const lowerSeg = segment.toLowerCase();
      const match = Object.keys(obj).find((k) => k.toLowerCase() === lowerSeg);
      if (match === undefined) return undefined;
      current = obj[match];
    }
    return current;
  }
  return undefined;
}

export function toStringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function toNumberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/,/g, '');
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const TRUE_VALUES = new Set(['true', 't', 'y', 'yes', '1', 'rework']);
const FALSE_VALUES = new Set(['false', 'f', 'n', 'no', '0', '']);

export function toBooleanValue(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (TRUE_VALUES.has(t)) return true;
    if (FALSE_VALUES.has(t)) return false;
    return null;
  }
  return null;
}

/** Natural key = the mapped key fields source values joined with a pipe (spec 6.1). */
export function buildNaturalKey(row: Record<string, unknown>, keyFields: string[]): string {
  return keyFields
    .map((field) => {
      const value = getField(row, field);
      if (value === null || value === undefined) return '';
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value).trim();
    })
    .join('|');
}

const FIELD_TYPES: Record<string, Record<string, FieldType>> = Object.fromEntries(
  DATASET_SPECS.map((spec) => [spec.name, Object.fromEntries(spec.fields.map((f) => [f.name, f.type]))]),
);

export function fieldTypesFor(dataset: DatasetName): Record<string, FieldType> {
  return FIELD_TYPES[dataset] ?? {};
}

export interface ExtractedRecord {
  natural_key: string;
  values: Record<string, FieldValue>;
  raw: Record<string, unknown>;
}

export interface ExtractOptions {
  timestamps: TimestampResolver;
  /** Monotonic-cursor bucket; defaults to the dataset name. */
  sourceKey?: string;
}

/**
 * Extract one normalized record. Unmapped (null) and missing source fields become null;
 * every target field of the dataset is present in `values`.
 */
export function extractRecord(
  dataset: DatasetName,
  row: Record<string, unknown>,
  mapping: DatasetMapping,
  opts: ExtractOptions,
): ExtractedRecord {
  const types = fieldTypesFor(dataset);
  const sourceKey = opts.sourceKey ?? dataset;
  const values: Record<string, FieldValue> = {};

  for (const [target, type] of Object.entries(types)) {
    const sourceField = mapping.fields[target];
    if (!sourceField) {
      values[target] = null;
      continue;
    }
    const raw = getField(row, sourceField);
    switch (type) {
      case 'string':
        values[target] = toStringValue(raw);
        break;
      case 'number':
        values[target] = toNumberValue(raw);
        break;
      case 'boolean':
        values[target] = toBooleanValue(raw);
        break;
      case 'timestamp':
        values[target] = opts.timestamps.parse(raw, `${sourceKey}:${target}`);
        break;
      default:
        values[target] = null;
    }
  }

  return { natural_key: buildNaturalKey(row, mapping.key), values, raw: row };
}

export function str(values: Record<string, FieldValue>, key: string): string | null {
  const v = values[key];
  if (typeof v === 'string') return v;
  return v === null || v === undefined ? null : String(v);
}

export function num(values: Record<string, FieldValue>, key: string): number | null {
  const v = values[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function bool(values: Record<string, FieldValue>, key: string): boolean | null {
  const v = values[key];
  return typeof v === 'boolean' ? v : null;
}

/** Source field names needed for a dataset pull: mapped fields + key fields (+ watermark). */
export function selectFieldsFor(mapping: DatasetMapping, extra: (string | null | undefined)[] = []): string[] {
  const out = new Set<string>();
  for (const value of Object.values(mapping.fields)) {
    if (value) out.add(value);
  }
  for (const key of mapping.key) out.add(key);
  if (mapping.watermark_field) out.add(mapping.watermark_field);
  for (const field of extra) {
    if (field) out.add(field);
  }
  return [...out];
}
