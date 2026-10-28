import { describe, expect, it } from 'vitest';
import { TimestampResolver } from '../src/mapping/extract.js';
import {
  WatermarkTracker,
  parseStoredWatermark,
  watermarkKindFromEdm,
  watermarkKindFromValue,
} from '../src/sync/watermark.js';

function utcResolver(): TimestampResolver {
  return new TimestampResolver({ mode: 'utc', timezone: 'UTC' });
}

describe('watermarkKindFromEdm', () => {
  it('maps timestamp, numeric and string EDM types', () => {
    expect(watermarkKindFromEdm('Edm.DateTimeOffset')).toBe('timestamp');
    expect(watermarkKindFromEdm('Edm.DateTime')).toBe('timestamp');
    expect(watermarkKindFromEdm('Edm.Int64')).toBe('number');
    expect(watermarkKindFromEdm('Edm.Decimal')).toBe('number');
    expect(watermarkKindFromEdm('Edm.String')).toBe('string');
    expect(watermarkKindFromEdm('Edm.Guid')).toBe('string');
  });

  it('returns null for missing or unusable types', () => {
    expect(watermarkKindFromEdm(null)).toBeNull();
    expect(watermarkKindFromEdm('')).toBeNull();
    expect(watermarkKindFromEdm('Edm.Boolean')).toBeNull();
    expect(watermarkKindFromEdm('Edm.Binary')).toBeNull();
  });
});

describe('watermarkKindFromValue', () => {
  it('classifies numbers and digit-only strings as numeric', () => {
    expect(watermarkKindFromValue(42)).toBe('number');
    expect(watermarkKindFromValue('12345')).toBe('number');
    expect(watermarkKindFromValue(' 77 ')).toBe('number');
  });

  it('classifies dates, ISO strings and /Date()/ values as timestamps', () => {
    expect(watermarkKindFromValue(new Date())).toBe('timestamp');
    expect(watermarkKindFromValue('2025-03-09T06:30:00Z')).toBe('timestamp');
    expect(watermarkKindFromValue('2025-03-09 06:30:00')).toBe('timestamp');
    expect(watermarkKindFromValue('/Date(1735689600000)/')).toBe('timestamp');
  });

  it('falls back to string for anything else', () => {
    expect(watermarkKindFromValue('ABC-001')).toBe('string');
    expect(watermarkKindFromValue(null)).toBe('string');
    expect(watermarkKindFromValue(true)).toBe('string');
  });
});

describe('WatermarkTracker', () => {
  it('serializes null before anything is observed', () => {
    for (const kind of ['timestamp', 'number', 'string'] as const) {
      const tracker = new WatermarkTracker(kind, utcResolver(), 'ops');
      expect(tracker.serialize()).toBeNull();
      expect(tracker.maxMs).toBeNull();
    }
  });

  it('keeps the latest timestamp regardless of arrival order and serializes it as ISO', () => {
    const tracker = new WatermarkTracker('timestamp', utcResolver(), 'unit_steps');
    tracker.observe('2025-07-04T13:45:30');
    tracker.observe('2025-07-04T15:00:00');
    tracker.observe('2025-07-04T14:00:00');
    expect(tracker.maxMs).toBe(Date.UTC(2025, 6, 4, 15, 0, 0));
    expect(tracker.serialize()).toBe('2025-07-04T15:00:00.000Z');
  });

  it('ignores null, undefined and unparseable timestamps', () => {
    const tracker = new WatermarkTracker('timestamp', utcResolver(), 'unit_steps');
    tracker.observe(null);
    tracker.observe(undefined);
    tracker.observe('not a date');
    expect(tracker.serialize()).toBeNull();
    tracker.observe('2025-01-01T00:00:00Z');
    tracker.observe('garbage');
    expect(tracker.serialize()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('ignores timestamps after the poll time, so one future-dated row cannot carry the watermark past it', () => {
    const now = Date.UTC(2026, 5, 2, 12, 0, 0);
    const tracker = new WatermarkTracker('timestamp', utcResolver(), 'unit_steps', now);
    tracker.observe('2026-06-03T11:59:00Z'); // a handheld whose clock is a day ahead
    tracker.observe('9999-12-31T00:00:00Z'); // a placeholder date
    expect(tracker.serialize()).toBeNull();
    tracker.observe('2026-06-02T11:58:00Z');
    expect(tracker.serialize()).toBe('2026-06-02T11:58:00.000Z');
    tracker.observe('2026-06-02T12:00:00Z'); // the poll time itself still counts
    expect(tracker.maxMs).toBe(now);
  });

  it('compares numeric ids as numbers, not text, and skips non-numeric values', () => {
    const tracker = new WatermarkTracker('number', utcResolver(), 'defects');
    tracker.observe('9');
    tracker.observe(' 10 ');
    tracker.observe('abc');
    tracker.observe(Number.NaN);
    expect(tracker.serialize()).toBe('10');
    expect(tracker.maxMs).toBeNull();
  });

  it('keeps the lexically largest value for string watermarks', () => {
    const tracker = new WatermarkTracker('string', utcResolver(), 'routes');
    tracker.observe('B-002');
    tracker.observe('C-001');
    tracker.observe('A-999');
    expect(tracker.serialize()).toBe('C-001');
    expect(tracker.maxMs).toBeNull();
  });
});

describe('parseStoredWatermark', () => {
  it('returns all nulls when nothing is stored', () => {
    expect(parseStoredWatermark(null, 'timestamp')).toEqual({ ms: null, numeric: null, text: null });
    expect(parseStoredWatermark('', 'number')).toEqual({ ms: null, numeric: null, text: null });
  });

  it('parses stored ISO timestamps and keeps the original text', () => {
    expect(parseStoredWatermark('2025-07-04T15:00:00.000Z', 'timestamp')).toEqual({
      ms: Date.UTC(2025, 6, 4, 15, 0, 0),
      numeric: null,
      text: '2025-07-04T15:00:00.000Z',
    });
  });

  it('returns a null ms for a corrupt stored timestamp instead of NaN', () => {
    expect(parseStoredWatermark('yesterday-ish', 'timestamp')).toEqual({
      ms: null,
      numeric: null,
      text: 'yesterday-ish',
    });
  });

  it('parses stored numeric ids and rejects non-numeric text', () => {
    expect(parseStoredWatermark('42', 'number')).toEqual({ ms: null, numeric: 42, text: '42' });
    expect(parseStoredWatermark('4x2', 'number')).toEqual({ ms: null, numeric: null, text: '4x2' });
  });

  it('passes string watermarks through as text', () => {
    expect(parseStoredWatermark('C-001', 'string')).toEqual({ ms: null, numeric: null, text: 'C-001' });
  });

  it('round-trips what the tracker serializes', () => {
    const ts = new WatermarkTracker('timestamp', utcResolver(), 'unit_steps');
    ts.observe('2025-11-02T06:05:00Z');
    expect(parseStoredWatermark(ts.serialize(), 'timestamp').ms).toBe(ts.maxMs);

    const num = new WatermarkTracker('number', utcResolver(), 'defects');
    num.observe(1234567);
    expect(parseStoredWatermark(num.serialize(), 'number').numeric).toBe(1234567);
  });
});
