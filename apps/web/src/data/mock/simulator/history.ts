/**
 * Seeded generation of 30 days of `unit_steps` + `defects` ending at the real "now"
 * (spec 12.3), plus the scripted actors that both the history tail and the live
 * simulator (live.ts) share so the hand-off at page load is seamless.
 *
 * Everything here is deterministic given (seed, now): the same page load always
 * produces the same factory.
 */
import type { BreakInterval, Defect, ShiftDef, ShiftInstance, UnitStep, UtcMs } from '@fld/shared';
import { listShiftInstances } from '@fld/engine';
import { hashString, mulberry32, type Rng } from './rng';
import {
  BASE_RATES,
  DEFECT_CODES,
  DEFECT_OPERATIONS,
  FEATURED_JOB,
  HISTORY_DAYS,
  JOBS,
  JOB_BY_NUMBER,
  NEW_JOB,
  OPERATORS,
  OPERATOR_BY_ID,
  PLANT_TZ,
  SECONDARY_JOB,
  VISITOR_HOME_JOB,
  WORLD_SEED,
  routeFor,
  type DemoJob,
  type DemoOperator,
} from './world';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Hours of scripted (demo-scenario) activity before `now`; covers the whole TV window. */
export const SCRIPT_HOURS = 13;

/** Longest step the generator can produce (forgotten scan-out). Bounds the step index lookback. */
export const MAX_STEP_SPAN_MS = 4 * HOUR;

// ---------------------------------------------------------------------------
// Break helpers
// ---------------------------------------------------------------------------

/** First break interval containing `t`, using binary search over sorted intervals. */
function breakAt(breaks: BreakInterval[], t: UtcMs): BreakInterval | null {
  let lo = 0;
  let hi = breaks.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid]!.start_utc <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Scan back a few entries: intervals never overlap much in this world.
  for (let i = best; i >= 0 && i > best - 4; i--) {
    const b = breaks[i]!;
    if (b.start_utc <= t && t < b.end_utc) return b;
  }
  return null;
}

/** Earliest break that overlaps [a, b), or null. */
function breakOverlapping(breaks: BreakInterval[], a: UtcMs, b: UtcMs): BreakInterval | null {
  const inside = breakAt(breaks, a);
  if (inside) return inside;
  // Find the first break starting at/after `a`.
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid]!.start_utc < a) lo = mid + 1;
    else hi = mid;
  }
  const nxt = breaks[lo];
  if (nxt && nxt.start_utc < b) return nxt;
  return null;
}

// ---------------------------------------------------------------------------
// Unit allocation
// ---------------------------------------------------------------------------

export class UnitAllocator {
  private counters = new Map<string, number>();

  constructor(private jobs: Map<string, DemoJob>) {}

  /** Next serial for (job, operation), or null when the final route operation is exhausted. */
  next(job_number: string, operation: string): string | null {
    const key = job_number + '|' + operation;
    const n = (this.counters.get(key) ?? 0) + 1;
    const job = this.jobs.get(job_number);
    if (job) {
      const route = routeFor(job.product_number);
      // Only the last route operation is capped: it drives derived qty_complete.
      if (route.length > 0 && route[route.length - 1] === operation && n > job.qty_released) {
        return null;
      }
    }
    this.counters.set(key, n);
    // "J00004673-0000" -> "4673" for compact unit serials like NB-4673-00001
    const short = job_number.replace(/^J0*/, '').replace(/-\d+$/, '');
    return 'NB-' + short + '-' + String(n).padStart(5, '0');
  }

  count(job_number: string, operation: string): number {
    return this.counters.get(job_number + '|' + operation) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Low-level unit-step generation
// ---------------------------------------------------------------------------

export interface GenContext {
  rng: Rng;
  breaks: BreakInterval[];
  alloc: UnitAllocator;
  push: (s: UnitStep) => void;
}

export interface GenSpan {
  operator: DemoOperator;
  job_number: string;
  operation: string;
  from: UtcMs;
  to: UtcMs;
  /** Live speed multiplier (1 = real time). */
  speed: number;
  /** Cursor carried across calls (live simulation). */
  cursor?: UtcMs;
  openStep?: UnitStep | null;
  /** Emit an in-progress step when the last unit does not finish before `to`. */
  allowOpen: boolean;
  /** Mark the produced steps as rework (visitor scan-throughs). */
  rework?: boolean;
  /** Probability that a scan turns into a 5-10 unit batch (0 = never). */
  batchProb?: number;
  maxBatch?: number;
  /** Log-normal duration spread; smaller = steadier hourly counts. */
  noiseSpread?: number;
  /** Probability of an extra "forgotten scan-out" unit. */
  longScanProb?: number;
}

export interface GenResult {
  cursor: UtcMs;
  openStep: UnitStep | null;
}

function makeStep(
  span: GenSpan,
  product_number: string,
  operation_seq: number | null,
  unit_id: string,
  start_ts: UtcMs,
  complete_ts: UtcMs | null,
): UnitStep {
  return {
    unit_id,
    job_number: span.job_number,
    product_number,
    operation: span.operation,
    operation_seq,
    operator_id: span.operator.operator_id,
    start_ts,
    complete_ts,
    result: complete_ts === null ? null : 'PASS',
    rework_flag: span.rework ? true : null,
  };
}

/**
 * Emit back-to-back unit scans for one operator on one (job, operation) between
 * `from` and `to`, pausing for breaks. Durations come from the operation base rate
 * times the operator speed factor times log-normal noise with median 1 (so computed
 * standards land on the base rate).
 */
export function generateSpan(ctx: GenContext, span: GenSpan): GenResult {
  const job = JOB_BY_NUMBER.get(span.job_number);
  if (!job) return { cursor: span.to, openStep: span.openStep ?? null };
  const product_number = job.product_number;
  const route = routeFor(product_number);
  const seqIdx = route.indexOf(span.operation);
  const operation_seq = seqIdx >= 0 ? seqIdx + 1 : null;

  const rate = (BASE_RATES[span.operation] ?? 30) * span.operator.speed * Math.max(0.05, span.speed);
  const meanMs = (60 / rate) * MINUTE;

  let cursor = Math.max(span.cursor ?? span.from, span.from);
  let open = span.openStep ?? null;

  // Finish the unit that was in progress at the previous tick.
  if (open !== null) {
    const planned = (open as UnitStep & { __plannedComplete?: number }).__plannedComplete;
    const done = planned ?? cursor;
    if (done <= span.to) {
      open.complete_ts = done;
      open.result = 'PASS';
      cursor = done + ctx.rng.int(1000, 4000);
      open = null;
    } else {
      return { cursor, openStep: open };
    }
  }

  let guard = 0;
  while (cursor < span.to && guard++ < 20000) {
    const inBreak = breakAt(ctx.breaks, cursor);
    if (inBreak) {
      cursor = inBreak.end_utc + ctx.rng.int(5_000, 90_000);
      continue;
    }

    // Occasional batching: scan 5-10 units in, then out together.
    const batchProb = span.batchProb ?? 0.05;
    const maxBatch = span.maxBatch ?? 10;
    const n = batchProb > 0 && ctx.rng.chance(batchProb) ? ctx.rng.int(5, maxBatch) : 1;
    const spread = span.noiseSpread ?? 0.22;
    let total = 0;
    for (let i = 0; i < n; i++) total += meanMs * ctx.rng.noise(spread);
    const end = cursor + total;

    const clash = breakOverlapping(ctx.breaks, cursor, end);
    if (clash !== null) {
      cursor = clash.end_utc + ctx.rng.int(5_000, 90_000);
      continue;
    }

    if (end > span.to) {
      if (!span.allowOpen || n > 1) break;
      const unit = ctx.alloc.next(span.job_number, span.operation);
      if (unit === null) break;
      const step = makeStep(span, product_number, operation_seq, unit, cursor, null);
      (step as UnitStep & { __plannedComplete?: number }).__plannedComplete = end;
      ctx.push(step);
      open = step;
      return { cursor, openStep: open };
    }

    for (let i = 0; i < n; i++) {
      const unit = ctx.alloc.next(span.job_number, span.operation);
      if (unit === null) return { cursor: span.to, openStep: null };
      ctx.push(makeStep(span, product_number, operation_seq, unit, cursor, end));
    }

    // Rare forgotten scan-out: an extra overlapping unit with an implausible duration.
    if (ctx.rng.chance(span.longScanProb ?? 0.0025)) {
      const unit = ctx.alloc.next(span.job_number, span.operation);
      if (unit !== null) {
        const long = ctx.rng.range(1.6 * HOUR, MAX_STEP_SPAN_MS);
        ctx.push(makeStep(span, product_number, operation_seq, unit, cursor, cursor + long));
      }
    }

    cursor = end + ctx.rng.int(1000, 4000);
  }

  return { cursor, openStep: open };
}

// ---------------------------------------------------------------------------
// Scripted actors (spec 12.4)
// ---------------------------------------------------------------------------

export interface ActorSegment {
  job_number: string;
  operation: string;
  from: UtcMs;
  to: UtcMs;
  rework?: boolean;
}

export interface Actor {
  id: string;
  operator: DemoOperator;
  /**
   * True for the four colour-demo operators (spec 12.4): no batching and tighter noise
   * so their rows read cleanly as blue / green / yellow / red hour after hour.
   */
  clean?: boolean;
  /** Segments of scanning activity overlapping [from, to). */
  segments(from: UtcMs, to: UtcMs, ctx: ActorTiming): ActorSegment[];
}

export interface ActorTiming {
  /** Start of the scripted window (hour aligned, SCRIPT_HOURS before page load). */
  scriptStart: UtcMs;
  /** Far future bound used when an actor runs "forever". */
  horizon: UtcMs;
}

function clampSegments(segs: ActorSegment[], from: UtcMs, to: UtcMs): ActorSegment[] {
  const out: ActorSegment[] = [];
  for (const s of segs) {
    const a = Math.max(s.from, from);
    const b = Math.min(s.to, to);
    if (b > a) out.push({ ...s, from: a, to: b });
  }
  out.sort((x, y) => x.from - y.from);
  return out;
}

function steadyActor(
  operator_id: string,
  job_number: string,
  operation: string,
  fromHours: number,
  toHours: number | null,
  clean = false,
): Actor {
  const operator = OPERATOR_BY_ID.get(operator_id)!;
  return {
    id: operator_id + '@' + job_number + '/' + operation,
    operator,
    clean,
    segments(from, to, timing) {
      const a = timing.scriptStart + fromHours * HOUR;
      const b = toHours === null ? timing.horizon : timing.scriptStart + toHours * HOUR;
      return clampSegments([{ job_number, operation, from: a, to: b }], from, to);
    },
  };
}

/** Spec 12.4: works Job A for the first half of every hour and Job B for the second half. */
function halfHourSwitchActor(
  operator_id: string,
  operation: string,
  jobA: string,
  jobB: string,
): Actor {
  const operator = OPERATOR_BY_ID.get(operator_id)!;
  return {
    id: operator_id + '@switch/' + operation,
    operator,
    segments(from, to, timing) {
      const segs: ActorSegment[] = [];
      const start = Math.max(from, timing.scriptStart);
      let h = Math.floor(start / HOUR) * HOUR;
      while (h < to) {
        segs.push({ job_number: jobA, operation, from: h, to: h + 30 * MINUTE });
        segs.push({ job_number: jobB, operation, from: h + 30 * MINUTE, to: h + HOUR });
        h += HOUR;
      }
      return clampSegments(segs, Math.max(from, timing.scriptStart), to);
    },
  };
}

/**
 * Spec 12.4: an operator who owns the featured job early in the window, moves to her own
 * job, and comes back for ~2 minutes at :40 past each hour to scan 6 rework boards.
 * Because she is eligible earlier in the window the row is shown (grey visitor cells),
 * which is what spec 8.5 asks for.
 */
function visitorActor(operator_id: string, operation: string, ownedHours: number): Actor {
  const operator = OPERATOR_BY_ID.get(operator_id)!;
  return {
    id: operator_id + '@visitor/' + operation,
    operator,
    segments(from, to, timing) {
      const segs: ActorSegment[] = [];
      const switchAt = timing.scriptStart + ownedHours * HOUR;
      segs.push({ job_number: FEATURED_JOB, operation, from: timing.scriptStart, to: switchAt });
      segs.push({ job_number: VISITOR_HOME_JOB, operation, from: switchAt, to: timing.horizon });
      // Rework visits: 6 boards in ~2 minutes at :40 past the hour, after the hand-off.
      let h = Math.floor(Math.max(from, switchAt) / HOUR) * HOUR;
      while (h < to) {
        const burstStart = h + 40 * MINUTE;
        if (burstStart >= switchAt) {
          segs.push({
            job_number: FEATURED_JOB,
            operation,
            from: burstStart,
            to: burstStart + 2 * MINUTE,
            rework: true,
          });
        }
        h += HOUR;
      }
      // Rework bursts win over the home-job segment for their two minutes.
      const bursts = segs.filter((s) => s.rework);
      const base = segs.filter((s) => !s.rework);
      const split: ActorSegment[] = [];
      for (const b of base) {
        let cur = b.from;
        for (const burst of bursts) {
          if (burst.from >= b.to || burst.to <= cur) continue;
          if (burst.from > cur) split.push({ ...b, from: cur, to: burst.from });
          cur = Math.max(cur, burst.to);
        }
        if (cur < b.to) split.push({ ...b, from: cur, to: b.to });
      }
      return clampSegments([...split, ...bursts], from, to);
    },
  };
}

/** The scripted cast (spec 12.4). Hour offsets are relative to `scriptStart`. */
export function buildActors(): Actor[] {
  return [
    // Four colour-demo operators on the featured job, running the whole window.
    steadyActor('JRivera', FEATURED_JOB, 'Selective Solder - Top', 0, null, true), // blue
    steadyActor('MChen', FEATURED_JOB, 'Selective Solder - Bottom', 0, null, true), // green
    steadyActor('TOkafor', FEATURED_JOB, 'Functional Test', 0, null, true), // yellow
    steadyActor('LNguyen', FEATURED_JOB, 'Selective Solder - Top', 0, null, true), // red
    // Support operations on the featured job (partial windows => blank cells elsewhere).
    steadyActor('KYamada', FEATURED_JOB, 'SMT Placement', 0, 7),
    steadyActor('RSingh', FEATURED_JOB, 'Reflow', 2, 9),
    steadyActor('NIvanova', FEATURED_JOB, 'Final Inspection', 6, null),
    steadyActor('DMorales', FEATURED_JOB, 'Pack', 8, null),
    // Visitor + half-hour job switcher.
    visitorActor('SPatel', 'AOI', 5),
    halfHourSwitchActor('AKowalski', 'ICT', SECONDARY_JOB, FEATURED_JOB),
    // Other active jobs so the floor and shift views have rows.
    steadyActor('EBrooks', 'J00004690-0000', 'SMT Placement', 0, null),
    steadyActor('CDubois', 'J00004690-0000', 'Conformal Coat', 1, null),
    steadyActor('FHaddad', VISITOR_HOME_JOB, 'Final Inspection', 0, null),
    steadyActor('BOsei', NEW_JOB, 'SMT Placement', 3, null),
  ];
}

// ---------------------------------------------------------------------------
// History generation
// ---------------------------------------------------------------------------

export interface ActorState {
  actor: Actor;
  cursor: UtcMs;
  openStep: UnitStep | null;
  segKey: string;
}

export interface GeneratedHistory {
  steps: UnitStep[];
  defects: Defect[];
  alloc: UnitAllocator;
  actorStates: ActorState[];
  timing: ActorTiming;
  /** Wall-clock milliseconds the generation took. */
  generation_ms: number;
  start_utc: UtcMs;
}

function jobOpenAt(job: DemoJob, now: UtcMs, t: UtcMs): boolean {
  const start = now - job.start_days_ago * DAY;
  const end = job.end_days_ago === null ? Infinity : now - job.end_days_ago * DAY;
  return t >= start && t < end;
}

interface Task {
  job_number: string;
  operation: string;
  remaining: number;
  rate: number;
  job: DemoJob;
}

/** Drives the scripted cast over [from, to) and returns the steps produced. */
export function runActors(
  states: ActorState[],
  ctx: GenContext,
  timing: ActorTiming,
  from: UtcMs,
  to: UtcMs,
  speed: number,
  allowOpen: boolean,
): void {
  for (const st of states) {
    const segs = st.actor.segments(Math.max(from, st.cursor - HOUR), to, timing);
    for (const seg of segs) {
      if (seg.to <= from) continue;
      const key = seg.job_number + '|' + seg.operation + '|' + (seg.rework ? 'R' : 'N');
      if (key !== st.segKey) {
        // Close whatever was in progress on the previous task.
        if (st.openStep !== null) {
          const planned = (st.openStep as UnitStep & { __plannedComplete?: number })
            .__plannedComplete;
          st.openStep.complete_ts = Math.min(planned ?? seg.from, seg.from);
          st.openStep.result = 'PASS';
          st.openStep = null;
        }
        st.segKey = key;
        st.cursor = Math.max(seg.from, from);
      }
      const spanFrom = Math.max(seg.from, from, st.cursor);
      const spanTo = Math.min(seg.to, to);
      if (spanTo <= spanFrom) continue;

      if (seg.rework) {
        // 6 boards in ~2 minutes: a fixed burst, not a rate-driven span.
        const n = 6;
        const step = (spanTo - spanFrom) / n;
        for (let i = 0; i < n; i++) {
          const s = spanFrom + i * step;
          const e = s + step * 0.85;
          if (e > to) break;
          const unit = ctx.alloc.next(seg.job_number, seg.operation);
          if (unit === null) break;
          const job = JOB_BY_NUMBER.get(seg.job_number)!;
          const route = routeFor(job.product_number);
          const idx = route.indexOf(seg.operation);
          ctx.push({
            unit_id: unit,
            job_number: seg.job_number,
            product_number: job.product_number,
            operation: seg.operation,
            operation_seq: idx >= 0 ? idx + 1 : null,
            operator_id: st.actor.operator.operator_id,
            start_ts: Math.round(s),
            complete_ts: Math.round(e),
            result: 'PASS',
            rework_flag: true,
          });
        }
        st.cursor = spanTo;
        continue;
      }

      const clean = st.actor.clean === true;
      const res = generateSpan(ctx, {
        operator: st.actor.operator,
        job_number: seg.job_number,
        operation: seg.operation,
        from: spanFrom,
        to: spanTo,
        speed,
        cursor: st.cursor,
        openStep: st.openStep,
        allowOpen: allowOpen && spanTo >= to,
        batchProb: clean ? 0 : 0.02,
        maxBatch: 5,
        noiseSpread: clean ? 0.1 : 0.18,
        longScanProb: clean ? 0 : 0.0008,
      });
      st.cursor = res.cursor;
      st.openStep = res.openStep;
    }
  }
}

export function generateHistory(
  now: UtcMs,
  shifts: ShiftDef[],
  breaks: BreakInterval[],
  seed = WORLD_SEED,
): GeneratedHistory {
  const t0 = Date.now();
  const rng = mulberry32(seed);
  const steps: UnitStep[] = [];
  const start_utc = now - HISTORY_DAYS * DAY;
  const scriptStart = Math.floor(now / HOUR) * HOUR - (SCRIPT_HOURS - 1) * HOUR;

  const alloc = new UnitAllocator(JOB_BY_NUMBER);
  const ctx: GenContext = { rng, breaks, alloc, push: (s) => steps.push(s) };

  // ---- generic 30-day history -------------------------------------------------
  const tasks: Task[] = [];
  for (const job of JOBS) {
    const route = routeFor(job.product_number);
    const target = Math.round(job.qty_released * job.progress);
    for (const operation of route) {
      tasks.push({
        job_number: job.job_number,
        operation,
        remaining: target,
        rate: (BASE_RATES[operation] ?? 30),
        job,
      });
    }
  }

  const instances: ShiftInstance[] = listShiftInstances(shifts, start_utc, scriptStart, PLANT_TZ);
  const dayRoster = OPERATORS.filter((o) => o.shift === 'day');
  const nightRoster = OPERATORS.filter((o) => o.shift === 'night');
  const lastTask = new Map<string, Task>();

  for (const inst of instances) {
    if (inst.start_utc >= scriptStart) continue;
    const roster = inst.name === 'Night' ? nightRoster : dayRoster;
    const shiftEnd = Math.min(inst.end_utc, scriptStart);
    for (const operator of rng.shuffle(roster)) {
      if (!rng.chance(0.86)) continue; // absence
      let t = inst.start_utc + rng.range(2, 25) * MINUTE;
      let sessions = 0;
      while (t < shiftEnd - 40 * MINUTE && sessions < 4) {
        const len = rng.range(2, 4) * HOUR;
        const end = Math.min(t + len, shiftEnd - rng.range(0, 15) * MINUTE);
        if (end <= t) break;

        const available = tasks.filter(
          (task) =>
            task.remaining > 30 &&
            jobOpenAt(task.job, now, t) &&
            jobOpenAt(task.job, now, end - MINUTE),
        );
        if (available.length === 0) break;

        // Stickiness: operators tend to stay on what they ran last shift.
        const prev = lastTask.get(operator.operator_id);
        let task: Task;
        if (prev !== undefined && available.includes(prev) && rng.chance(0.45)) {
          task = prev;
        } else {
          // Weight by remaining work in hours so slow operations get their share.
          let totalW = 0;
          const weights = available.map((a) => {
            const w = a.remaining / a.rate;
            totalW += w;
            return w;
          });
          let r = rng.next() * totalW;
          let idx = 0;
          for (let i = 0; i < weights.length; i++) {
            r -= weights[i]!;
            if (r <= 0) {
              idx = i;
              break;
            }
          }
          task = available[idx]!;
        }
        lastTask.set(operator.operator_id, task);

        const before = alloc.count(task.job_number, task.operation);
        generateSpan(ctx, {
          operator,
          job_number: task.job_number,
          operation: task.operation,
          from: t,
          to: end,
          speed: 1,
          allowOpen: false,
        });
        task.remaining -= alloc.count(task.job_number, task.operation) - before;

        sessions += 1;
        t = end + rng.range(8, 50) * MINUTE;
      }
    }
  }

  // ---- scripted window (spec 12.4) -------------------------------------------
  const timing: ActorTiming = { scriptStart, horizon: now + 400 * DAY };
  const actors = buildActors();
  const actorStates: ActorState[] = actors.map((actor) => ({
    actor,
    cursor: scriptStart,
    openStep: null,
    segKey: '',
  }));
  runActors(actorStates, ctx, timing, scriptStart, now, 1, true);

  steps.sort((a, b) => a.start_ts - b.start_ts);

  // ---- defects (1-3 per hour on two operations) -------------------------------
  const defects = generateDefects(steps, now, seed);

  return {
    steps,
    defects,
    alloc,
    actorStates,
    timing,
    generation_ms: Date.now() - t0,
    start_utc,
  };
}

/** 1-3 defects per active hour on AOI and ICT (spec 12.4). */
export function generateDefects(steps: UnitStep[], now: UtcMs, seed: number): Defect[] {
  const since = now - 14 * DAY;
  const buckets = new Map<string, UnitStep[]>();
  for (const s of steps) {
    if (s.complete_ts === null || s.complete_ts < since) continue;
    if (!DEFECT_OPERATIONS.includes(s.operation)) continue;
    const hour = Math.floor(s.complete_ts / HOUR) * HOUR;
    const key = hour + '|' + s.job_number + '|' + s.operation;
    let list = buckets.get(key);
    if (list === undefined) {
      list = [];
      buckets.set(key, list);
    }
    list.push(s);
  }
  const out: Defect[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 3) continue;
    const hour = Number(key.split('|')[0]);
    const local = mulberry32(hashString(key) ^ seed);
    if (!local.chance(0.7)) continue;
    const n = local.int(1, 3);
    for (let i = 0; i < n; i++) {
      const step = list[local.int(0, list.length - 1)]!;
      const code = DEFECT_CODES[local.int(0, DEFECT_CODES.length - 1)]!;
      out.push({
        unit_id: step.unit_id,
        job_number: step.job_number,
        operation: step.operation,
        operator_id: step.operator_id,
        defect_code: code.code,
        description: code.description,
        found_ts: Math.round(hour + local.range(2, 58) * MINUTE),
        status: local.chance(0.6) ? 'Closed' : 'Open',
      });
    }
  }
  out.sort((a, b) => a.found_ts - b.found_ts);
  return out;
}

/** Defects produced during a live tick for the featured and other active jobs. */
export function liveDefects(
  steps: UnitStep[],
  from: UtcMs,
  to: UtcMs,
  seed: number,
): Defect[] {
  const out: Defect[] = [];
  const candidates = steps.filter(
    (s) =>
      s.complete_ts !== null &&
      s.complete_ts >= from &&
      s.complete_ts < to &&
      DEFECT_OPERATIONS.includes(s.operation),
  );
  if (candidates.length === 0) return out;
  const rng = mulberry32((hashString(String(Math.floor(from / MINUTE))) ^ seed) >>> 0);
  // ~2 defects per hour across the sampled operations.
  const expected = ((to - from) / HOUR) * 2;
  let n = Math.floor(expected);
  if (rng.next() < expected - n) n += 1;
  for (let i = 0; i < n; i++) {
    const step = candidates[rng.int(0, candidates.length - 1)]!;
    const code = DEFECT_CODES[rng.int(0, DEFECT_CODES.length - 1)]!;
    out.push({
      unit_id: step.unit_id,
      job_number: step.job_number,
      operation: step.operation,
      operator_id: step.operator_id,
      defect_code: code.code,
      description: code.description,
      found_ts: step.complete_ts ?? to,
      status: 'Open',
    });
  }
  out.sort((a, b) => a.found_ts - b.found_ts);
  return out;
}
