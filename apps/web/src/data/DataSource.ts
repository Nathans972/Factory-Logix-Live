/**
 * DataSource abstraction (spec 12.2).
 *
 * `ApiDataSource` (production) calls the REST API described in docs/API.md and subscribes to SSE.
 * `MockDataSource` (demo, VITE_DATA_SOURCE=mock) runs an in-browser simulator + the shared engine.
 *
 * Every method returns a Promise so the UI code is identical for both. Errors reject with
 * `DataSourceError` carrying an HTTP-like status code.
 */
import type {
  AppHealth,
  AuditListResponse,
  AuthMe,
  BreakDef,
  BreakWrite,
  ClaimDisplayRequest,
  ConnectionResponse,
  ConnectionTestResult,
  CreateAdjustmentRequest,
  CreateOverrideRequest,
  CreatePinRequest,
  CreateUserRequest,
  Display,
  FlConnection,
  FloorView,
  JobDetail,
  JobListResponse,
  LoginRequest,
  MappingConfig,
  MappingPreviewRequest,
  MappingPreviewResult,
  MappingResponse,
  ODataMetadata,
  OperatorDetail,
  OperatorListItem,
  Pin,
  PinListResponse,
  ProductListItem,
  ProductView,
  RecomputeStandardsRequest,
  RepairDisplayRequest,
  SetDisplayJobRequest,
  SetupAdminRequest,
  SetupStatus,
  Settings,
  SettingsPatch,
  SettingsResponse,
  ShiftDef,
  ShiftInstanceListItem,
  ShiftPickerResponse,
  ShiftView,
  ShiftWrite,
  SseEvent,
  StandardAdjustment,
  StandardOverride,
  StandardsAdminResponse,
  SyncHealth,
  SyncLogEntry,
  TvDashboard,
  TvState,
  UpdateDisplayRequest,
  UpdateUserRequest,
  User,
  UtcMs,
} from '@fld/shared';

export class DataSourceError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'DataSourceError';
  }
}

export interface ShiftViewQuery {
  date?: string | null;
  shift_id?: number | null;
  job?: string | null;
  product?: string | null;
  operation?: string | null;
  operator?: string | null;
}

export interface OperatorDetailQuery {
  from?: UtcMs;
  to?: UtcMs;
  date?: string | null;
  shift_id?: number | null;
}

export interface DashboardQuery {
  grouped?: boolean;
  shift_length_hours?: number;
  show_std_day?: boolean;
}

export type Unsubscribe = () => void;

/**
 * What `subscribe` delivers: the server's events, and `resync` when some of them may have been
 * missed (the stream was closed while the page was hidden). A subscriber refetches on `resync`
 * whatever its events would have refreshed.
 */
export type LiveEvent = SseEvent | { type: 'resync'; at: UtcMs };

export interface DataSource {
  /** 'api' | 'mock' */
  readonly kind: 'api' | 'mock';

  // health / events
  health(): Promise<AppHealth>;
  syncHealth(): Promise<SyncHealth>;
  /** Subscribe to server events. The callback also receives a synthetic {type:'heartbeat'} periodically. */
  subscribe(cb: (e: LiveEvent) => void): Unsubscribe;

  // setup / auth
  setupStatus(): Promise<SetupStatus>;
  setupAdmin(req: SetupAdminRequest): Promise<AuthMe>;
  login(req: LoginRequest): Promise<AuthMe>;
  logout(): Promise<void>;
  me(): Promise<AuthMe>;

  // tv
  tvRegister(device_token: string): Promise<TvState>;
  tvState(device_token: string): Promise<TvState>;

  // portal
  shiftPicker(): Promise<ShiftPickerResponse>;
  shiftInstances(from: UtcMs, to: UtcMs): Promise<ShiftInstanceListItem[]>;
  shiftView(q: ShiftViewQuery): Promise<ShiftView>;
  floor(showVisitors: boolean): Promise<FloorView>;
  operators(q?: string): Promise<OperatorListItem[]>;
  operatorDetail(id: string, q: OperatorDetailQuery): Promise<OperatorDetail>;
  jobs(q?: string, active?: boolean): Promise<JobListResponse>;
  jobDetail(job: string): Promise<JobDetail>;
  dashboard(job: string, q: DashboardQuery): Promise<TvDashboard>;
  products(q?: string): Promise<ProductListItem[]>;
  productView(z: string): Promise<ProductView>;
  createProductAdjustment(z: string, req: CreateAdjustmentRequest): Promise<StandardAdjustment>;
  deleteAdjustment(id: number): Promise<void>;
  createOverride(z: string, req: CreateOverrideRequest): Promise<StandardOverride>;
  deleteOverride(id: number): Promise<void>;
  recomputeProduct(z: string): Promise<void>;
  pins(q?: { operator_id?: string; job_number?: string }): Promise<PinListResponse>;
  createPin(req: CreatePinRequest): Promise<Pin>;
  deletePin(id: number): Promise<void>;

  // TV displays (manager+): list the TVs and change only the job each one shows
  tvDisplays(): Promise<Display[]>;
  setDisplayJob(id: number, req: SetDisplayJobRequest): Promise<Display>;

  // admin
  displays(): Promise<Display[]>;
  claimDisplay(req: ClaimDisplayRequest): Promise<Display>;
  updateDisplay(id: number, req: UpdateDisplayRequest): Promise<Display>;
  repairDisplay(id: number, req: RepairDisplayRequest): Promise<Display>;
  deleteDisplay(id: number): Promise<void>;
  shifts(): Promise<ShiftDef[]>;
  createShift(req: ShiftWrite): Promise<ShiftDef>;
  updateShift(id: number, req: ShiftWrite): Promise<ShiftDef>;
  deleteShift(id: number): Promise<void>;
  breaks(): Promise<BreakDef[]>;
  createBreak(req: BreakWrite): Promise<BreakDef>;
  updateBreak(id: number, req: BreakWrite): Promise<BreakDef>;
  deleteBreak(id: number): Promise<void>;
  settings(): Promise<SettingsResponse>;
  updateSettings(patch: SettingsPatch): Promise<SettingsResponse>;
  connection(): Promise<ConnectionResponse>;
  updateConnection(req: FlConnection): Promise<ConnectionResponse>;
  testConnection(req?: FlConnection): Promise<ConnectionTestResult>;
  mapping(): Promise<MappingResponse>;
  updateMapping(m: MappingConfig): Promise<MappingResponse>;
  mappingMetadata(): Promise<ODataMetadata>;
  mappingPreview(req: MappingPreviewRequest): Promise<MappingPreviewResult>;
  standardsAdmin(): Promise<StandardsAdminResponse>;
  createGlobalAdjustment(req: CreateAdjustmentRequest): Promise<StandardAdjustment>;
  deleteGlobalAdjustment(id: number): Promise<void>;
  recomputeStandards(req: RecomputeStandardsRequest): Promise<void>;
  users(): Promise<User[]>;
  createUser(req: CreateUserRequest): Promise<User>;
  updateUser(id: number, req: UpdateUserRequest): Promise<User>;
  syncLog(limit?: number): Promise<SyncLogEntry[]>;
  runBackfill(): Promise<void>;
  audit(limit?: number, offset?: number): Promise<AuditListResponse>;
}

export type { Settings };
