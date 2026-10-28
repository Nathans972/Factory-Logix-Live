import type { FlTimestampMode, LocalTime } from './domain.js';

/** All configurable settings (spec section 11). Stored as jsonb rows in `settings` keyed by property name. */
export interface Settings {
  /** Display name of the plant, shown in the portal top bar. `null` hides the slot. */
  plant_name: string | null;
  plant_timezone: string;
  fl_timestamp_mode: FlTimestampMode;
  poll_interval_seconds: number;
  poll_page_size: number;
  poll_overlap_minutes: number;
  late_data_hours: number;
  odata_timeout_seconds: number;
  breaker_failure_threshold: number;
  breaker_max_backoff_minutes: number;
  backfill_days: number;
  backfill_pause_seconds: number;
  backfill_window: { start: LocalTime; end: LocalTime };
  eligibility_minutes: number;
  neutral_minutes: number;
  idle_timeout_minutes: number;
  count_work_during_breaks: boolean;
  color_red_below: number;
  color_yellow_below: number;
  color_blue_above: number;
  std_lookback_days: number;
  std_min_units: number;
  std_min_operators: number;
  std_max_unit_minutes: number;
  session_gap_minutes: number;
  std_recompute_time: LocalTime;
  floor_idle_flag_minutes: number;
  retention_days_raw_events: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  plant_name: null,
  plant_timezone: 'America/New_York',
  fl_timestamp_mode: 'offset_present',
  poll_interval_seconds: 90,
  poll_page_size: 500,
  poll_overlap_minutes: 10,
  late_data_hours: 24,
  odata_timeout_seconds: 20,
  breaker_failure_threshold: 3,
  breaker_max_backoff_minutes: 10,
  backfill_days: 180,
  backfill_pause_seconds: 5,
  backfill_window: { start: '22:00', end: '05:00' },
  eligibility_minutes: 10,
  neutral_minutes: 5,
  idle_timeout_minutes: 30,
  count_work_during_breaks: false,
  color_red_below: 0.7,
  color_yellow_below: 0.9,
  color_blue_above: 1.05,
  std_lookback_days: 365,
  std_min_units: 20,
  std_min_operators: 2,
  std_max_unit_minutes: 120,
  session_gap_minutes: 10,
  std_recompute_time: '02:00',
  floor_idle_flag_minutes: 15,
  retention_days_raw_events: null,
};

/** The subset of settings the pure engine needs (spec section 7). */
export type EngineSettings = Pick<
  Settings,
  | 'plant_timezone'
  | 'eligibility_minutes'
  | 'neutral_minutes'
  | 'idle_timeout_minutes'
  | 'count_work_during_breaks'
  | 'color_red_below'
  | 'color_yellow_below'
  | 'color_blue_above'
  | 'std_lookback_days'
  | 'std_min_units'
  | 'std_min_operators'
  | 'std_max_unit_minutes'
  | 'session_gap_minutes'
  | 'floor_idle_flag_minutes'
>;

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  plant_timezone: DEFAULT_SETTINGS.plant_timezone,
  eligibility_minutes: DEFAULT_SETTINGS.eligibility_minutes,
  neutral_minutes: DEFAULT_SETTINGS.neutral_minutes,
  idle_timeout_minutes: DEFAULT_SETTINGS.idle_timeout_minutes,
  count_work_during_breaks: DEFAULT_SETTINGS.count_work_during_breaks,
  color_red_below: DEFAULT_SETTINGS.color_red_below,
  color_yellow_below: DEFAULT_SETTINGS.color_yellow_below,
  color_blue_above: DEFAULT_SETTINGS.color_blue_above,
  std_lookback_days: DEFAULT_SETTINGS.std_lookback_days,
  std_min_units: DEFAULT_SETTINGS.std_min_units,
  std_min_operators: DEFAULT_SETTINGS.std_min_operators,
  std_max_unit_minutes: DEFAULT_SETTINGS.std_max_unit_minutes,
  session_gap_minutes: DEFAULT_SETTINGS.session_gap_minutes,
  floor_idle_flag_minutes: DEFAULT_SETTINGS.floor_idle_flag_minutes,
};

export type SettingsKey = keyof Settings;

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

export function pickEngineSettings(s: Settings): EngineSettings {
  return {
    plant_timezone: s.plant_timezone,
    eligibility_minutes: s.eligibility_minutes,
    neutral_minutes: s.neutral_minutes,
    idle_timeout_minutes: s.idle_timeout_minutes,
    count_work_during_breaks: s.count_work_during_breaks,
    color_red_below: s.color_red_below,
    color_yellow_below: s.color_yellow_below,
    color_blue_above: s.color_blue_above,
    std_lookback_days: s.std_lookback_days,
    std_min_units: s.std_min_units,
    std_min_operators: s.std_min_operators,
    std_max_unit_minutes: s.std_max_unit_minutes,
    session_gap_minutes: s.session_gap_minutes,
    floor_idle_flag_minutes: s.floor_idle_flag_minutes,
  };
}

/** FactoryLogix connection settings (password is stored encrypted; never returned to clients). */
export interface FlConnection {
  base_url: string;
  username: string;
  /** Present only in write payloads. Read payloads set `has_password` instead. */
  password?: string;
  has_password?: boolean;
  /** Read payloads: a password is stored, but this server's ENCRYPTION_KEY cannot decrypt it, so it must be typed again. */
  password_unreadable?: boolean;
}

/**
 * True when the URL holds a user name or password (`http://svc:secret@server:6065/odata`). The
 * FactoryLogix connection refuses such a URL: it is stored and audited in clear text (only the
 * password field is encrypted), and fetch rejects it with an error that repeats it, password included.
 */
export function urlHasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

export const URL_CREDENTIALS_MESSAGE =
  'the FactoryLogix server URL must not contain a user name or password: in Admin > Connection, enter the URL without them and the password in its own field';

export const TIME_CONSTANTS = {
  HOUR_MS: 3_600_000,
  MINUTE_MS: 60_000,
  DAY_MS: 86_400_000,
  /** TV rolling window length in hours (spec 7.8) */
  ROLLING_WINDOW_HOURS: 12,
} as const;
