/**
 * In-memory state + view assembly for the demo data source (spec 12).
 *
 * `MockStore` owns the simulated world (generated lazily on first use), the admin state
 * that reviewers can edit (and that resets on reload), and one synchronous method per
 * `DataSource` operation. `MockDataSource` is a thin async wrapper around it.
 *
 * Every view is assembled the same way the real API would assemble it: raw records in,
 * engine functions out. No calculation is reimplemented here.
 */
import type {
  AppHealth,
  AuditEntry,
  AuditListResponse,
  BackfillProgress,
  BreakDef,
  BreakWrite,
  ClaimDisplayRequest,
  ConnectionResponse,
  ConnectionTestResult,
  CreateAdjustmentRequest,
  CreateOverrideRequest,
  CreatePinRequest,
  CreateUserRequest,
  Defect,
  Display,
  EngineSettings,
  FloorView,
  JobDetail,
  JobListItem,
  JobListResponse,
  MappingConfig,
  MappingPreviewRequest,
  MappingPreviewResult,
  MappingResponse,
  ODataMetadata,
  OperatorAssignment,
  OperatorDetail,
  OperatorListItem,
  Pin,
  PinListResponse,
  PriorCount,
  ProductListItem,
  ProductView,
  RecomputeStandardsRequest,
  RepairDisplayRequest,
  Settings,
  SettingsPatch,
  SettingsResponse,
  ShiftDef,
  ShiftInstance,
  ShiftInstanceListItem,
  ShiftPickerResponse,
  ShiftView,
  ShiftWrite,
  SourceSyncState,
  SseEvent,
  Standard,
  StandardAdjustment,
  StandardOverride,
  StandardsAdminResponse,
  StandardsLookup,
  SyncHealth,
  SyncLogEntry,
  TvDashboard,
  TvState,
  UnitStep,
  UpdateDisplayRequest,
  UpdateUserRequest,
  User,
  UtcMs,
  WorkOrder,
} from '@fld/shared';
import {
  DEFAULT_SETTINGS,
  EXAMPLE_MAPPING,
  TIME_CONSTANTS,
  pickEngineSettings,
} from '@fld/shared';
import {
  buildFloorView,
  buildJobDetail,
  buildOperatorDetail,
  buildProductView,
  buildShiftView,
  buildStandardsLookup,
  buildTvDashboard,
  computeDefectHourCells,
  computeStandard,
  effectiveStdHr,
  expandBreaks,
  expandShiftInstance,
  findCurrentOrMostRecentShift,
  findCurrentShift,
  hourColumns,
  hourStartUtc,
  listShiftInstances,
  rollingWindowColumns,
} from '@fld/engine';
import { CellCache } from './simulator/cellcache';
import {
  generateHistory,
  liveDefects,
  runActors,
  type ActorState,
  type ActorTiming,
  type GenContext,
  type GeneratedHistory,
  type UnitAllocator,
} from './simulator/history';
import { mulberry32, type Rng } from './simulator/rng';
import {
  DEMO_CONNECTION,
  FEATURED_JOB,
  FL_STD_HR,
  HISTORY_DAYS,
  JOBS,
  JOB_BY_NUMBER,
  OPERATIONS,
  OPERATORS,
  OPERATOR_NAMES,
  PRODUCTS,
  PRODUCT_BY_NUMBER,
  SECONDARY_JOB,
  WORLD_SEED,
  buildWorkOrders,
  demoMetadata,
  demoSyncLog,
  initialBreaks,
  initialShifts,
  initialUsers,
  routeFor,
} from './simulator/world';

const HOUR = TIME_CONSTANTS.HOUR_MS;
const MINUTE = TIME_CONSTANTS.MINUTE_MS;
const DAY = TIME_CONSTANTS.DAY_MS;
const WINDOW_HOURS = TIME_CONSTANTS.ROLLING_WINDOW_HOURS;

/** Scripted "data delayed" episode so reviewers see the banner (spec 3.4 / 8.2). */
const DELAY_EPISODE_START_MS = 5 * MINUTE;
const DELAY_EPISODE_END_MS = 7 * MINUTE;
/** Display 3 swaps job this long after page load (spec 12.4). */
export const DISPLAY_JOB_CHANGE_MS = 3 * MINUTE;
/** A freshly registered TV is auto-claimed this long after registration (spec 12.5). */
export const AUTO_CLAIM_MS = 8_000;
/** Simulated backfill duration. */
const BACKFILL_MS = 60_000;

export function clone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

interface DeviceRecord {
  device_token: string;
  display_id: number;
  registered_at: UtcMs;
  auto_claim: boolean;
}

export class MockStore {
  readonly bootTime = Date.now();
  readonly seed = WORLD_SEED;

  settings: Settings = { ...DEFAULT_SETTINGS };
  shiftDefs: ShiftDef[] = initialShifts();
  breakDefs: BreakDef[] = initialBreaks();
  displays: Display[] = [];
  users: User[] = [];
  adjustments: StandardAdjustment[] = [];
  overrides: StandardOverride[] = [];
  pins: Pin[] = [];
  auditEntries: AuditEntry[] = [];
  mappingConfig: MappingConfig = clone(EXAMPLE_MAPPING);
  connectionConfig = { ...DEMO_CONNECTION };
  standards: Standard[] = [];
  lastRecomputeAt: UtcMs | null = null;
  backfill: BackfillProgress | null = null;
  syncLogEntries: SyncLogEntry[] = [];

  private devices = new Map<string, DeviceRecord>();
  private nextIds: Record<string, number> = {
    display: 1,
    shift: 3,
    break: 9,
    user: 4,
    adjustment: 1,
    override: 1,
    pin: 1,
    audit: 1,
  };

  private world: GeneratedHistory | null = null;
  private steps: UnitStep[] = [];
  private defects: Defect[] = [];
  private workOrders: WorkOrder[] = [];
  private stepsByJob = new Map<string, UnitStep[]>();
  private stepsByProductOp = new Map<string, UnitStep[]>();
  private defectsByJob = new Map<string, Defect[]>();
  private lastSeen = new Map<string, UtcMs>();
  private derivedMemo = new Map<string, { at: number; value: number }>();
  private actorStates: ActorState[] = [];
  private timing: ActorTiming = { scriptStart: 0, horizon: 0 };
  private alloc: UnitAllocator | null = null;
  private liveRng: Rng = mulberry32(WORLD_SEED ^ 0x5bf03635);
  private liveCursor = 0;

  private lookupCache: { key: string; lookup: StandardsLookup } | null = null;
  private stdVersion = 0;

  private listeners = new Set<(e: SseEvent) => void>();
  private lastSyncStatus: 'ok' | 'degraded' = 'ok';

  readonly cells = new CellCache({
    steps: () => this.steps,
    shifts: () => this.shiftDefs,
    breakDefs: () => this.breakDefs,
    standards: () => this.standardsLookup(),
    pins: () => this.pins,
    settings: () => this.engineSettings(),
    now: () => this.now(),
  });

  // -------------------------------------------------------------------- basics

  now(): UtcMs {
    return Date.now();
  }

  engineSettings(): EngineSettings {
    return pickEngineSettings(this.settings);
  }

  get tz(): string {
    return this.settings.plant_timezone;
  }

  private id(kind: string): number {
    const n = this.nextIds[kind] ?? 1;
    this.nextIds[kind] = n + 1;
    return n;
  }

  // --------------------------------------------------------------------- world

  /** Generate the world on first use; never at module import time. */
  ensureWorld(): GeneratedHistory {
    if (this.world !== null) return this.world;
    const now = this.now();
    const from = now - (HISTORY_DAYS + 1) * DAY;
    const breaks = expandBreaks(this.breakDefs, this.shiftDefs, from, now + DAY, this.tz);
    const world = generateHistory(now, this.shiftDefs, breaks, this.seed);
    this.world = world;
    this.steps = world.steps;
    this.defects = world.defects;
    this.alloc = world.alloc;
    this.actorStates = world.actorStates;
    this.timing = world.timing;
    this.liveCursor = now;
    this.workOrders = buildWorkOrders(now);
    this.rebuildIndexes();
    this.recomputeStandardsNow(null);
    this.seedDisplays(now);
    this.users = initialUsers(now);
    this.syncLogEntries = demoSyncLog(now);
    return world;
  }

  private rebuildIndexes(): void {
    this.stepsByJob.clear();
    this.stepsByProductOp.clear();
    this.defectsByJob.clear();
    this.lastSeen.clear();
    this.derivedMemo.clear();
    for (const s of this.steps) this.indexStep(s);
    for (const d of this.defects) this.indexDefect(d);
  }

  private indexStep(s: UnitStep): void {
    let byJob = this.stepsByJob.get(s.job_number);
    if (byJob === undefined) {
      byJob = [];
      this.stepsByJob.set(s.job_number, byJob);
    }
    byJob.push(s);
    const key = s.product_number + '\u0000' + s.operation;
    let byOp = this.stepsByProductOp.get(key);
    if (byOp === undefined) {
      byOp = [];
      this.stepsByProductOp.set(key, byOp);
    }
    byOp.push(s);
    const t = s.complete_ts ?? s.start_ts;
    const prev = this.lastSeen.get(s.operator_id) ?? 0;
    if (t > prev) this.lastSeen.set(s.operator_id, t);
  }

  private indexDefect(d: Defect): void {
    let list = this.defectsByJob.get(d.job_number);
    if (list === undefined) {
      list = [];
      this.defectsByJob.set(d.job_number, list);
    }
    list.push(d);
  }

  private seedDisplays(now: UtcMs): void {
    const mk = (
      pairing_code: string,
      name: string | null,
      job_number: string | null,
      group_operators: boolean,
    ): Display => ({
      id: this.id('display'),
      pairing_code,
      name,
      claimed_at: name === null ? null : now - 6 * DAY,
      job_number,
      group_operators,
      show_std_day: true,
      show_gauge: true,
      shift_length_hours: 12,
      // A claimed TV has been on the wall for a month; the spare one was plugged in a few
      // minutes ago, so the admin list reads "Registered 6 min ago" (docs/design/admin-displays.html).
      last_seen_at: name === null ? now - 6 * MINUTE : now - 20_000,
      created_at: name === null ? now - 6 * MINUTE : now - 30 * DAY,
      online: name !== null,
    });
    this.displays = [
      mk('4821', 'Line 3 - North TV', FEATURED_JOB, false),
      mk('5137', 'Line 3 - Supervisor TV', FEATURED_JOB, true),
      mk('6402', 'Line 5 - Test Cell', SECONDARY_JOB, false),
      mk('7318', null, null, false),
    ];
    this.devices.set('demo-1', {
      device_token: 'demo-1',
      display_id: 1,
      registered_at: now,
      auto_claim: false,
    });
    this.devices.set('demo-2', {
      device_token: 'demo-2',
      display_id: 2,
      registered_at: now,
      auto_claim: false,
    });
    this.devices.set('demo-3', {
      device_token: 'demo-3',
      display_id: 3,
      registered_at: now,
      auto_claim: false,
    });
  }

  // ------------------------------------------------------------------ standards

  standardsLookup(): StandardsLookup {
    const key = String(this.stdVersion);
    if (this.lookupCache !== null && this.lookupCache.key === key) return this.lookupCache.lookup;
    const extra: { product_number: string; operation: string }[] = [];
    for (const p of PRODUCTS) {
      for (const op of p.route) extra.push({ product_number: p.product_number, operation: op });
    }
    const lookup = buildStandardsLookup(
      this.standards,
      this.adjustments,
      this.overrides.filter((o) => o.active),
      extra,
    );
    this.lookupCache = { key, lookup };
    return lookup;
  }

  private bumpStandards(): void {
    this.stdVersion += 1;
    this.lookupCache = null;
    this.cells.clear();
  }

  /** Recompute standards from the generated history (spec 7.1). */
  recomputeStandardsNow(product_number: string | null): void {
    const now = this.now();
    const settings = this.engineSettings();
    const lookbackStart = Math.max(
      now - settings.std_lookback_days * DAY,
      now - (HISTORY_DAYS + 2) * DAY,
    );
    const breaks = expandBreaks(this.breakDefs, this.shiftDefs, lookbackStart, now + HOUR, this.tz);
    const rework_flag_mapped = this.mappingConfig.unit_steps.fields.rework_flag != null;
    const next: Standard[] = product_number === null ? [] : [...this.standards];
    for (const p of PRODUCTS) {
      if (product_number !== null && p.product_number !== product_number) continue;
      for (const operation of p.route) {
        const steps = this.stepsByProductOp.get(p.product_number + '\u0000' + operation) ?? [];
        const std = computeStandard({
          product_number: p.product_number,
          operation,
          steps,
          breaks,
          settings,
          now,
          fl_std_hr: FL_STD_HR[operation] ?? null,
          rework_flag_mapped,
        });
        const idx = next.findIndex(
          (s) => s.product_number === p.product_number && s.operation === operation,
        );
        if (idx >= 0) next[idx] = std;
        else next.push(std);
      }
    }
    this.standards = next;
    this.lastRecomputeAt = now;
    this.bumpStandards();
  }

  // ----------------------------------------------------------------- live tick

  /** Advance the simulation to `to`, appending scripted steps and defects. */
  advanceTo(to: UtcMs, speed: number): UnitStep[] {
    this.ensureWorld();
    const from = this.liveCursor;
    if (to <= from) return [];
    const before = this.steps.length;
    const ctx: GenContext = {
      rng: this.liveRng,
      breaks: expandBreaks(
        this.breakDefs,
        this.shiftDefs,
        from - 2 * HOUR,
        to + 2 * HOUR,
        this.tz,
      ),
      alloc: this.alloc!,
      push: (s) => this.steps.push(s),
    };
    runActors(this.actorStates, ctx, this.timing, from, to, speed, true);
    const added = this.steps.slice(before);
    added.sort((a, b) => a.start_ts - b.start_ts);
    this.steps.length = before;
    for (const s of added) {
      this.steps.push(s);
      this.indexStep(s);
    }
    const newDefects = liveDefects(added, from, to, this.seed);
    for (const d of newDefects) {
      this.defects.push(d);
      this.indexDefect(d);
    }
    this.liveCursor = to;
    // Open steps completed during this tick may live in the previous hour bucket.
    this.cells.invalidateFrom(hourStartUtc(from, this.tz) - HOUR);
    return added;
  }

  // -------------------------------------------------------------------- events

  addListener(cb: (e: SseEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  emit(e: SseEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        /* ignore */
      }
    }
  }

  emitDataUpdated(hours: UtcMs[]): void {
    this.emit({ type: 'data_updated', at: this.now(), hours });
  }

  emitDisplayUpdated(display_id: number, device_token?: string): void {
    this.emit({ type: 'display_updated', at: this.now(), display_id, device_token });
  }

  emitSettingsUpdated(): void {
    this.emit({ type: 'settings_updated', at: this.now() });
  }

  /** Emits `sync_health` when the scripted delayed episode starts/ends. */
  checkSyncTransition(): void {
    const health = this.syncHealth();
    const status = health.status === 'ok' ? 'ok' : 'degraded';
    if (status !== this.lastSyncStatus) {
      this.lastSyncStatus = status;
      this.emit({
        type: 'sync_health',
        at: this.now(),
        status: health.status,
        delayed: health.delayed,
      });
    }
  }

  // --------------------------------------------------------------------- audit

  audit(
    action: string,
    entity: string,
    entity_id: string | null,
    before: unknown,
    after: unknown,
  ): void {
    this.auditEntries.unshift({
      id: this.id('audit'),
      at: this.now(),
      user_id: 1,
      username: 'demo',
      action,
      entity,
      entity_id,
      before: before === undefined ? null : clone(before),
      after: after === undefined ? null : clone(after),
    });
    if (this.auditEntries.length > 500) this.auditEntries.length = 500;
  }

  auditList(limit = 50, offset = 0): AuditListResponse {
    return {
      entries: this.auditEntries.slice(offset, offset + limit),
      total: this.auditEntries.length,
    };
  }

  // -------------------------------------------------------------------- health

  health(): AppHealth {
    return {
      ok: true,
      db: true,
      version: 'demo',
      server_time: this.now(),
      plant_timezone: this.tz,
      plant_name: 'Northbridge Circuit Assembly',
      needs_setup: false,
      demo: true,
    };
  }

  private backfillProgress(): BackfillProgress | null {
    if (this.backfill === null) return null;
    const started = this.backfill.started_at ?? this.now();
    const elapsed = this.now() - started;
    const total = this.backfill.days_total;
    if (elapsed >= BACKFILL_MS) {
      return {
        ...this.backfill,
        status: 'done',
        requested_now: false,
        days_done: total,
        standards_done: true,
        recolor_days_done: total,
        current_day: null,
        finished_at: started + BACKFILL_MS,
      };
    }
    const firstDay = new Date(started - total * DAY).toISOString().slice(0, 10);
    const dayAt = (i: number) => new Date(started - (total - i) * DAY).toISOString().slice(0, 10);
    // Download for the first 70% of the run, then the recoloring phase (standards, then re-colored days).
    const downloadMs = BACKFILL_MS * 0.7;
    if (elapsed < downloadMs) {
      const done = Math.min(total, Math.floor((elapsed / downloadMs) * total));
      return { ...this.backfill, status: 'running', first_day: firstDay, days_done: done, current_day: dayAt(done) };
    }
    const recolored = Math.min(total, Math.floor(((elapsed - downloadMs) / (BACKFILL_MS - downloadMs)) * total));
    return {
      ...this.backfill,
      status: 'recoloring',
      first_day: firstDay,
      days_done: total,
      standards_done: true,
      recolor_days_done: recolored,
      current_day: dayAt(recolored),
    };
  }

  syncHealth(): SyncHealth {
    const now = this.now();
    const since = now - this.bootTime;
    const degraded = since >= DELAY_EPISODE_START_MS && since < DELAY_EPISODE_END_MS;
    const delayed_since = this.bootTime + DELAY_EPISODE_START_MS;
    const last_success_at = degraded ? delayed_since - 40_000 : now - 18_000;
    const sources: SourceSyncState[] = [
      { source: 'unit_steps', rows: 62 },
      { source: 'work_orders', rows: 3 },
      { source: 'defects', rows: 2 },
    ].map((s) => ({
      source: s.source,
      watermark: new Date(last_success_at).toISOString(),
      last_success_at,
      last_error: degraded ? 'OData request timed out after 20000 ms' : null,
      consecutive_failures: degraded ? 2 : 0,
      rows_last_poll: degraded ? null : s.rows,
      duration_ms_last_poll: degraded ? null : 420 + (s.rows % 7) * 31,
    }));
    return {
      status: degraded ? 'degraded' : 'ok',
      last_success_at,
      last_error: degraded ? 'OData request timed out after 20000 ms' : null,
      consecutive_failures: degraded ? 2 : 0,
      breaker_open_until: null,
      delayed: degraded,
      // As in the api: "delayed since" is the last successful poll.
      delayed_since: degraded ? last_success_at : null,
      poll_interval_seconds: this.settings.poll_interval_seconds,
      sources,
      backfill: this.backfillProgress(),
      collector_running: true,
    };
  }

  // ----------------------------------------------------------------- work data

  workOrderList(): WorkOrder[] {
    this.ensureWorld();
    return this.workOrders;
  }

  workOrder(job_number: string): WorkOrder | null {
    return this.workOrderList().find((w) => w.job_number === job_number) ?? null;
  }

  /** Distinct units completed at the last route operation (spec 7.10). */
  derivedQtyComplete(job_number: string): number {
    this.ensureWorld();
    const job = JOB_BY_NUMBER.get(job_number);
    if (!job) return 0;
    const route = routeFor(job.product_number);
    const last = route[route.length - 1];
    if (last === undefined) return 0;
    const memo = this.derivedMemo.get(job_number);
    if (memo !== undefined && memo.at === this.steps.length) return memo.value;
    const units = new Set<string>();
    for (const s of this.stepsByJob.get(job_number) ?? []) {
      if (s.operation === last && s.complete_ts !== null) units.add(s.unit_id);
    }
    const value = Math.min(units.size, job.qty_released);
    this.derivedMemo.set(job_number, { at: this.steps.length, value });
    return value;
  }

  private jobSteps(job_number: string): UnitStep[] {
    this.ensureWorld();
    return this.stepsByJob.get(job_number) ?? [];
  }

  private jobDefects(job_number: string): Defect[] {
    this.ensureWorld();
    return this.defectsByJob.get(job_number) ?? [];
  }

  lastActivity(job_number: string): UtcMs | null {
    const steps = this.jobSteps(job_number);
    let max = 0;
    for (let i = steps.length - 1; i >= 0 && i > steps.length - 200; i--) {
      const s = steps[i]!;
      const t = s.complete_ts ?? s.start_ts;
      if (t > max) max = t;
    }
    return max === 0 ? null : max;
  }

  /** Jobs with a start or complete scan inside [from, to) (spec 9.2). */
  activeJobNumbers(from: UtcMs, to: UtcMs): string[] {
    this.ensureWorld();
    const out = new Set<string>();
    for (const [job, steps] of this.stepsByJob) {
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i]!;
        if (s.start_ts < from - 8 * HOUR) break;
        const touched =
          (s.start_ts >= from && s.start_ts < to) ||
          (s.complete_ts !== null && s.complete_ts >= from && s.complete_ts < to);
        if (touched) {
          out.add(job);
          break;
        }
      }
    }
    return [...out].sort();
  }

  routes(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const p of PRODUCTS) out[p.product_number] = [...p.route];
    return out;
  }

  productNames(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const p of PRODUCTS) out[p.product_number] = p.name;
    return out;
  }

  derivedQtyMap(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const j of JOBS) out[j.job_number] = this.derivedQtyComplete(j.job_number);
    return out;
  }

  // ------------------------------------------------------------------ TV / SSE

  private displayById(id: number): Display | null {
    return this.displays.find((d) => d.id === id) ?? null;
  }

  private randomCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      if (!this.displays.some((d) => d.pairing_code === code)) return code;
    }
    return String(1000 + this.displays.length);
  }

  /** `demo-1` / `demo1` / `1` all resolve to the pre-claimed demo displays. */
  private resolveDemoToken(device_token: string): number | null {
    const m = /^(?:demo[-_]?)?([123])$/i.exec(device_token.trim());
    return m ? Number(m[1]) : null;
  }

  tvRegister(device_token: string): TvState {
    this.ensureWorld();
    const now = this.now();
    let rec = this.devices.get(device_token);
    if (rec === undefined) {
      const demoId = this.resolveDemoToken(device_token);
      if (demoId !== null && this.displayById(demoId) !== null) {
        rec = { device_token, display_id: demoId, registered_at: now, auto_claim: false };
      } else {
        const display: Display = {
          id: this.id('display'),
          pairing_code: this.randomCode(),
          name: null,
          claimed_at: null,
          job_number: null,
          group_operators: false,
          show_std_day: true,
          show_gauge: true,
          shift_length_hours: 12,
          last_seen_at: now,
          created_at: now,
          online: true,
        };
        this.displays.push(display);
        rec = { device_token, display_id: display.id, registered_at: now, auto_claim: true };
        this.emitDisplayUpdated(display.id, device_token);
      }
      this.devices.set(device_token, rec);
    }
    return this.tvState(device_token);
  }

  tvState(device_token: string): TvState {
    this.ensureWorld();
    const now = this.now();
    const rec = this.devices.get(device_token);
    if (rec === undefined) return this.tvRegister(device_token);

    // Reviewers see the pairing screen, then the dashboard (spec 12.5).
    if (rec.auto_claim && now - rec.registered_at >= AUTO_CLAIM_MS) {
      const d = this.displayById(rec.display_id);
      if (d !== null && d.claimed_at === null) {
        d.claimed_at = now;
        d.name = 'Demo TV';
        d.job_number = FEATURED_JOB;
        d.group_operators = false;
        this.audit('claim', 'display', String(d.id), null, d);
        this.emitDisplayUpdated(d.id, device_token);
      }
      rec.auto_claim = false;
    }

    const display = this.displayById(rec.display_id);
    const sync = this.syncHealth();
    const base = {
      device_token,
      pairing_code: display?.pairing_code ?? '----',
      sync: {
        status: sync.status,
        delayed: sync.delayed,
        delayed_since: sync.delayed_since,
        last_success_at: sync.last_success_at,
      },
      server_time: now,
      plant_timezone: this.tz,
      admin_url: this.adminUrl(),
    };
    if (display === null) {
      return { ...base, status: 'unclaimed', display: null, dashboard: null, job_status: null };
    }
    display.last_seen_at = now;
    display.online = true;
    if (display.claimed_at === null) {
      return { ...base, status: 'unclaimed', display, dashboard: null, job_status: null };
    }
    if (display.job_number === null) {
      return { ...base, status: 'unassigned', display, dashboard: null, job_status: null };
    }
    // Same as the api: a job the collector has not ingested yet has no dashboard.
    if (this.workOrder(display.job_number) === null) {
      return { ...base, status: 'assigned', display, dashboard: null, job_status: 'not_found' };
    }
    return {
      ...base,
      status: 'assigned',
      display,
      job_status: 'ok',
      dashboard: this.dashboard(display.job_number, {
        grouped: display.group_operators,
        shift_length_hours: display.shift_length_hours,
        show_std_day: display.show_std_day,
      }),
    };
  }

  adminUrl(): string {
    const base = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
    const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost:5173';
    return origin + base + 'admin';
  }

  // ---------------------------------------------------------------- dashboards

  private priorCounts(job_number: string, before: UtcMs): PriorCount[] {
    const map = new Map<string, PriorCount>();
    for (const s of this.jobSteps(job_number)) {
      if (s.complete_ts === null || s.complete_ts >= before) continue;
      const key = s.operation + '|' + s.operator_id;
      const row = map.get(key);
      if (row === undefined) {
        map.set(key, { operation: s.operation, operator_id: s.operator_id, units: 1 });
      } else {
        row.units += 1;
      }
    }
    return [...map.values()];
  }

  private priorDefects(job_number: string, before: UtcMs): { operation: string; count: number }[] {
    const map = new Map<string, number>();
    for (const d of this.jobDefects(job_number)) {
      if (d.found_ts >= before) continue;
      map.set(d.operation, (map.get(d.operation) ?? 0) + 1);
    }
    return [...map.entries()].map(([operation, count]) => ({ operation, count }));
  }

  dashboard(
    job_number: string,
    opts: { grouped?: boolean; shift_length_hours?: number; show_std_day?: boolean },
  ): TvDashboard {
    this.ensureWorld();
    const now = this.now();
    const work_order =
      this.workOrder(job_number) ??
      ({
        job_number,
        product_number: '',
        product_name: null,
        qty_released: 0,
        qty_complete: null,
        status: null,
        fl_created_at: null,
        fl_modified_at: null,
      } satisfies WorkOrder);
    const route = routeFor(work_order.product_number);
    const columns = rollingWindowColumns(now, this.tz, WINDOW_HOURS);
    const from = columns[0]!.hour_start_utc;
    const to = columns[columns.length - 1]!.hour_start_utc + HOUR;

    const cells = this.cells
      .cellsInRange(from, to)
      .filter((c) => c.job_number === job_number);
    const lookup = this.standardsLookup();
    const std_hr_by_operation: Record<string, number | null> = {};
    for (const op of route) {
      std_hr_by_operation[op] = effectiveStdHr(lookup, work_order.product_number, op);
    }
    for (const c of cells) {
      if (!(c.operation in std_hr_by_operation)) {
        std_hr_by_operation[c.operation] = effectiveStdHr(
          lookup,
          work_order.product_number,
          c.operation,
        );
      }
    }

    return buildTvDashboard({
      work_order,
      route,
      cells,
      prior: this.priorCounts(job_number, from),
      defect_cells: computeDefectHourCells(this.jobDefects(job_number), from, to, this.tz),
      prior_defects: this.priorDefects(job_number, from),
      columns,
      grouped: opts.grouped ?? false,
      show_std_day: opts.show_std_day ?? true,
      shift_length_hours: opts.shift_length_hours ?? 12,
      std_hr_by_operation,
      operator_names: OPERATOR_NAMES,
      derived_qty_complete: this.derivedQtyComplete(job_number),
      settings: this.engineSettings(),
      now,
    });
  }

  // -------------------------------------------------------------------- portal

  shiftPicker(): ShiftPickerResponse {
    this.ensureWorld();
    const now = this.now();
    return {
      current: findCurrentShift(this.shiftDefs, now, this.tz),
      most_recent: findCurrentOrMostRecentShift(this.shiftDefs, now, this.tz),
      shifts: this.shiftDefs,
    };
  }

  shiftInstances(from: UtcMs, to: UtcMs): ShiftInstanceListItem[] {
    const now = this.now();
    return listShiftInstances(this.shiftDefs, from, to, this.tz).map((s) => ({
      ...s,
      in_progress: s.start_utc <= now && now < s.end_utc,
    }));
  }

  private resolveShift(date?: string | null, shift_id?: number | null): ShiftInstance | null {
    const now = this.now();
    const valid = date != null && /^\d{4}-\d{2}-\d{2}$/.test(date);
    const anchor = valid ? new Date(date + 'T00:00:00Z').getTime() : NaN;
    if (valid && Number.isFinite(anchor)) {
      if (shift_id != null) {
        const def = this.shiftDefs.find((s) => s.id === shift_id);
        if (def !== undefined) return expandShiftInstance(def, date, this.tz);
      }
      const insts = listShiftInstances(
        this.shiftDefs,
        anchor - DAY,
        anchor + 2 * DAY,
        this.tz,
      ).filter((s) => s.date === date);
      if (insts.length > 0) return insts[0]!;
    }
    return findCurrentOrMostRecentShift(this.shiftDefs, now, this.tz);
  }

  shiftView(q: {
    date?: string | null;
    shift_id?: number | null;
    job?: string | null;
    product?: string | null;
    operation?: string | null;
    operator?: string | null;
  }): ShiftView {
    this.ensureWorld();
    const now = this.now();
    const shift =
      this.resolveShift(q.date, q.shift_id) ??
      ({
        shift_id: 0,
        name: 'No shift',
        date: new Date(now).toISOString().slice(0, 10),
        start_utc: hourStartUtc(now, this.tz) - 11 * HOUR,
        end_utc: hourStartUtc(now, this.tz) + HOUR,
      } satisfies ShiftInstance);
    const to = Math.min(shift.end_utc, hourStartUtc(now, this.tz) + HOUR);
    const cells = this.cells.cellsInRange(shift.start_utc, to);
    return buildShiftView({
      shift,
      cells,
      work_orders: this.workOrderList(),
      routes: this.routes(),
      active_job_numbers: this.activeJobNumbers(shift.start_utc, to),
      operator_names: OPERATOR_NAMES,
      derived_qty_complete: this.derivedQtyMap(),
      filters: {
        job: q.job ?? null,
        product: q.product ?? null,
        operation: q.operation ?? null,
        operator: q.operator ?? null,
      },
      settings: this.engineSettings(),
      now,
    });
  }

  floor(showVisitors: boolean): FloorView {
    this.ensureWorld();
    const now = this.now();
    const currentHour = hourStartUtc(now, this.tz);
    const window_cells = this.cells.cellsInRange(currentHour - (WINDOW_HOURS - 1) * HOUR, currentHour + HOUR);
    const current_cells = window_cells.filter((c) => c.hour_start_utc === currentHour);
    const view = buildFloorView({
      current_cells,
      window_cells,
      assignments: this.assignments(),
      operator_names: OPERATOR_NAMES,
      product_names: this.productNames(),
      settings: this.engineSettings(),
      now,
    });
    if (showVisitors) return view;
    return { ...view, rows: view.rows.filter((r) => !r.visitor) };
  }

  assignments(): OperatorAssignment[] {
    this.ensureWorld();
    const now = this.now();
    if (this.cells.assignmentsTimestamp < now - 30_000) this.cells.refreshCurrent();
    return this.cells.currentAssignments();
  }

  operators(q?: string): OperatorListItem[] {
    this.ensureWorld();
    const needle = (q ?? '').trim().toLowerCase();
    return OPERATORS.filter(
      (o) =>
        needle === '' ||
        o.operator_id.toLowerCase().includes(needle) ||
        o.display_name.toLowerCase().includes(needle),
    )
      .map((o) => ({
        operator_id: o.operator_id,
        display_name: o.display_name,
        last_seen_at: this.lastSeen.get(o.operator_id) ?? null,
      }))
      .sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''));
  }

  operatorDetail(
    id: string,
    q: { from?: UtcMs; to?: UtcMs; date?: string | null; shift_id?: number | null },
  ): OperatorDetail {
    this.ensureWorld();
    const now = this.now();
    let from: UtcMs;
    let to: UtcMs;
    if (q.from !== undefined && q.to !== undefined) {
      from = q.from;
      to = q.to;
    } else if (q.date != null && q.date !== '') {
      const shift = this.resolveShift(q.date, q.shift_id);
      from = shift ? shift.start_utc : hourStartUtc(now, this.tz) - 11 * HOUR;
      to = shift ? shift.end_utc : hourStartUtc(now, this.tz) + HOUR;
    } else {
      from = hourStartUtc(now, this.tz) - (WINDOW_HOURS - 1) * HOUR;
      to = hourStartUtc(now, this.tz) + HOUR;
    }
    const clampedTo = Math.min(to, hourStartUtc(now, this.tz) + HOUR);
    const cells = this.cells.cellsInRange(from, clampedTo).filter((c) => c.operator_id === id);
    const columns = hourColumns(from, clampedTo, this.tz).slice(-WINDOW_HOURS);
    const assignment = this.assignments().find((a) => a.operator_id === id) ?? null;
    return buildOperatorDetail({
      operator_id: id,
      operator_name: OPERATOR_NAMES[id] ?? id,
      cells,
      columns,
      assignment,
      pins: this.pins,
      product_names: this.productNames(),
      settings: this.engineSettings(),
      now,
      range: { from_utc: from, to_utc: clampedTo },
    });
  }

  jobs(q?: string, active?: boolean): JobListResponse {
    this.ensureWorld();
    const now = this.now();
    const needle = (q ?? '').trim().toLowerCase();
    const jobs: JobListItem[] = this.workOrderList()
      .map((w) => {
        const qty_complete_effective = this.derivedQtyComplete(w.job_number);
        const last_activity_at = this.lastActivity(w.job_number);
        return {
          ...w,
          qty_complete_effective,
          progress:
            w.qty_released > 0 ? Math.min(1, qty_complete_effective / w.qty_released) : 0,
          last_activity_at,
          active: last_activity_at !== null && last_activity_at >= now - 7 * DAY,
        };
      })
      .filter((j) => {
        if (active === true && !j.active) return false;
        if (needle === '') return true;
        return (
          j.job_number.toLowerCase().includes(needle) ||
          j.product_number.toLowerCase().includes(needle) ||
          (j.product_name ?? '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
    return { jobs };
  }

  jobDetail(job_number: string): JobDetail {
    this.ensureWorld();
    const now = this.now();
    const job = JOB_BY_NUMBER.get(job_number);
    const from = job
      ? Math.max(now - job.start_days_ago * DAY, now - HISTORY_DAYS * DAY)
      : now - 2 * DAY;
    const to = Math.min(
      job?.end_days_ago != null ? now - job.end_days_ago * DAY : now,
      now,
    );
    const all_cells = this.cells
      .cellsInRange(from, hourStartUtc(to, this.tz) + HOUR)
      .filter((c) => c.job_number === job_number);
    const shift_instances = listShiftInstances(
      this.shiftDefs,
      from,
      hourStartUtc(to, this.tz) + HOUR,
      this.tz,
    );
    return buildJobDetail({
      dashboard_separate: this.dashboard(job_number, { grouped: false }),
      dashboard_grouped: this.dashboard(job_number, { grouped: true }),
      all_cells,
      shift_instances,
      operator_names: OPERATOR_NAMES,
      displays_showing: this.displays
        .filter((d) => d.job_number === job_number && d.claimed_at !== null)
        .map((d) => ({ id: d.id, name: d.name })),
      settings: this.engineSettings(),
      now,
    });
  }

  products(q?: string): ProductListItem[] {
    this.ensureWorld();
    const needle = (q ?? '').trim().toLowerCase();
    return PRODUCTS.filter(
      (p) =>
        needle === '' ||
        p.product_number.toLowerCase().includes(needle) ||
        p.name.toLowerCase().includes(needle),
    ).map((p) => ({
      product_number: p.product_number,
      name: p.name,
      operations: p.route.length,
      standards_computed: this.standards.filter(
        (s) => s.product_number === p.product_number && s.computed_std_hr !== null,
      ).length,
    }));
  }

  productView(product_number: string): ProductView {
    this.ensureWorld();
    const product = PRODUCT_BY_NUMBER.get(product_number);
    return buildProductView({
      product_number,
      product_name: product?.name ?? null,
      route: product ? [...product.route] : [],
      standards: this.standards,
      adjustments: this.adjustments,
      overrides: this.overrides.filter((o) => o.active),
    });
  }

  // --------------------------------------------------- standards admin/actions

  createAdjustment(req: CreateAdjustmentRequest): StandardAdjustment {
    const adj: StandardAdjustment = {
      id: this.id('adjustment'),
      scope: req.scope,
      product_number: req.product_number ?? null,
      operation: req.operation ?? null,
      percent: req.percent,
      created_by: 'demo',
      created_at: this.now(),
      note: req.note,
    };
    this.adjustments.push(adj);
    this.bumpStandards();
    this.audit('create', 'standard_adjustment', String(adj.id), null, adj);
    return adj;
  }

  deleteAdjustment(id: number): void {
    const idx = this.adjustments.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const before = this.adjustments[idx]!;
    this.adjustments.splice(idx, 1);
    this.bumpStandards();
    this.audit('delete', 'standard_adjustment', String(id), before, null);
  }

  createOverride(product_number: string, req: CreateOverrideRequest): StandardOverride {
    const ov: StandardOverride = {
      id: this.id('override'),
      scope: req.scope,
      product_number: req.product_number || product_number,
      operation: req.operation ?? null,
      std_hr: req.std_hr,
      created_by: 'demo',
      created_at: this.now(),
      note: req.note,
      active: true,
    };
    this.overrides.push(ov);
    this.bumpStandards();
    this.audit('create', 'standard_override', String(ov.id), null, ov);
    return ov;
  }

  deleteOverride(id: number): void {
    const ov = this.overrides.find((o) => o.id === id);
    if (!ov) return;
    const before = { ...ov };
    ov.active = false;
    this.bumpStandards();
    this.audit('delete', 'standard_override', String(id), before, ov);
  }

  standardsAdmin(): StandardsAdminResponse {
    this.ensureWorld();
    return {
      adjustments: this.adjustments,
      overrides: this.overrides.filter((o) => o.active),
      operations: [...OPERATIONS],
      last_recompute_at: this.lastRecomputeAt,
    };
  }

  recomputeStandards(req: RecomputeStandardsRequest): void {
    this.ensureWorld();
    this.recomputeStandardsNow(req.product_number ?? null);
    this.audit('recompute', 'standards', req.product_number ?? null, null, {
      at: this.lastRecomputeAt,
    });
  }

  // ----------------------------------------------------------------------- pins

  pinList(q?: { operator_id?: string; job_number?: string }): PinListResponse {
    const now = this.now();
    return {
      pins: this.pins.filter(
        (p) =>
          (p.expires_at === null || p.expires_at > now) &&
          (q?.operator_id === undefined || p.operator_id === q.operator_id) &&
          (q?.job_number === undefined || p.job_number === q.job_number),
      ),
    };
  }

  createPin(req: CreatePinRequest): Pin {
    const pin: Pin = {
      id: this.id('pin'),
      operator_id: req.operator_id,
      job_number: req.job_number,
      operation: req.operation ?? null,
      mode: req.mode,
      created_by: 'demo',
      created_at: this.now(),
      expires_at: req.expires_at ?? null,
    };
    this.pins.push(pin);
    this.cells.clear();
    this.audit('create', 'pin', String(pin.id), null, pin);
    return pin;
  }

  deletePin(id: number): void {
    const idx = this.pins.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const before = this.pins[idx]!;
    this.pins.splice(idx, 1);
    this.cells.clear();
    this.audit('delete', 'pin', String(id), before, null);
  }

  // ------------------------------------------------------------------ displays

  claimDisplay(req: ClaimDisplayRequest): Display {
    this.ensureWorld();
    const display = this.displays.find((d) => d.pairing_code === req.pairing_code);
    if (display === undefined) throw new Error('No TV is showing that code');
    const before = { ...display };
    display.name = req.name;
    display.claimed_at = this.now();
    display.job_number = req.job_number ?? null;
    display.group_operators = req.group_operators ?? false;
    display.show_std_day = req.show_std_day ?? true;
    display.show_gauge = req.show_gauge ?? true;
    display.shift_length_hours = req.shift_length_hours ?? 12;
    this.audit('claim', 'display', String(display.id), before, display);
    this.emitDisplayUpdated(display.id);
    return display;
  }

  updateDisplay(id: number, req: UpdateDisplayRequest): Display {
    const display = this.displayById(id);
    if (display === null) throw new Error('Display not found');
    const before = { ...display };
    if (req.name !== undefined) display.name = req.name;
    if (req.job_number !== undefined) display.job_number = req.job_number;
    if (req.group_operators !== undefined) display.group_operators = req.group_operators;
    if (req.show_std_day !== undefined) display.show_std_day = req.show_std_day;
    if (req.show_gauge !== undefined) display.show_gauge = req.show_gauge;
    if (req.shift_length_hours !== undefined) display.shift_length_hours = req.shift_length_hours;
    this.audit('update', 'display', String(id), before, display);
    this.emitDisplayUpdated(id);
    return display;
  }

  repairDisplay(id: number, req: RepairDisplayRequest): Display {
    const display = this.displayById(id);
    if (display === null) throw new Error('Display not found');
    const temp = this.displays.find(
      (d) => d.pairing_code === req.pairing_code && d.id !== id,
    );
    if (temp === undefined) throw new Error('No TV is showing that code');
    const before = { ...display };
    display.pairing_code = temp.pairing_code;
    display.last_seen_at = temp.last_seen_at;
    display.online = temp.online;
    this.displays = this.displays.filter((d) => d.id !== temp.id);
    for (const [token, rec] of this.devices) {
      if (rec.display_id === temp.id) this.devices.set(token, { ...rec, display_id: id });
    }
    this.audit('repair', 'display', String(id), before, display);
    this.emitDisplayUpdated(id);
    return display;
  }

  deleteDisplay(id: number): void {
    const before = this.displayById(id);
    if (before === null) return;
    this.displays = this.displays.filter((d) => d.id !== id);
    for (const [token, rec] of this.devices) {
      if (rec.display_id === id) this.devices.delete(token);
    }
    this.audit('delete', 'display', String(id), before, null);
    this.emitDisplayUpdated(id);
  }

  // ------------------------------------------------------------ shifts/breaks

  createShift(req: ShiftWrite): ShiftDef {
    const shift: ShiftDef = { id: this.id('shift'), ...req };
    this.shiftDefs.push(shift);
    this.cells.clear();
    this.audit('create', 'shift', String(shift.id), null, shift);
    this.emitSettingsUpdated();
    return shift;
  }

  updateShift(id: number, req: ShiftWrite): ShiftDef {
    const idx = this.shiftDefs.findIndex((s) => s.id === id);
    if (idx < 0) throw new Error('Shift not found');
    const before = { ...this.shiftDefs[idx]! };
    const next: ShiftDef = { id, ...req };
    this.shiftDefs[idx] = next;
    this.cells.clear();
    this.audit('update', 'shift', String(id), before, next);
    this.emitSettingsUpdated();
    return next;
  }

  deleteShift(id: number): void {
    const before = this.shiftDefs.find((s) => s.id === id) ?? null;
    this.shiftDefs = this.shiftDefs.filter((s) => s.id !== id);
    this.cells.clear();
    this.audit('delete', 'shift', String(id), before, null);
    this.emitSettingsUpdated();
  }

  createBreak(req: BreakWrite): BreakDef {
    const br: BreakDef = { id: this.id('break'), ...req };
    this.breakDefs.push(br);
    this.cells.clear();
    this.audit('create', 'break', String(br.id), null, br);
    this.emitSettingsUpdated();
    return br;
  }

  updateBreak(id: number, req: BreakWrite): BreakDef {
    const idx = this.breakDefs.findIndex((b) => b.id === id);
    if (idx < 0) throw new Error('Break not found');
    const before = { ...this.breakDefs[idx]! };
    const next: BreakDef = { id, ...req };
    this.breakDefs[idx] = next;
    this.cells.clear();
    this.audit('update', 'break', String(id), before, next);
    this.emitSettingsUpdated();
    return next;
  }

  deleteBreak(id: number): void {
    const before = this.breakDefs.find((b) => b.id === id) ?? null;
    this.breakDefs = this.breakDefs.filter((b) => b.id !== id);
    this.cells.clear();
    this.audit('delete', 'break', String(id), before, null);
    this.emitSettingsUpdated();
  }

  // ---------------------------------------------------------------- settings

  settingsResponse(): SettingsResponse {
    return { settings: this.settings };
  }

  updateSettings(patch: SettingsPatch): SettingsResponse {
    const before = { ...this.settings };
    this.settings = { ...this.settings, ...patch };
    // Engine settings changes take effect on the next tick: drop cached cells.
    this.cells.clear();
    this.lookupCache = null;
    this.audit('update', 'settings', null, before, this.settings);
    this.emitSettingsUpdated();
    return this.settingsResponse();
  }

  connection(): ConnectionResponse {
    return { connection: { ...this.connectionConfig } };
  }

  updateConnection(req: { base_url: string; username: string; password?: string }): ConnectionResponse {
    const before = { ...this.connectionConfig };
    this.connectionConfig = {
      base_url: req.base_url,
      username: req.username,
      has_password: req.password ? true : before.has_password,
    };
    this.audit('update', 'connection', null, before, this.connectionConfig);
    this.emitSettingsUpdated();
    return this.connection();
  }

  testConnection(): ConnectionTestResult {
    return {
      ok: true,
      error: null,
      metadata: demoMetadata(this.now()),
      latency_ms: 120 + Math.floor(Math.random() * 90),
    };
  }

  metadata(): ODataMetadata {
    return demoMetadata(this.now());
  }

  mapping(): MappingResponse {
    return { mapping: this.mappingConfig, metadata: demoMetadata(this.now()) };
  }

  updateMapping(m: MappingConfig): MappingResponse {
    const before = clone(this.mappingConfig);
    this.mappingConfig = clone(m);
    this.audit('update', 'mapping', null, before, this.mappingConfig);
    this.emitSettingsUpdated();
    return this.mapping();
  }

  mappingPreview(req: MappingPreviewRequest): MappingPreviewResult {
    this.ensureWorld();
    const now = this.now();
    const dataset = req.dataset;
    const ds =
      dataset === 'work_orders'
        ? req.mapping.work_orders
        : dataset === 'unit_steps'
          ? req.mapping.unit_steps
          : (req.mapping[dataset] ?? null);
    const entity_set = ds?.entity_set ?? dataset;
    const fields = ds?.fields ?? {};
    const rows: Record<string, unknown>[] = [];
    const iso = (t: number | null): string | null =>
      t === null ? null : new Date(t).toISOString();

    const put = (row: Record<string, unknown>, target: string, value: unknown): void => {
      const source = fields[target];
      if (source) row[source] = value;
    };

    const warnings: string[] = [];
    let distinct_operators: number | null = null;
    let distinct_jobs: number | null = null;
    let start_present_pct: number | null = null;
    let complete_present_pct: number | null = null;
    let timestamp_skew_minutes: number | null = null;
    const sample_durations_minutes: number[] = [];

    if (dataset === 'unit_steps') {
      const sample = this.steps.slice(-50);
      const ops = new Set<string>();
      const jobs = new Set<string>();
      let withStart = 0;
      let withComplete = 0;
      let maxTs = 0;
      for (const s of sample) {
        const row: Record<string, unknown> = {};
        put(row, 'unit_id', s.unit_id);
        put(row, 'job_number', s.job_number);
        put(row, 'product_number', s.product_number);
        put(row, 'operation', s.operation);
        put(row, 'operation_seq', s.operation_seq);
        put(row, 'operator', s.operator_id);
        put(row, 'start_ts', iso(s.start_ts));
        put(row, 'complete_ts', iso(s.complete_ts));
        put(row, 'result', s.result);
        put(row, 'rework_flag', s.rework_flag);
        put(row, 'modified_at', iso(s.complete_ts ?? s.start_ts));
        rows.push(row);
        ops.add(s.operator_id);
        jobs.add(s.job_number);
        withStart += 1;
        if (s.complete_ts !== null) {
          withComplete += 1;
          sample_durations_minutes.push(
            Math.round(((s.complete_ts - s.start_ts) / MINUTE) * 10) / 10,
          );
          if (s.complete_ts > maxTs) maxTs = s.complete_ts;
        }
      }
      distinct_operators = ops.size;
      distinct_jobs = jobs.size;
      start_present_pct = sample.length === 0 ? null : (withStart / sample.length) * 100;
      complete_present_pct = sample.length === 0 ? null : (withComplete / sample.length) * 100;
      timestamp_skew_minutes = maxTs === 0 ? null : Math.round((now - maxTs) / MINUTE);
      if (fields.rework_flag == null) {
        warnings.push('rework_flag is not mapped: rework units cannot be excluded from standards.');
      }
      sample_durations_minutes.splice(12);
    } else if (dataset === 'work_orders') {
      for (const w of this.workOrderList().slice(0, 50)) {
        const row: Record<string, unknown> = {};
        put(row, 'job_number', w.job_number);
        put(row, 'product_number', w.product_number);
        put(row, 'product_name', w.product_name);
        put(row, 'qty_released', w.qty_released);
        put(row, 'qty_complete', w.qty_complete);
        put(row, 'status', w.status);
        put(row, 'created_at', iso(w.fl_created_at));
        put(row, 'modified_at', iso(w.fl_modified_at));
        rows.push(row);
      }
      distinct_jobs = rows.length;
      if (fields.qty_complete == null) {
        warnings.push('qty_complete is not mapped: job progress is derived from unit scans.');
      }
    } else if (dataset === 'defects') {
      for (const d of this.defects.slice(-50)) {
        const row: Record<string, unknown> = {};
        put(row, 'unit_id', d.unit_id);
        put(row, 'job_number', d.job_number);
        put(row, 'operation', d.operation);
        put(row, 'operator', d.operator_id);
        put(row, 'defect_code', d.defect_code);
        put(row, 'description', d.description);
        put(row, 'found_ts', iso(d.found_ts));
        put(row, 'status', d.status);
        put(row, 'modified_at', iso(d.found_ts));
        rows.push(row);
      }
      distinct_jobs = new Set(this.defects.slice(-50).map((d) => d.job_number)).size;
    } else if (dataset === 'operators') {
      for (const o of OPERATORS) {
        const row: Record<string, unknown> = {};
        put(row, 'operator_id', o.operator_id);
        put(row, 'display_name', o.display_name);
        rows.push(row);
      }
      distinct_operators = rows.length;
    } else if (dataset === 'routes') {
      for (const p of PRODUCTS) {
        p.route.forEach((op, i) => {
          const row: Record<string, unknown> = {};
          put(row, 'product_number', p.product_number);
          put(row, 'operation', op);
          put(row, 'sequence', i + 1);
          rows.push(row);
        });
      }
    } else {
      for (const p of PRODUCTS) {
        for (const op of p.route) {
          const row: Record<string, unknown> = {};
          put(row, 'product_number', p.product_number);
          put(row, 'operation', op);
          put(row, 'std_hr', FL_STD_HR[op] ?? null);
          rows.push(row);
        }
      }
    }

    const orderBy = ds?.watermark_field ? '&$orderby=' + ds.watermark_field + ' desc' : '';
    return {
      dataset,
      ok: true,
      error: null,
      query: `GET ${this.connectionConfig.base_url}/${entity_set}?$top=50${orderBy}`,
      rows: rows.slice(0, 50),
      checks: {
        distinct_operators,
        distinct_jobs,
        start_present_pct,
        complete_present_pct,
        timestamp_skew_minutes,
        sample_durations_minutes,
        warnings,
      },
    };
  }

  // -------------------------------------------------------------------- users

  createUser(req: CreateUserRequest): User {
    const user: User = {
      id: this.id('user'),
      username: req.username,
      role: req.role,
      active: true,
      created_at: this.now(),
      last_login_at: null,
    };
    this.users.push(user);
    this.audit('create', 'user', String(user.id), null, { ...user });
    return user;
  }

  updateUser(id: number, req: UpdateUserRequest): User {
    const user = this.users.find((u) => u.id === id);
    if (user === undefined) throw new Error('User not found');
    const before = { ...user };
    if (req.role !== undefined) user.role = req.role;
    if (req.active !== undefined) user.active = req.active;
    this.audit('update', 'user', String(id), before, { ...user });
    return user;
  }

  adminUser(): User {
    this.ensureWorld();
    return this.users.find((u) => u.role === 'admin') ?? this.users[0]!;
  }

  // ---------------------------------------------------------------- sync/admin

  syncLog(limit = 50): SyncLogEntry[] {
    this.ensureWorld();
    return this.syncLogEntries.slice(0, limit);
  }

  runBackfill(): void {
    this.backfill = {
      status: 'running',
      requested_now: true,
      days_total: this.settings.backfill_days,
      days_done: 0,
      current_day: null,
      started_at: this.now(),
      finished_at: null,
      error: null,
    };
    this.audit('run', 'backfill', null, null, { requested_now: true });
    this.emitSettingsUpdated();
  }
}
