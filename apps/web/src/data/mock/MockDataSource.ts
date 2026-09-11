/**
 * In-browser demo data source (spec 12): a seeded factory simulator + the shared engine.
 *
 * No network. All admin state is in memory and resets on reload. Every method resolves
 * asynchronously and returns fresh objects so React state comparisons behave like they
 * do against the real API.
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
  SetupAdminRequest,
  SetupStatus,
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
import {
  DataSourceError,
  type DashboardQuery,
  type DataSource,
  type OperatorDetailQuery,
  type ShiftViewQuery,
  type Unsubscribe,
} from '../DataSource';
import { MockStore, clone } from './state';
import { startLiveSimulation, type DemoControl } from './simulator/live';

const HEARTBEAT_MS = 25_000;

/** Resolve on a later microtask so callers always observe a real Promise boundary. */
async function tick(): Promise<void> {
  await Promise.resolve();
}

function unref(t: unknown): void {
  const handle = t as { unref?: () => void };
  if (typeof handle?.unref === 'function') handle.unref();
}

export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;

  readonly store: MockStore;
  private live: DemoControl | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(store?: MockStore) {
    this.store = store ?? new MockStore();
  }

  /** Boots the world + live scheduler on first use (never at module import). */
  private ensure(): MockStore {
    this.store.ensureWorld();
    if (this.live === null) this.live = startLiveSimulation(this.store);
    return this.store;
  }

  private async ok<T>(fn: () => T): Promise<T> {
    await tick();
    try {
      return clone(fn());
    } catch (err) {
      throw new DataSourceError(400, err instanceof Error ? err.message : 'Demo error', err);
    }
  }

  // ------------------------------------------------------------ health/events

  health(): Promise<AppHealth> {
    return this.ok(() => this.ensure().health());
  }

  syncHealth(): Promise<SyncHealth> {
    return this.ok(() => this.ensure().syncHealth());
  }

  subscribe(cb: (e: SseEvent) => void): Unsubscribe {
    this.ensure();
    const off = this.store.addListener(cb);
    if (this.heartbeat === null) {
      const t = setInterval(() => {
        this.store.emit({ type: 'heartbeat', at: Date.now() });
      }, HEARTBEAT_MS);
      unref(t);
      this.heartbeat = t;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      off();
      if (this.store.listenerCount === 0 && this.heartbeat !== null) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    };
  }

  // --------------------------------------------------------------- setup/auth

  setupStatus(): Promise<SetupStatus> {
    return this.ok(() => ({
      needs_setup: false,
      steps: {
        admin_user: true,
        timezone: true,
        connection: true,
        mapping: true,
        shifts: true,
        breaks: true,
        backfill: true,
      },
    }));
  }

  setupAdmin(req: SetupAdminRequest): Promise<AuthMe> {
    return this.ok(() => {
      const store = this.ensure();
      store.audit('create', 'user', req.username, null, { username: req.username, role: 'admin' });
      return { user: store.adminUser() };
    });
  }

  login(_req: LoginRequest): Promise<AuthMe> {
    return this.ok(() => ({ user: this.ensure().adminUser() }));
  }

  async logout(): Promise<void> {
    // The demo has no real session: stay logged in so the portal keeps working.
    await tick();
  }

  me(): Promise<AuthMe> {
    return this.ok(() => ({ user: this.ensure().adminUser() }));
  }

  // ----------------------------------------------------------------------- tv

  tvRegister(device_token: string): Promise<TvState> {
    return this.ok(() => this.ensure().tvRegister(device_token));
  }

  tvState(device_token: string): Promise<TvState> {
    return this.ok(() => this.ensure().tvState(device_token));
  }

  // ------------------------------------------------------------------- portal

  shiftPicker(): Promise<ShiftPickerResponse> {
    return this.ok(() => this.ensure().shiftPicker());
  }

  shiftInstances(from: UtcMs, to: UtcMs): Promise<ShiftInstanceListItem[]> {
    return this.ok(() => this.ensure().shiftInstances(from, to));
  }

  shiftView(q: ShiftViewQuery): Promise<ShiftView> {
    return this.ok(() => this.ensure().shiftView(q));
  }

  floor(showVisitors: boolean): Promise<FloorView> {
    return this.ok(() => this.ensure().floor(showVisitors));
  }

  operators(q?: string): Promise<OperatorListItem[]> {
    return this.ok(() => this.ensure().operators(q));
  }

  operatorDetail(id: string, q: OperatorDetailQuery): Promise<OperatorDetail> {
    return this.ok(() => this.ensure().operatorDetail(id, q));
  }

  jobs(q?: string, active?: boolean): Promise<JobListResponse> {
    return this.ok(() => this.ensure().jobs(q, active));
  }

  jobDetail(job: string): Promise<JobDetail> {
    return this.ok(() => this.ensure().jobDetail(job));
  }

  dashboard(job: string, q: DashboardQuery): Promise<TvDashboard> {
    return this.ok(() => this.ensure().dashboard(job, q));
  }

  products(q?: string): Promise<ProductListItem[]> {
    return this.ok(() => this.ensure().products(q));
  }

  productView(z: string): Promise<ProductView> {
    return this.ok(() => this.ensure().productView(z));
  }

  createProductAdjustment(z: string, req: CreateAdjustmentRequest): Promise<StandardAdjustment> {
    return this.ok(() =>
      this.ensure().createAdjustment({ ...req, product_number: req.product_number ?? z }),
    );
  }

  async deleteAdjustment(id: number): Promise<void> {
    await tick();
    this.ensure().deleteAdjustment(id);
  }

  createOverride(z: string, req: CreateOverrideRequest): Promise<StandardOverride> {
    return this.ok(() => this.ensure().createOverride(z, req));
  }

  async deleteOverride(id: number): Promise<void> {
    await tick();
    this.ensure().deleteOverride(id);
  }

  async recomputeProduct(z: string): Promise<void> {
    await tick();
    const store = this.ensure();
    store.recomputeStandardsNow(z);
    store.audit('recompute', 'standards', z, null, { product_number: z });
    store.emitSettingsUpdated();
  }

  pins(q?: { operator_id?: string; job_number?: string }): Promise<PinListResponse> {
    return this.ok(() => this.ensure().pinList(q));
  }

  createPin(req: CreatePinRequest): Promise<Pin> {
    return this.ok(() => this.ensure().createPin(req));
  }

  async deletePin(id: number): Promise<void> {
    await tick();
    this.ensure().deletePin(id);
  }

  // -------------------------------------------------------------------- admin

  displays(): Promise<Display[]> {
    return this.ok(() => this.ensure().displays);
  }

  claimDisplay(req: ClaimDisplayRequest): Promise<Display> {
    return this.ok(() => this.ensure().claimDisplay(req));
  }

  updateDisplay(id: number, req: UpdateDisplayRequest): Promise<Display> {
    return this.ok(() => this.ensure().updateDisplay(id, req));
  }

  repairDisplay(id: number, req: RepairDisplayRequest): Promise<Display> {
    return this.ok(() => this.ensure().repairDisplay(id, req));
  }

  async deleteDisplay(id: number): Promise<void> {
    await tick();
    this.ensure().deleteDisplay(id);
  }

  shifts(): Promise<ShiftDef[]> {
    return this.ok(() => this.ensure().shiftDefs);
  }

  createShift(req: ShiftWrite): Promise<ShiftDef> {
    return this.ok(() => this.ensure().createShift(req));
  }

  updateShift(id: number, req: ShiftWrite): Promise<ShiftDef> {
    return this.ok(() => this.ensure().updateShift(id, req));
  }

  async deleteShift(id: number): Promise<void> {
    await tick();
    this.ensure().deleteShift(id);
  }

  breaks(): Promise<BreakDef[]> {
    return this.ok(() => this.ensure().breakDefs);
  }

  createBreak(req: BreakWrite): Promise<BreakDef> {
    return this.ok(() => this.ensure().createBreak(req));
  }

  updateBreak(id: number, req: BreakWrite): Promise<BreakDef> {
    return this.ok(() => this.ensure().updateBreak(id, req));
  }

  async deleteBreak(id: number): Promise<void> {
    await tick();
    this.ensure().deleteBreak(id);
  }

  settings(): Promise<SettingsResponse> {
    return this.ok(() => this.ensure().settingsResponse());
  }

  updateSettings(patch: SettingsPatch): Promise<SettingsResponse> {
    return this.ok(() => this.ensure().updateSettings(patch));
  }

  connection(): Promise<ConnectionResponse> {
    return this.ok(() => this.ensure().connection());
  }

  updateConnection(req: FlConnection): Promise<ConnectionResponse> {
    return this.ok(() => this.ensure().updateConnection(req));
  }

  testConnection(_req?: FlConnection): Promise<ConnectionTestResult> {
    return this.ok(() => this.ensure().testConnection());
  }

  mapping(): Promise<MappingResponse> {
    return this.ok(() => this.ensure().mapping());
  }

  updateMapping(m: MappingConfig): Promise<MappingResponse> {
    return this.ok(() => this.ensure().updateMapping(m));
  }

  mappingMetadata(): Promise<ODataMetadata> {
    return this.ok(() => this.ensure().metadata());
  }

  mappingPreview(req: MappingPreviewRequest): Promise<MappingPreviewResult> {
    return this.ok(() => this.ensure().mappingPreview(req));
  }

  standardsAdmin(): Promise<StandardsAdminResponse> {
    return this.ok(() => this.ensure().standardsAdmin());
  }

  createGlobalAdjustment(req: CreateAdjustmentRequest): Promise<StandardAdjustment> {
    return this.ok(() => this.ensure().createAdjustment(req));
  }

  async deleteGlobalAdjustment(id: number): Promise<void> {
    await tick();
    this.ensure().deleteAdjustment(id);
  }

  async recomputeStandards(req: RecomputeStandardsRequest): Promise<void> {
    await tick();
    const store = this.ensure();
    store.recomputeStandards(req);
    store.emitSettingsUpdated();
  }

  users(): Promise<User[]> {
    return this.ok(() => this.ensure().users);
  }

  createUser(req: CreateUserRequest): Promise<User> {
    return this.ok(() => this.ensure().createUser(req));
  }

  updateUser(id: number, req: UpdateUserRequest): Promise<User> {
    return this.ok(() => this.ensure().updateUser(id, req));
  }

  syncLog(limit?: number): Promise<SyncLogEntry[]> {
    return this.ok(() => this.ensure().syncLog(limit));
  }

  async runBackfill(): Promise<void> {
    await tick();
    this.ensure().runBackfill();
  }

  audit(limit?: number, offset?: number): Promise<AuditListResponse> {
    return this.ok(() => this.ensure().auditList(limit, offset));
  }
}
