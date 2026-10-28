/** Watermark handling for the incremental poll (spec 4.5). Stored as text in sync_state. */
import { edmTypeToKind } from '@fld/shared';
import type { TimestampResolver } from '../mapping/extract.js';

export type WatermarkKind = 'timestamp' | 'number' | 'string';

export function watermarkKindFromEdm(edmType: string | null): WatermarkKind | null {
  if (!edmType) return null;
  const kind = edmTypeToKind(edmType);
  if (kind === 'timestamp') return 'timestamp';
  if (kind === 'number') return 'number';
  if (kind === 'string') return 'string';
  return null;
}

/** Best-effort classification from a sample value when $metadata is unavailable. */
export function watermarkKindFromValue(value: unknown): WatermarkKind {
  if (typeof value === 'number') return 'number';
  if (value instanceof Date) return 'timestamp';
  if (typeof value === 'string') {
    if (/^\d+$/.test(value.trim())) return 'number';
    if (/\d{4}-\d{2}-\d{2}/.test(value) || value.startsWith('/Date(')) return 'timestamp';
  }
  return 'string';
}

/**
 * Tracks the maximum watermark value seen during a pull. A timestamp after `notAfterMs` (the
 * poll time) does not count: one row stamped in the future (a station with a wrong clock, a
 * 9999-12-31 placeholder) would carry the watermark past rows that have not happened yet, and
 * every later poll would filter them out. The row itself is still ingested.
 */
export class WatermarkTracker {
  private maxNumeric: number | null = null;
  private maxString: string | null = null;

  constructor(
    public kind: WatermarkKind,
    private readonly timestamps: TimestampResolver,
    private readonly sourceKey: string,
    private readonly notAfterMs: number | null = null,
  ) {}

  observe(raw: unknown): void {
    if (raw === null || raw === undefined) return;
    if (this.kind === 'timestamp') {
      const ms = this.timestamps.parse(raw, `${this.sourceKey}:watermark`);
      if (ms === null || (this.notAfterMs !== null && ms > this.notAfterMs)) return;
      if (this.maxNumeric === null || ms > this.maxNumeric) this.maxNumeric = ms;
      return;
    }
    if (this.kind === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (Number.isFinite(n) && (this.maxNumeric === null || n > this.maxNumeric)) this.maxNumeric = n;
      return;
    }
    const s = String(raw);
    if (this.maxString === null || s > this.maxString) this.maxString = s;
  }

  get maxMs(): number | null {
    return this.kind === 'timestamp' ? this.maxNumeric : null;
  }

  /** Text form persisted in sync_state.watermark: ISO for timestamps, digits for ids. */
  serialize(): string | null {
    if (this.kind === 'timestamp') return this.maxNumeric === null ? null : new Date(this.maxNumeric).toISOString();
    if (this.kind === 'number') return this.maxNumeric === null ? null : String(this.maxNumeric);
    return this.maxString;
  }
}

export interface ParsedWatermark {
  ms: number | null;
  numeric: number | null;
  text: string | null;
}

export function parseStoredWatermark(stored: string | null, kind: WatermarkKind): ParsedWatermark {
  if (!stored) return { ms: null, numeric: null, text: null };
  if (kind === 'timestamp') {
    const ms = Date.parse(stored);
    return { ms: Number.isNaN(ms) ? null : ms, numeric: null, text: stored };
  }
  if (kind === 'number') {
    const n = Number(stored);
    return { ms: null, numeric: Number.isFinite(n) ? n : null, text: stored };
  }
  return { ms: null, numeric: null, text: stored };
}
