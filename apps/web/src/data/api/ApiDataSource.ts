/**
 * REST + SSE client for the production backend (docs/API.md).
 *
 * Every method maps 1:1 to an endpoint. Non-2xx responses reject with `DataSourceError`
 * carrying the HTTP status and the API's `{error, message}` payload.
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

/** SSE event names the API emits (docs/API.md). */
const SSE_EVENT_NAMES: SseEvent['type'][] = [
  'data_updated',
  'display_updated',
  'sync_health',
  'settings_updated',
  'heartbeat',
];

/** Synthetic heartbeat interval; consumers use it as the polling fallback (spec 8.4). */
const FALLBACK_HEARTBEAT_MS = 60_000;

/**
 * A TV request still unanswered after this long is aborted and fails. The TV keeps one request in
 * flight, so without a bound a single lost one (half-open connection after a Wi-Fi blip or
 * sleep/wake, an API stalled behind the proxy's 3600 s read timeout) would stop every later poll
 * and never show the offline banner. Well under the TV's 60 s poll.
 */
const TV_REQUEST_TIMEOUT_MS = 20_000;

type QueryValue = string | number | boolean | null | undefined;

function queryString(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? '?' + s : '';
}

export class ApiDataSource implements DataSource {
  readonly kind = 'api' as const;

  private es: EventSource | null = null;
  private subscribers = new Set<(e: SseEvent) => void>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;

  constructor(public baseUrl: string) {}

  // ---------------------------------------------------------------- transport

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number },
  ): Promise<T> {
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    // `timeoutMs` aborts the request, body read included. A timer rather than
    // `AbortSignal.timeout()`, which older TV browsers do not have.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (init?.timeoutMs !== undefined) timer = setTimeout(() => controller.abort(), init.timeoutMs);

    let res: Response;
    let text: string;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body,
        credentials: 'include',
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) throw new DataSourceError(0, 'Request timed out', err);
      throw new DataSourceError(0, err instanceof Error ? err.message : 'Network error', err);
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }

    if (!res.ok) {
      const shape = payload as { error?: string; message?: string } | null;
      const message =
        (shape && typeof shape === 'object' ? (shape.message ?? shape.error) : null) ||
        res.statusText ||
        'HTTP ' + String(res.status);
      throw new DataSourceError(res.status, message, payload);
    }
    return payload as T;
  }

  private get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>(path, { timeoutMs });
  }

  private post<T>(path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: body ?? {}, timeoutMs });
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PUT', body: body ?? {} });
  }

  private patchReq<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: body ?? {} });
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // ------------------------------------------------------------ health/events

  health(): Promise<AppHealth> {
    return this.get<AppHealth>('/health');
  }

  syncHealth(): Promise<SyncHealth> {
    return this.get<SyncHealth>('/health/sync');
  }

  subscribe(cb: (e: SseEvent) => void): Unsubscribe {
    this.subscribers.add(cb);
    if (this.es === null) this.openStream();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(cb);
      if (this.subscribers.size === 0) this.closeStream();
    };
  }

  private emit(e: SseEvent): void {
    for (const cb of [...this.subscribers]) {
      try {
        cb(e);
      } catch {
        /* a throwing subscriber must not break the stream */
      }
    }
  }

  private openStream(): void {
    if (typeof EventSource === 'undefined') {
      // No SSE here (tests / old browsers): the synthetic heartbeat is the only signal.
      this.startFallback();
      return;
    }
    const es = new EventSource(this.baseUrl + '/events');
    this.es = es;
    const onMessage = (ev: Event): void => {
      const data = (ev as MessageEvent<string>).data;
      if (typeof data !== 'string') return;
      try {
        const parsed = JSON.parse(data) as SseEvent;
        if (parsed && typeof parsed.type === 'string') this.emit(parsed);
      } catch {
        /* ignore malformed frames */
      }
    };
    for (const name of SSE_EVENT_NAMES) es.addEventListener(name, onMessage);
    es.onmessage = onMessage;
    es.onerror = () => {
      // Keep the EventSource alive: the browser reconnects on its own. Meanwhile the synthetic
      // heartbeat lets consumers fall back to polling (spec 8.4).
      this.startFallback();
    };
    this.startFallback();
  }

  private startFallback(): void {
    if (this.fallbackTimer !== null) return;
    this.fallbackTimer = setInterval(() => {
      this.emit({ type: 'heartbeat', at: Date.now() });
    }, FALLBACK_HEARTBEAT_MS);
  }

  private closeStream(): void {
    if (this.es !== null) {
      this.es.close();
      this.es = null;
    }
    if (this.fallbackTimer !== null) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  // --------------------------------------------------------------- setup/auth

  setupStatus(): Promise<SetupStatus> {
    return this.get<SetupStatus>('/setup/status');
  }

  setupAdmin(req: SetupAdminRequest): Promise<AuthMe> {
    return this.post<AuthMe>('/setup/admin', req);
  }

  login(req: LoginRequest): Promise<AuthMe> {
    return this.post<AuthMe>('/auth/login', req);
  }

  async logout(): Promise<void> {
    await this.post<unknown>('/auth/logout');
  }

  me(): Promise<AuthMe> {
    return this.get<AuthMe>('/auth/me');
  }

  // ----------------------------------------------------------------------- tv

  tvRegister(device_token: string): Promise<TvState> {
    return this.post<TvState>('/tv/register', { device_token }, TV_REQUEST_TIMEOUT_MS);
  }

  tvState(device_token: string): Promise<TvState> {
    return this.get<TvState>(
      '/tv/' + encodeURIComponent(device_token) + '/state',
      TV_REQUEST_TIMEOUT_MS,
    );
  }

  // ------------------------------------------------------------------- portal

  shiftPicker(): Promise<ShiftPickerResponse> {
    return this.get<ShiftPickerResponse>('/portal/shifts');
  }

  shiftInstances(from: UtcMs, to: UtcMs): Promise<ShiftInstanceListItem[]> {
    return this.get<ShiftInstanceListItem[]>(
      '/portal/shifts/instances' + queryString({ from, to }),
    );
  }

  shiftView(q: ShiftViewQuery): Promise<ShiftView> {
    return this.get<ShiftView>(
      '/portal/shift-view' +
        queryString({
          date: q.date,
          shift_id: q.shift_id,
          job: q.job,
          product: q.product,
          operation: q.operation,
          operator: q.operator,
        }),
    );
  }

  floor(showVisitors: boolean): Promise<FloorView> {
    return this.get<FloorView>('/portal/floor' + queryString({ show_visitors: showVisitors }));
  }

  operators(q?: string): Promise<OperatorListItem[]> {
    return this.get<OperatorListItem[]>('/portal/operators' + queryString({ q }));
  }

  operatorDetail(id: string, q: OperatorDetailQuery): Promise<OperatorDetail> {
    return this.get<OperatorDetail>(
      '/portal/operators/' +
        encodeURIComponent(id) +
        queryString({ from: q.from, to: q.to, date: q.date, shift_id: q.shift_id }),
    );
  }

  jobs(q?: string, active?: boolean): Promise<JobListResponse> {
    return this.get<JobListResponse>('/portal/jobs' + queryString({ q, active }));
  }

  jobDetail(job: string): Promise<JobDetail> {
    return this.get<JobDetail>('/portal/jobs/' + encodeURIComponent(job));
  }

  dashboard(job: string, q: DashboardQuery): Promise<TvDashboard> {
    return this.get<TvDashboard>(
      '/portal/dashboard/' +
        encodeURIComponent(job) +
        queryString({
          grouped: q.grouped,
          shift_length_hours: q.shift_length_hours,
          show_std_day: q.show_std_day,
        }),
    );
  }

  products(q?: string): Promise<ProductListItem[]> {
    return this.get<ProductListItem[]>('/portal/products' + queryString({ q }));
  }

  productView(z: string): Promise<ProductView> {
    return this.get<ProductView>('/portal/products/' + encodeURIComponent(z));
  }

  createProductAdjustment(z: string, req: CreateAdjustmentRequest): Promise<StandardAdjustment> {
    return this.post<StandardAdjustment>(
      '/portal/products/' + encodeURIComponent(z) + '/adjustments',
      req,
    );
  }

  async deleteAdjustment(id: number): Promise<void> {
    await this.del<unknown>('/portal/adjustments/' + String(id));
  }

  createOverride(z: string, req: CreateOverrideRequest): Promise<StandardOverride> {
    return this.post<StandardOverride>(
      '/portal/products/' + encodeURIComponent(z) + '/overrides',
      req,
    );
  }

  async deleteOverride(id: number): Promise<void> {
    await this.del<unknown>('/portal/overrides/' + String(id));
  }

  async recomputeProduct(z: string): Promise<void> {
    await this.post<unknown>('/portal/products/' + encodeURIComponent(z) + '/recompute');
  }

  pins(q?: { operator_id?: string; job_number?: string }): Promise<PinListResponse> {
    return this.get<PinListResponse>(
      '/portal/pins' + queryString({ operator_id: q?.operator_id, job_number: q?.job_number }),
    );
  }

  createPin(req: CreatePinRequest): Promise<Pin> {
    return this.post<Pin>('/portal/pins', req);
  }

  async deletePin(id: number): Promise<void> {
    await this.del<unknown>('/portal/pins/' + String(id));
  }

  // -------------------------------------------------------------- tv displays

  tvDisplays(): Promise<Display[]> {
    return this.get<Display[]>('/displays');
  }

  setDisplayJob(id: number, req: SetDisplayJobRequest): Promise<Display> {
    return this.put<Display>('/displays/' + String(id) + '/job', req);
  }

  // -------------------------------------------------------------------- admin

  displays(): Promise<Display[]> {
    return this.get<Display[]>('/admin/displays');
  }

  claimDisplay(req: ClaimDisplayRequest): Promise<Display> {
    return this.post<Display>('/admin/displays/claim', req);
  }

  updateDisplay(id: number, req: UpdateDisplayRequest): Promise<Display> {
    return this.patchReq<Display>('/admin/displays/' + String(id), req);
  }

  repairDisplay(id: number, req: RepairDisplayRequest): Promise<Display> {
    return this.post<Display>('/admin/displays/' + String(id) + '/repair', req);
  }

  async deleteDisplay(id: number): Promise<void> {
    await this.del<unknown>('/admin/displays/' + String(id));
  }

  shifts(): Promise<ShiftDef[]> {
    return this.get<ShiftDef[]>('/admin/shifts');
  }

  createShift(req: ShiftWrite): Promise<ShiftDef> {
    return this.post<ShiftDef>('/admin/shifts', req);
  }

  updateShift(id: number, req: ShiftWrite): Promise<ShiftDef> {
    return this.put<ShiftDef>('/admin/shifts/' + String(id), req);
  }

  async deleteShift(id: number): Promise<void> {
    await this.del<unknown>('/admin/shifts/' + String(id));
  }

  breaks(): Promise<BreakDef[]> {
    return this.get<BreakDef[]>('/admin/breaks');
  }

  createBreak(req: BreakWrite): Promise<BreakDef> {
    return this.post<BreakDef>('/admin/breaks', req);
  }

  updateBreak(id: number, req: BreakWrite): Promise<BreakDef> {
    return this.put<BreakDef>('/admin/breaks/' + String(id), req);
  }

  async deleteBreak(id: number): Promise<void> {
    await this.del<unknown>('/admin/breaks/' + String(id));
  }

  settings(): Promise<SettingsResponse> {
    return this.get<SettingsResponse>('/admin/settings');
  }

  updateSettings(patch: SettingsPatch): Promise<SettingsResponse> {
    return this.patchReq<SettingsResponse>('/admin/settings', patch);
  }

  connection(): Promise<ConnectionResponse> {
    return this.get<ConnectionResponse>('/admin/connection');
  }

  updateConnection(req: FlConnection): Promise<ConnectionResponse> {
    return this.put<ConnectionResponse>('/admin/connection', req);
  }

  testConnection(req?: FlConnection): Promise<ConnectionTestResult> {
    return this.post<ConnectionTestResult>('/admin/connection/test', req ?? {});
  }

  mapping(): Promise<MappingResponse> {
    return this.get<MappingResponse>('/admin/mapping');
  }

  updateMapping(m: MappingConfig): Promise<MappingResponse> {
    return this.put<MappingResponse>('/admin/mapping', m);
  }

  mappingMetadata(): Promise<ODataMetadata> {
    return this.get<ODataMetadata>('/admin/mapping/metadata');
  }

  mappingPreview(req: MappingPreviewRequest): Promise<MappingPreviewResult> {
    return this.post<MappingPreviewResult>('/admin/mapping/preview', req);
  }

  standardsAdmin(): Promise<StandardsAdminResponse> {
    return this.get<StandardsAdminResponse>('/admin/standards');
  }

  createGlobalAdjustment(req: CreateAdjustmentRequest): Promise<StandardAdjustment> {
    return this.post<StandardAdjustment>('/admin/standards/adjustments', req);
  }

  async deleteGlobalAdjustment(id: number): Promise<void> {
    await this.del<unknown>('/admin/standards/adjustments/' + String(id));
  }

  async recomputeStandards(req: RecomputeStandardsRequest): Promise<void> {
    await this.post<unknown>('/admin/standards/recompute', req);
  }

  users(): Promise<User[]> {
    return this.get<User[]>('/admin/users');
  }

  createUser(req: CreateUserRequest): Promise<User> {
    return this.post<User>('/admin/users', req);
  }

  updateUser(id: number, req: UpdateUserRequest): Promise<User> {
    return this.patchReq<User>('/admin/users/' + String(id), req);
  }

  syncLog(limit?: number): Promise<SyncLogEntry[]> {
    return this.get<SyncLogEntry[]>('/admin/sync/log' + queryString({ limit }));
  }

  async runBackfill(): Promise<void> {
    await this.post<unknown>('/admin/backfill/run');
  }

  audit(limit?: number, offset?: number): Promise<AuditListResponse> {
    return this.get<AuditListResponse>('/admin/audit' + queryString({ limit, offset }));
  }
}
