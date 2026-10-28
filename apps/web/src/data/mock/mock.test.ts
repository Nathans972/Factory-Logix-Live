/**
 * Demo data-source tests (spec 12). These guard the things a reviewer sees:
 * a plausible world, standards that match the seeded rates, a TV dashboard with
 * 12 columns and legal colours, working portal views, and in-memory admin CRUD.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellColor, SseEvent } from '@fld/shared';
import { expandBreaks } from '@fld/engine';
import { MockDataSource } from './MockDataSource';
import { AUTO_CLAIM_MS, MockStore } from './state';
import { generateHistory } from './simulator/history';
import { startLiveSimulation } from './simulator/live';
import { mulberry32 } from './simulator/rng';
import {
  BASE_RATES,
  FEATURED_JOB,
  JOBS,
  OPERATIONS,
  OPERATORS,
  PRODUCTS,
  WORLD_SEED,
  initialBreaks,
  initialShifts,
} from './simulator/world';

const LEGAL_COLORS: CellColor[] = [
  'red',
  'yellow',
  'green',
  'blue',
  'visitor',
  'neutral',
  'blank',
];

// One shared instance: the world is generated once for the whole file.
const ds = new MockDataSource();
const store = ds.store;
const world = store.ensureWorld();

describe('simulated world', () => {
  it('matches the spec 12.3 shape', () => {
    expect(OPERATORS).toHaveLength(14);
    expect(new Set(OPERATORS.map((o) => o.operator_id)).size).toBe(14);
    for (const o of OPERATORS) {
      expect(o.display_name.length).toBeGreaterThan(3);
      expect(o.speed).toBeGreaterThan(0.5);
      expect(o.speed).toBeLessThan(1.5);
    }
    expect(PRODUCTS.map((p) => p.product_number)).toEqual(['PB-2200', 'IO-410', 'PS-900']);
    for (const p of PRODUCTS) {
      expect(p.route.length).toBeGreaterThanOrEqual(5);
      for (const op of p.route) expect(OPERATIONS).toContain(op);
    }
    for (const j of JOBS) {
      expect(j.job_number).toMatch(/^J\d{8}-\d{4}$/);
      expect(j.qty_released).toBeGreaterThanOrEqual(200);
      expect(j.qty_released).toBeLessThanOrEqual(800);
    }
    expect(JOBS.some((j) => j.job_number === FEATURED_JOB && j.end_days_ago === null)).toBe(true);
    expect(JOBS.some((j) => j.end_days_ago !== null)).toBe(true);
    expect(JOBS.some((j) => j.end_days_ago === null && j.start_days_ago < 1)).toBe(true);
  });

  it('uses a deterministic seeded PRNG', () => {
    const a = mulberry32(WORLD_SEED);
    const b = mulberry32(WORLD_SEED);
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBe(8);
    expect(Math.min(...seqA)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...seqA)).toBeLessThan(1);
  });

  it('generates the same history for the same (seed, now)', () => {
    const now = Date.UTC(2026, 5, 17, 15, 32, 0);
    const shifts = initialShifts();
    const breaks = expandBreaks(
      initialBreaks(),
      shifts,
      now - 32 * 86_400_000,
      now + 86_400_000,
      'America/New_York',
    );
    const a = generateHistory(now, shifts, breaks, WORLD_SEED);
    const b = generateHistory(now, shifts, breaks, WORLD_SEED);
    expect(a.steps.length).toBe(b.steps.length);
    expect(a.steps[0]).toEqual(b.steps[0]);
    expect(a.steps[a.steps.length - 1]).toEqual(b.steps[b.steps.length - 1]);
    expect(a.defects.length).toBe(b.defects.length);
  });

  it('stays inside the size and time budget', () => {
    // Cost of a cold boot: history + indexes + standards (what blocks the first paint).
    const t0 = Date.now();
    const cold = new MockStore();
    cold.ensureWorld();
    const bootMs = Date.now() - t0;
    console.log(
      `[demo] history: ${world.steps.length} steps, ${world.defects.length} defects, ` +
        `${world.generation_ms} ms generation, ${bootMs} ms cold boot ` +
        `(history + indexes + standards)`,
    );
    expect(world.steps.length).toBeGreaterThan(20_000);
    expect(world.steps.length).toBeLessThanOrEqual(120_000);
    expect(world.generation_ms).toBeLessThan(1500);
    expect(bootMs).toBeLessThan(1500);
  });

  it('produces sane unit steps', () => {
    const sample = world.steps.slice(-2000);
    for (const s of sample) {
      expect(s.start_ts).toBeLessThanOrEqual(world.timing.horizon);
      if (s.complete_ts !== null) expect(s.complete_ts).toBeGreaterThanOrEqual(s.start_ts);
      expect(s.operator_id.length).toBeGreaterThan(1);
    }
    // Steps are sorted by start so the cell cache index works.
    for (let i = 1; i < world.steps.length; i++) {
      expect(world.steps[i]!.start_ts).toBeGreaterThanOrEqual(world.steps[i - 1]!.start_ts);
    }
  });
});

describe('standards', () => {
  it('are computed per (product, operation) and track the seeded rates', () => {
    expect(store.standards.length).toBeGreaterThan(10);
    const checks: [string, string][] = [
      ['PB-2200', 'Selective Solder - Top'],
      ['PB-2200', 'Selective Solder - Bottom'],
      ['PB-2200', 'Functional Test'],
      ['PB-2200', 'Pack'],
    ];
    for (const [product, operation] of checks) {
      const std = store.standards.find(
        (s) => s.product_number === product && s.operation === operation,
      );
      expect(std, `${product} ${operation}`).toBeTruthy();
      expect(std!.computed_std_hr, `${product} ${operation} computed`).not.toBeNull();
      const base = BASE_RATES[operation]!;
      const got = std!.computed_std_hr!;
      console.log(`[demo] std ${product} ${operation}: ${got} (base ${base})`);
      expect(got).toBeGreaterThan(base * 0.65);
      expect(got).toBeLessThan(base * 1.35);
      expect(std!.sample_units).toBeGreaterThanOrEqual(20);
      expect(std!.sample_operators).toBeGreaterThanOrEqual(2);
    }
  });

  it('differ by operation', () => {
    const byOp = new Map<string, number>();
    for (const s of store.standards) {
      if (s.product_number !== 'PB-2200' || s.computed_std_hr === null) continue;
      byOp.set(s.operation, s.computed_std_hr);
    }
    expect(byOp.get('Functional Test')!).toBeLessThan(byOp.get('Selective Solder - Top')!);
    expect(byOp.get('Selective Solder - Top')!).toBeLessThan(byOp.get('Pack')!);
  });
});

describe('tv', () => {
  for (const token of ['demo-1', 'demo-2']) {
    it(`serves an assigned dashboard for ${token}`, async () => {
      const state = await ds.tvRegister(token);
      expect(state.status).toBe('assigned');
      expect(state.display).not.toBeNull();
      expect(state.plant_timezone).toBe('America/New_York');
      expect(state.admin_url).toContain('admin');
      expect(state.sync.status).toBe('ok');
      const dash = state.dashboard!;
      expect(dash.columns).toHaveLength(12);
      expect(dash.job.job_number).toBe(FEATURED_JOB);
      expect(dash.job.qty_released).toBeGreaterThan(0);
      expect(dash.job.progress).toBeGreaterThan(0);
      expect(dash.job.progress).toBeLessThanOrEqual(1);
      expect(dash.rows.length).toBeGreaterThan(2);
      for (const row of dash.rows) {
        expect(row.cells).toHaveLength(12);
        for (const cell of row.cells) expect(LEGAL_COLORS).toContain(cell.color);
      }
      expect(dash.grouped).toBe(token === 'demo-2');
      if (token === 'demo-1') {
        expect(dash.rows.some((r) => r.operator_id !== null)).toBe(true);
      } else {
        // grouped: a row names its operator only when exactly one operator worked the step
        expect(dash.rows.every((r) => r.operators.length > 0)).toBe(true);
        expect(dash.rows.every((r) => (r.operators.length === 1 ? r.operator_id === r.operators[0] : r.operator_id === null))).toBe(true);
      }
    });
  }

  it('shows the pairing screen for an unknown token, then auto-claims', async () => {
    const token = 'reviewer-' + Math.random().toString(36).slice(2);
    const state = await ds.tvRegister(token);
    expect(state.status).toBe('unclaimed');
    expect(state.pairing_code).toMatch(/^\d{4}$/);
    expect(state.dashboard).toBeNull();

    // ~8 s later the demo claims it so reviewers see both screens (spec 12.5).
    const realNow = Date.now.bind(Date);
    const later = realNow() + AUTO_CLAIM_MS + 500;
    Date.now = () => later;
    try {
      const claimed = store.tvState(token);
      expect(claimed.status).toBe('assigned');
      expect(claimed.display?.name).toBe('Demo TV');
      expect(claimed.display?.job_number).toBe(FEATURED_JOB);
      expect(claimed.display?.group_operators).toBe(false);
      expect(claimed.dashboard?.columns).toHaveLength(12);
    } finally {
      Date.now = realNow;
    }
  });

  it('plays the spec 12.4 scenarios on the featured job', async () => {
    const dash = await ds.dashboard(FEATURED_JOB, { grouped: false });
    const colors = new Set<CellColor>();
    for (const row of dash.rows) for (const c of row.cells) colors.add(c.color);
    // One operator blue, one green, one yellow, one red, plus a visitor and blank hours.
    for (const expected of ['blue', 'green', 'yellow', 'red', 'visitor', 'blank'] as CellColor[]) {
      expect([...colors], `missing ${expected} cells`).toContain(expected);
    }

    const rowColor = (operator_id: string, operation: string): CellColor[] => {
      const row = dash.rows.find(
        (r) => r.operator_id === operator_id && r.operation === operation,
      );
      expect(row, `${operator_id} on ${operation}`).toBeTruthy();
      return row!.cells.filter((c) => c.color !== 'blank').map((c) => c.color);
    };
    const majority = (cs: CellColor[]): CellColor => {
      const counts = new Map<CellColor, number>();
      for (const c of cs) counts.set(c, (counts.get(c) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    };
    expect(majority(rowColor('JRivera', 'Selective Solder - Top'))).toBe('blue');
    expect(majority(rowColor('LNguyen', 'Selective Solder - Top'))).toBe('red');
    expect(majority(rowColor('MChen', 'Selective Solder - Bottom'))).toBe('green');
    expect(majority(rowColor('TOkafor', 'Functional Test'))).toBe('yellow');

    // The visitor is eligible earlier in the window and a visitor later (spec 8.5).
    const visitorRow = dash.rows.find((r) => r.operator_id === 'SPatel' && r.operation === 'AOI')!;
    expect(visitorRow).toBeTruthy();
    expect(visitorRow.cells.some((c) => c.visitor && c.units > 0)).toBe(true);
    expect(visitorRow.cells.some((c) => c.eligible)).toBe(true);

    // The half-hour job switcher appears on both jobs.
    expect(dash.rows.some((r) => r.operator_id === 'AKowalski' && r.operation === 'ICT')).toBe(true);
    const other = await ds.dashboard('J00004715-0000', { grouped: false });
    expect(other.rows.some((r) => r.operator_id === 'AKowalski' && r.operation === 'ICT')).toBe(
      true,
    );

    // Defects trickle in on two operations.
    const withDefects = dash.defect_rows.filter((d) => d.shift_qty > 0);
    expect(withDefects.length).toBeGreaterThanOrEqual(1);
    expect(dash.defect_rows.length).toBeGreaterThan(0);

    // Grouped mode folds the visitor units into the operation row.
    const grouped = await ds.dashboard(FEATURED_JOB, { grouped: true });
    expect(grouped.rows.every((r) => (r.operators.length === 1 ? r.operator_id === r.operators[0] : r.operator_id === null))).toBe(true);
    // Selective Solder - Top has two operators in the window (blue + red scenario) => "Multiple Operators"
    expect(grouped.rows.find((r) => r.operation === "Selective Solder - Top")!.operators.length).toBeGreaterThan(1);
    const groupedTop = grouped.rows.find((r) => r.operation === 'Selective Solder - Top')!;
    expect(groupedTop.shift).toBeGreaterThan(
      dash.rows.find((r) => r.operator_id === 'JRivera')!.shift,
    );
  });

  it('reports job_status: ok for an assigned job, not_found for a job with no data, null when unassigned', async () => {
    expect((await ds.tvState('demo-1')).job_status).toBe('ok');
    const token = 'waiting-' + Math.random().toString(36).slice(2);
    const registered = await ds.tvRegister(token);
    const claimed = await ds.claimDisplay({ pairing_code: registered.pairing_code, name: 'New line', job_number: null });
    expect((await ds.tvState(token)).job_status).toBeNull();
    await ds.updateDisplay(claimed.id, { job_number: 'J09999999-0000' });
    const waiting = await ds.tvState(token);
    expect(waiting).toMatchObject({ status: 'assigned', job_status: 'not_found', dashboard: null });
    await ds.deleteDisplay(claimed.id);
  });

  it('has two displays on the featured job, one separate and one grouped', async () => {
    const displays = await ds.displays();
    const featured = displays.filter((d) => d.job_number === FEATURED_JOB);
    expect(featured.length).toBeGreaterThanOrEqual(2);
    expect(featured.some((d) => !d.group_operators)).toBe(true);
    expect(featured.some((d) => d.group_operators)).toBe(true);
  });
});

describe('portal views', () => {
  it('shiftView returns a shift with active jobs and a finite efficiency', async () => {
    const view = await ds.shiftView({});
    expect(view.shift.start_utc).toBeLessThanOrEqual(Date.now());
    expect(view.jobs.length).toBeGreaterThan(0);
    expect(view.summary.active_jobs).toBeGreaterThan(0);
    expect(view.summary.total_units).toBeGreaterThan(0);
    expect(view.summary.eligible_operators).toBeGreaterThan(0);
    const eff = view.summary.efficiency ?? view.rollups.overall.efficiency;
    expect(eff === null || Number.isFinite(eff)).toBe(true);
    expect(Number.isFinite(view.rollups.overall.charged_hours)).toBe(true);
    expect(view.rollups.by_operator.length).toBeGreaterThan(0);
  });

  it('floor returns rows', async () => {
    const floor = await ds.floor(true);
    for (const r of floor.rows) {
      expect(LEGAL_COLORS).toContain(r.color);
      expect(r.operator_name).toBeTruthy();
    }
    // The engine drops cells that are entirely inside a break (no units, no charged
    // minutes), so the current hour can legitimately be quiet mid-break. Fall back to
    // the rolling window in that case.
    if (floor.rows.length === 0) {
      const cells = store.cells.cellsInRange(floor.hour_start_utc - 11 * 3_600_000, floor.hour_start_utc);
      expect(cells.length).toBeGreaterThan(0);
    } else {
      expect(floor.rows.length).toBeGreaterThan(0);
    }
    expect(store.assignments().length).toBeGreaterThan(5);
    const withoutVisitors = await ds.floor(false);
    expect(withoutVisitors.rows.every((r) => !r.visitor)).toBe(true);
  });

  it('operators / operatorDetail work', async () => {
    const list = await ds.operators();
    expect(list).toHaveLength(14);
    const detail = await ds.operatorDetail('JRivera', {});
    expect(detail.operator_id).toBe('JRivera');
    expect(detail.operator_name).toBeTruthy();
    expect(detail.rows.length).toBeGreaterThan(0);
    expect(detail.strips.length).toBeGreaterThan(0);
    for (const strip of detail.strips) {
      for (const c of strip.cells) expect(LEGAL_COLORS).toContain(c.color);
    }
  });

  it('jobs / jobDetail work', async () => {
    const { jobs } = await ds.jobs();
    expect(jobs.length).toBe(JOBS.length);
    expect(jobs.some((j) => j.active)).toBe(true);
    const detail = await ds.jobDetail(FEATURED_JOB);
    expect(detail.dashboard_separate.columns).toHaveLength(12);
    expect(detail.dashboard_grouped.grouped).toBe(true);
    expect(detail.operators.length).toBeGreaterThan(0);
    expect(detail.shift_history.length).toBeGreaterThan(0);
    expect(detail.displays_showing.length).toBeGreaterThan(0);
  });

  it('products / productView work', async () => {
    const products = await ds.products();
    expect(products).toHaveLength(3);
    expect(products[0]!.standards_computed).toBeGreaterThan(0);
    const view = await ds.productView('PB-2200');
    expect(view.rows.length).toBe(10);
    for (const row of view.rows) {
      expect(row.effective.provenance).toBeTruthy();
    }
    expect(view.rows.some((r) => r.effective.effective !== null)).toBe(true);
  });

  it('shiftPicker and shiftInstances work', async () => {
    const picker = await ds.shiftPicker();
    expect(picker.shifts).toHaveLength(2);
    expect(picker.most_recent).not.toBeNull();
    const now = Date.now();
    const instances = await ds.shiftInstances(now - 3 * 86_400_000, now);
    expect(instances.length).toBeGreaterThan(3);
  });
});

describe('admin (in memory)', () => {
  it('round-trips displays, shifts, breaks, settings, pins and standards', async () => {
    const auditBefore = (await ds.audit(200)).total;

    // Displays
    const displaysBefore = await ds.displays();
    const unclaimed = displaysBefore.find((d) => d.claimed_at === null)!;
    expect(unclaimed).toBeTruthy();
    const claimed = await ds.claimDisplay({
      pairing_code: unclaimed.pairing_code,
      name: 'Cell 7 TV',
      job_number: FEATURED_JOB,
      group_operators: true,
    });
    expect(claimed.name).toBe('Cell 7 TV');
    expect(claimed.claimed_at).not.toBeNull();
    const updated = await ds.updateDisplay(claimed.id, { name: 'Cell 7 TV (north)' });
    expect(updated.name).toBe('Cell 7 TV (north)');
    await ds.deleteDisplay(claimed.id);
    expect((await ds.displays()).some((d) => d.id === claimed.id)).toBe(false);

    // Shifts
    const shift = await ds.createShift({
      name: 'Swing',
      start_local: '13:00',
      end_local: '21:00',
      days_of_week: [1, 2, 3, 4, 5],
      effective_from: '2026-01-01',
      effective_to: null,
    });
    expect(shift.id).toBeGreaterThan(0);
    const shiftUpdated = await ds.updateShift(shift.id, {
      name: 'Swing B',
      start_local: '13:00',
      end_local: '21:00',
      days_of_week: [1, 2, 3, 4, 5],
      effective_from: '2026-01-01',
      effective_to: null,
    });
    expect(shiftUpdated.name).toBe('Swing B');
    await ds.deleteShift(shift.id);
    expect((await ds.shifts()).some((s) => s.id === shift.id)).toBe(false);

    // Breaks
    const br = await ds.createBreak({
      name: 'Stretch',
      start_local: '10:45',
      duration_minutes: 10,
      days_of_week: [1, 2, 3, 4, 5],
      shift_ids: [1],
      effective_from: '2026-01-01',
      effective_to: null,
    });
    expect((await ds.breaks()).some((b) => b.id === br.id)).toBe(true);
    await ds.deleteBreak(br.id);
    expect((await ds.breaks()).some((b) => b.id === br.id)).toBe(false);

    // Settings
    const before = await ds.settings();
    const after = await ds.updateSettings({ neutral_minutes: 7 });
    expect(after.settings.neutral_minutes).toBe(7);
    await ds.updateSettings({ neutral_minutes: before.settings.neutral_minutes });

    // Pins
    const pin = await ds.createPin({
      operator_id: 'SPatel',
      job_number: FEATURED_JOB,
      operation: 'AOI',
      mode: 'force_eligible',
    });
    expect((await ds.pins()).pins.some((p) => p.id === pin.id)).toBe(true);
    await ds.deletePin(pin.id);
    expect((await ds.pins()).pins.some((p) => p.id === pin.id)).toBe(false);

    // Standards adjustments + overrides
    const adj = await ds.createProductAdjustment('PB-2200', {
      scope: 'product',
      product_number: 'PB-2200',
      percent: -10,
      note: 'New fixture',
    });
    const withAdj = await ds.productView('PB-2200');
    expect(withAdj.adjustments.some((a) => a.id === adj.id)).toBe(true);
    await ds.deleteAdjustment(adj.id);

    const ov = await ds.createOverride('PB-2200', {
      scope: 'product_operation',
      product_number: 'PB-2200',
      operation: 'Pack',
      std_hr: 55,
      note: 'Customer agreed rate',
    });
    const packRow = (await ds.productView('PB-2200')).rows.find((r) => r.operation === 'Pack')!;
    expect(packRow.effective.effective).toBe(55);
    expect(packRow.effective.provenance).toBe('override_product_operation');
    await ds.deleteOverride(ov.id);

    // Users
    const user = await ds.createUser({ username: 'newlead', password: 'x', role: 'viewer' });
    const promoted = await ds.updateUser(user.id, { role: 'manager' });
    expect(promoted.role).toBe('manager');

    // Sync + backfill + mapping
    expect((await ds.syncLog(5)).length).toBe(5);
    await ds.runBackfill();
    expect((await ds.syncHealth()).backfill?.status).toBe('running');
    const test = await ds.testConnection();
    expect(test.ok).toBe(true);
    expect(test.metadata?.entity_sets.map((e) => e.name)).toContain('UnitProcessHistory');
    const mapping = await ds.mapping();
    expect(mapping.mapping?.unit_steps.entity_set).toBe('UnitProcessHistory');
    const preview = await ds.mappingPreview({
      mapping: mapping.mapping!,
      dataset: 'unit_steps',
    });
    expect(preview.ok).toBe(true);
    expect(preview.rows).toHaveLength(50);
    expect(preview.checks.distinct_operators).toBeGreaterThan(0);
    expect(preview.checks.complete_present_pct).not.toBeNull();

    const auditAfter = await ds.audit(200);
    expect(auditAfter.total).toBeGreaterThan(auditBefore);
    expect(auditAfter.entries[0]!.action.length).toBeGreaterThan(0);
  });

  it('health / me / setupStatus work without login', async () => {
    const health = await ds.health();
    expect(health.demo).toBe(true);
    expect(health.needs_setup).toBe(false);
    expect(health.plant_timezone).toBe('America/New_York');
    const me = await ds.me();
    expect(me.user?.role).toBe('admin');
    const setup = await ds.setupStatus();
    expect(setup.needs_setup).toBe(false);
    expect(Object.values(setup.steps).every(Boolean)).toBe(true);
    const login = await ds.login({ username: 'anything', password: 'anything' });
    expect(login.user).not.toBeNull();
    await ds.logout();
    expect((await ds.me()).user).not.toBeNull();

    // Seeded users preview their role; logging out goes back to the demo admin.
    expect((await ds.login({ username: 'kpatterson', password: 'x' })).user?.role).toBe('manager');
    expect((await ds.me()).user?.role).toBe('manager');
    expect((await ds.login({ username: 'FloorLead', password: 'x' })).user?.role).toBe('viewer');
    await ds.logout();
    expect((await ds.me()).user?.role).toBe('admin');
  });

  it('emits events to subscribers', async () => {
    const seen: string[] = [];
    const off = ds.subscribe((e) => seen.push(e.type));
    await ds.updateDisplay(1, { show_gauge: true });
    await ds.updateSettings({ neutral_minutes: 5 });
    store.emitDataUpdated([Date.now()]);
    off();
    expect(seen).toContain('display_updated');
    expect(seen).toContain('settings_updated');
    expect(seen).toContain('data_updated');
  });

  it('lets a manager change only the job a TV shows', async () => {
    const tvs = await ds.tvDisplays();
    const tv = tvs.find((d) => d.claimed_at !== null)!;
    const other = JOBS.find((j) => j.job_number !== tv.job_number)!.job_number;
    const auditBefore = (await ds.audit(1)).total;
    const seen: SseEvent[] = [];
    const off = ds.subscribe((e) => seen.push(e));

    const changed = await ds.setDisplayJob(tv.id, { job_number: other });
    expect(changed.job_number).toBe(other);
    expect(changed.name).toBe(tv.name);
    expect(changed.group_operators).toBe(tv.group_operators);
    expect((await ds.tvDisplays()).find((d) => d.id === tv.id)!.job_number).toBe(other);
    expect(seen.some((e) => e.type === 'display_updated' && e.display_id === tv.id)).toBe(true);
    const log = await ds.audit(1);
    expect(log.total).toBe(auditBefore + 1);
    expect(log.entries[0]!.action).toBe('job_changed');

    expect((await ds.setDisplayJob(tv.id, { job_number: null })).job_number).toBeNull();
    await ds.setDisplayJob(tv.id, { job_number: tv.job_number });
    off();
    await expect(ds.setDisplayJob(99_999, { job_number: other })).rejects.toThrow();
  });

  it('announces both displays on a re-pair, like the API, so the TV on the temporary one refetches', async () => {
    const token = () => 'repair-' + Math.random().toString(36).slice(2);
    const first = await ds.tvRegister(token());
    const existing = await ds.claimDisplay({ pairing_code: first.pairing_code, name: 'Re-pair test' });
    const replacement = await ds.tvRegister(token());
    const seen: SseEvent[] = [];
    const off = ds.subscribe((e) => seen.push(e));
    await ds.repairDisplay(existing.id, { pairing_code: replacement.pairing_code });
    off();
    const ids = seen.flatMap((e) => (e.type === 'display_updated' ? [e.display_id] : []));
    expect(ids).toEqual(expect.arrayContaining([existing.id, replacement.display!.id]));
  });
});

describe('live simulation', () => {
  afterEach(() => vi.useRealTimers());

  it('appends steps when advanced, faster at higher speed', () => {
    // Pin the clock to a Tuesday 10:00 plant time (America/New_York). The scripted cast
    // pauses for breaks (09:30, 12:00, ... and the night-shift set), so a real-clock run
    // inside a break window would legitimately produce zero units and fail here.
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 15, 14, 0, 0), toFake: ['Date'] });
    const s = new MockStore();
    s.ensureWorld();
    const before = s.cells.cellsInRange(Date.now() - 3_600_000, Date.now() + 3_600_000).length;
    expect(before).toBeGreaterThan(0);
    const slow = s.advanceTo(Date.now() + 2 * 60_000, 1).length;
    const fast = s.advanceTo(Date.now() + 4 * 60_000, 6).length;
    expect(slow).toBeGreaterThan(0);
    // Speed multiplies the rate of simulated events, not the clock.
    expect(fast).toBeGreaterThan(slow);
    // New steps keep the array sorted by start_ts (the cell cache relies on it).
    const w = s.ensureWorld();
    for (let i = 1; i < w.steps.length; i++) {
      expect(w.steps[i]!.start_ts).toBeGreaterThanOrEqual(w.steps[i - 1]!.start_ts);
    }
  });
});

describe('reviewer controls', () => {
  it('installs window.__fldDemo and honours ?speed=', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const hadWindow = 'window' in g;
    const hadLocation = 'location' in g;
    g.location = { origin: 'https://example.test', search: '?speed=8' };
    g.window = g;
    try {
      const s = new MockStore();
      s.ensureWorld();
      const control = startLiveSimulation(s);
      try {
        const demo = (g.window as Record<string, unknown>).__fldDemo as typeof control;
        expect(demo).toBeTruthy();
        expect(typeof demo.setSpeed).toBe('function');
        expect(typeof demo.getSpeed).toBe('function');
        expect(typeof demo.state).toBe('function');
        expect(demo.getSpeed()).toBe(8);
        demo.setSpeed(2);
        expect(demo.getSpeed()).toBe(2);
        const state = demo.state() as { featured_job: string; displays: unknown[] };
        expect(state.featured_job).toBe(FEATURED_JOB);
        expect(state.displays.length).toBeGreaterThan(0);
        // The admin URL is derived from location.origin + BASE_URL.
        expect(s.adminUrl()).toBe('https://example.test/admin');
      } finally {
        control.stop();
      }
    } finally {
      if (!hadWindow) delete g.window;
      if (!hadLocation) delete g.location;
    }
  });
});

/**
 * The world is anchored to the real clock, so these cases pin the behaviour at times of
 * day the CI clock may never hit: break hours, hour boundaries and both DST transitions.
 */
describe('time-of-day robustness', () => {
  const realNow = Date.now.bind(Date);
  const CASES: [string, number][] = [
    ['day shift mid-morning', Date.UTC(2026, 4, 12, 14, 12, 0)],
    ['day shift inside the 14:00 break', Date.UTC(2026, 4, 12, 18, 5, 0)],
    ['exact hour boundary', Date.UTC(2026, 4, 12, 17, 0, 0)],
    ['just after local midnight', Date.UTC(2026, 4, 12, 4, 3, 0)],
    ['DST fall back night', Date.UTC(2026, 10, 1, 6, 30, 0)],
    ['DST spring forward morning', Date.UTC(2026, 2, 8, 11, 30, 0)],
    ['winter day shift', Date.UTC(2026, 1, 3, 20, 41, 0)],
  ];

  for (const [label, at] of CASES) {
    it(label, () => {
      Date.now = () => at;
      try {
        const s = new MockStore();
        const w = s.ensureWorld();
        expect(w.steps.length).toBeGreaterThan(20_000);
        expect(w.steps.length).toBeLessThanOrEqual(120_000);

        const dash = s.dashboard(FEATURED_JOB, { grouped: false });
        expect(dash.columns).toHaveLength(12);
        expect(dash.rows.length).toBeGreaterThan(3);
        const colors = new Set<CellColor>();
        for (const r of dash.rows) for (const c of r.cells) colors.add(c.color);
        for (const c of ['blue', 'green', 'yellow', 'red', 'visitor'] as CellColor[]) {
          expect([...colors], label + ' is missing ' + c + ' cells').toContain(c);
        }
        for (const c of colors) expect(LEGAL_COLORS).toContain(c);

        expect(s.shiftView({}).jobs.length).toBeGreaterThan(0);
        expect(s.jobDetail(FEATURED_JOB).shift_history.length).toBeGreaterThan(0);
        expect(s.operatorDetail('JRivera', {}).rows.length).toBeGreaterThan(0);
        expect(s.productView('PB-2200').rows).toHaveLength(10);
        expect(s.assignments().length).toBeGreaterThan(5);
        const pack = s.standards.find(
          (x) => x.product_number === 'PB-2200' && x.operation === 'Pack',
        );
        expect(pack?.computed_std_hr).toBeGreaterThan(60 * 0.65);
        expect(pack?.computed_std_hr).toBeLessThan(60 * 1.35);
      } finally {
        Date.now = realNow;
      }
    });
  }
});
