/**
 * REST API request/response DTOs. See docs/API.md for the endpoint list.
 * The web app's DataSource interface mirrors these so the mock and real backends are interchangeable.
 */
import type {
  AuditEntry,
  BreakDef,
  Display,
  Pin,
  PinMode,
  Role,
  ShiftDef,
  ShiftInstance,
  StandardAdjustment,
  StandardOverride,
  SyncStatus,
  User,
  UtcMs,
  WorkOrder,
} from './domain.js';
import type { TvDashboard } from './engine-types.js';
import type { FlConnection, Settings } from './settings.js';
import type { DatasetName, MappingConfig, ODataMetadata } from './mapping.js';

// ---------- Health / sync ----------

export interface SourceSyncState {
  source: DatasetName | string;
  watermark: string | null;
  last_success_at: UtcMs | null;
  last_error: string | null;
  consecutive_failures: number;
  rows_last_poll: number | null;
  duration_ms_last_poll: number | null;
}

export interface BackfillProgress {
  /** `recoloring`: the download finished; standards are recomputed and hour cells re-colored day by day. */
  status: 'idle' | 'scheduled' | 'running' | 'paused' | 'recoloring' | 'done' | 'error';
  requested_now: boolean;
  days_total: number;
  days_done: number;
  current_day: string | null;
  /** First plant-local day (YYYY-MM-DD) of the range, fixed when the backfill starts. Absent in older saved progress. */
  first_day?: string | null;
  /** Standards were recomputed after the download (recoloring phase). */
  standards_done?: boolean;
  /** Days whose hour cells were recomputed with standards (recoloring phase). */
  recolor_days_done?: number;
  started_at: UtcMs | null;
  finished_at: UtcMs | null;
  error: string | null;
}

export interface SyncHealth {
  status: SyncStatus;
  last_success_at: UtcMs | null;
  last_error: string | null;
  consecutive_failures: number;
  breaker_open_until: UtcMs | null;
  /** true when last success is older than 3x poll interval */
  delayed: boolean;
  delayed_since: UtcMs | null;
  poll_interval_seconds: number;
  sources: SourceSyncState[];
  backfill: BackfillProgress | null;
  collector_running: boolean;
}

export interface SyncLogEntry {
  id: number;
  source: string;
  started_at: UtcMs;
  finished_at: UtcMs | null;
  rows: number | null;
  /** Rows written to the normalized tables; null while running or for pulls logged before migration 0005. */
  ingested: number | null;
  /** Rows dropped (required field missing, product or operation unresolved); null as for `ingested`. */
  skipped: number | null;
  status: 'ok' | 'error' | 'running';
  error: string | null;
}

export interface AppHealth {
  ok: boolean;
  db: boolean;
  version: string;
  server_time: UtcMs;
  plant_timezone: string;
  /** Plant display name for the portal top bar (`settings.plant_name`); null when unset. */
  plant_name: string | null;
  needs_setup: boolean;
  demo: boolean;
}

// ---------- Auth / setup ----------

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthMe {
  user: User | null;
}

export interface SetupStatus {
  needs_setup: boolean;
  steps: {
    admin_user: boolean;
    timezone: boolean;
    connection: boolean;
    mapping: boolean;
    shifts: boolean;
    breaks: boolean;
    backfill: boolean;
  };
}

export interface SetupAdminRequest {
  username: string;
  password: string;
}

// ---------- TV ----------

export type TvStatus = 'unclaimed' | 'unassigned' | 'assigned';

export type TvJobStatus = 'ok' | 'not_found' | 'error';

export interface TvRegisterRequest {
  device_token: string;
}

export interface TvState {
  status: TvStatus;
  device_token: string;
  pairing_code: string;
  display: Display | null;
  dashboard: TvDashboard | null;
  /**
   * Why `dashboard` is null for an assigned display: `not_found` = the job is not ingested yet
   * (the TV says "Waiting for data for job …"), `error` = the dashboard could not be built.
   * `ok` when the dashboard was built; null when no job is assigned.
   */
  job_status: TvJobStatus | null;
  sync: Pick<SyncHealth, 'status' | 'delayed' | 'delayed_since' | 'last_success_at'>;
  server_time: UtcMs;
  plant_timezone: string;
  admin_url: string;
}

// ---------- SSE ----------

/**
 * `/api/events` needs no login, so an event must never carry a TV's `device_token`: it is the only
 * credential the TV endpoints check. A TV refetches its state on a `display_updated` for its own
 * `display_id` only: one is sent for every display, each new TV that registers included.
 */
export type SseEvent =
  | { type: 'data_updated'; at: UtcMs; hours: UtcMs[] }
  | { type: 'display_updated'; at: UtcMs; display_id: number }
  | { type: 'sync_health'; at: UtcMs; status: SyncStatus; delayed: boolean }
  | { type: 'settings_updated'; at: UtcMs }
  | { type: 'heartbeat'; at: UtcMs };

// ---------- Portal ----------

export interface ShiftInstanceListItem extends ShiftInstance {
  in_progress: boolean;
}

export interface ShiftPickerResponse {
  current: ShiftInstance | null;
  most_recent: ShiftInstance | null;
  shifts: ShiftDef[];
}

export interface JobListItem extends WorkOrder {
  qty_complete_effective: number;
  progress: number;
  last_activity_at: UtcMs | null;
  active: boolean;
}

export interface JobListResponse {
  jobs: JobListItem[];
}

export interface OperatorListItem {
  operator_id: string;
  display_name: string | null;
  last_seen_at: UtcMs | null;
}

export interface ProductListItem {
  product_number: string;
  name: string | null;
  operations: number;
  standards_computed: number;
}

export interface CreateAdjustmentRequest {
  scope: 'global' | 'product' | 'operation' | 'product_operation';
  product_number?: string | null;
  operation?: string | null;
  percent: number;
  note: string;
}

export interface CreateOverrideRequest {
  scope: 'product' | 'product_operation';
  product_number: string;
  operation?: string | null;
  std_hr: number;
  note: string;
}

export interface CreatePinRequest {
  operator_id: string;
  job_number: string;
  operation?: string | null;
  mode: PinMode;
  expires_at?: UtcMs | null;
}

export interface PinListResponse {
  pins: Pin[];
}

// ---------- Admin ----------

export interface ClaimDisplayRequest {
  pairing_code: string;
  name: string;
  job_number?: string | null;
  group_operators?: boolean;
  show_std_day?: boolean;
  show_gauge?: boolean;
  shift_length_hours?: number;
}

export interface UpdateDisplayRequest {
  name?: string;
  job_number?: string | null;
  group_operators?: boolean;
  show_std_day?: boolean;
  show_gauge?: boolean;
  shift_length_hours?: number;
}

/** Manager-level job change for one TV (PUT /api/displays/:id/job). */
export interface SetDisplayJobRequest {
  /** `null` leaves the TV unassigned */
  job_number: string | null;
}

export interface RepairDisplayRequest {
  /** the new pairing code shown on the TV */
  pairing_code: string;
}

export type ShiftWrite = Omit<ShiftDef, 'id'>;
export type BreakWrite = Omit<BreakDef, 'id'>;

export interface SettingsResponse {
  settings: Settings;
}

export type SettingsPatch = Partial<Settings>;

export interface ConnectionResponse {
  connection: FlConnection;
}

export interface ConnectionTestResult {
  ok: boolean;
  error: string | null;
  metadata: ODataMetadata | null;
  latency_ms: number | null;
}

export interface MappingResponse {
  mapping: MappingConfig | null;
  metadata: ODataMetadata | null;
}

export interface MappingPreviewRequest {
  mapping: MappingConfig;
  dataset: DatasetName;
}

export interface MappingPreviewResult {
  dataset: DatasetName;
  ok: boolean;
  error: string | null;
  query: string;
  rows: Record<string, unknown>[];
  checks: {
    distinct_operators: number | null;
    distinct_jobs: number | null;
    start_present_pct: number | null;
    complete_present_pct: number | null;
    /** minutes between max timestamp in sample and plant clock now */
    timestamp_skew_minutes: number | null;
    sample_durations_minutes: number[];
    warnings: string[];
  };
}

export interface CreateUserRequest {
  username: string;
  password: string;
  role: Role;
}

export interface UpdateUserRequest {
  role?: Role;
  active?: boolean;
  password?: string;
}

export interface AuditListResponse {
  entries: AuditEntry[];
  total: number;
}

export interface StandardsAdminResponse {
  adjustments: StandardAdjustment[];
  overrides: StandardOverride[];
  operations: string[];
  last_recompute_at: UtcMs | null;
}

export interface RecomputeStandardsRequest {
  product_number?: string | null;
}

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  error: string;
  message: string;
  statusCode: number;
}
