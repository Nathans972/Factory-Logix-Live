import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from '../src/settings.js';
import { settingsPatchSchema, settingsSchema } from '../src/schemas.js';

describe('settings validation', () => {
  it('accepts the default settings', () => {
    const result = settingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('covers every settings key', () => {
    expect(Object.keys(settingsSchema.shape).sort()).toEqual([...SETTINGS_KEYS].sort());
  });

  it.each([
    ['poll_interval_seconds', 29],
    ['poll_interval_seconds', 601],
    ['poll_interval_seconds', 90.5],
    ['poll_page_size', 49],
    ['late_data_hours', -1],
    ['late_data_hours', 169],
    ['breaker_failure_threshold', 0],
    ['backfill_days', 3651],
    ['backfill_pause_seconds', 601],
    ['eligibility_minutes', 61],
    ['idle_timeout_minutes', 0],
    ['color_red_below', 2.5],
    ['color_blue_above', -0.1],
    ['std_min_units', 0],
    ['retention_days_raw_events', 0],
  ] as const)('rejects %s = %s', (key, value) => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, [key]: value }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it('rejects malformed times, time zones and modes', () => {
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, std_recompute_time: '24:00' }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, backfill_window: { start: '1:00', end: '05:00' } }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, plant_timezone: 'Mars/Olympus_Mons' }).success).toBe(false);
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, fl_timestamp_mode: 'local' }).success).toBe(false);
  });

  it('accepts in-range edge values', () => {
    expect(settingsPatchSchema.safeParse({ poll_interval_seconds: 30, late_data_hours: 0, retention_days_raw_events: null }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ backfill_window: { start: '22:00', end: '05:00' } }).success).toBe(true);
  });
});
