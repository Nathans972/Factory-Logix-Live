/**
 * Hour cells: eligibility, ownership windows, charged minutes, target/pace/color
 * (spec 7.3-7.7, 7.9).
 */
import type {
  CellColor,
  Defect,
  DefectHourCell,
  GroupedHourCell,
  HourCell,
  OperatorAssignment,
  Pin,
  UnitStep,
  UtcMs,
} from '@fld/shared';
import type { ComputeHourCellsInput, ComputeHourCellsOutput, EngineSettings } from '@fld/shared';
import { firstHourAtOrAfter, hourStartUtc, mergeIntervals, nextHourStartUtc, prevHourStartUtc } from './time.js';
import { stdKey } from './standards.js';

const MINUTE_MS = 60_000;

type Interval = { start_utc: UtcMs; end_utc: UtcMs };

interface Piece {
  from: UtcMs;
  to: UtcMs;
}

interface CellAcc {
  hour: UtcMs;
  job: string;
  op: string;
  product: string;
  units: number;
  work_ms: number;
  pieces: Piece[];
}

interface Ev {
  t: UtcMs;
  /** 0 = complete, 1 = start (complete sorts before start on ties) */
  kind: 0 | 1;
  job: string;
  op: string;
  product: string;
}

interface Segment {
  job: string;
  op: string;
  product: string;
  from: UtcMs;
  to: UtcMs;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export function colorForPace(pace: number | null, settings: EngineSettings): CellColor {
  if (pace === null || !Number.isFinite(pace)) return 'neutral';
  if (pace < settings.color_red_below) return 'red';
  if (pace < settings.color_yellow_below) return 'yellow';
  if (pace <= settings.color_blue_above) return 'green';
  return 'blue';
}

// ---------------------------------------------------------------------------
// computeHourCells
// ---------------------------------------------------------------------------

export function computeHourCells(input: ComputeHourCellsInput): ComputeHourCellsOutput {
  const { steps, breaks, standards, kept_std_hr, pins, settings, from_utc, to_utc, now } = input;
  const tz = settings.plant_timezone;
  const mergedBreaks = mergeIntervals(breaks);
  const currentHour = hourStartUtc(now, tz);
  const horizon = Math.min(now, to_utc);
  const idleMs = settings.idle_timeout_minutes * MINUTE_MS;
  const countWorkDuringBreaks = settings.count_work_during_breaks;

  // --- Active pins indexed by operator|job.
  const pinIndex = new Map<string, Pin[]>();
  for (const p of pins) {
    if (p.expires_at !== null && p.expires_at !== undefined && p.expires_at <= now) continue;
    const key = `${p.operator_id}|${p.job_number}`;
    let list = pinIndex.get(key);
    if (list === undefined) {
      list = [];
      pinIndex.set(key, list);
    }
    list.push(p);
  }

  // --- Group steps by operator.
  const byOperator = new Map<string, UnitStep[]>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    let list = byOperator.get(s.operator_id);
    if (list === undefined) {
      list = [];
      byOperator.set(s.operator_id, list);
    }
    list.push(s);
  }

  const cells: HourCell[] = [];
  const assignments: OperatorAssignment[] = [];
  const windowFrom = Number.isFinite(from_utc) ? hourStartUtc(from_utc, tz) : from_utc;

  for (const [operator_id, opSteps] of byOperator) {
    const accs = new Map<string, CellAcc>();
    const workByKey = new Map<string, number>(); // `${hour}|${job}|${op}` -> minutes
    const events: Ev[] = [];
    const completesByJobOp = new Map<string, number[]>();

    const touch = (hour: UtcMs, s: UnitStep): CellAcc => {
      const key = `${hour}|${s.job_number}|${s.operation}`;
      let acc = accs.get(key);
      if (acc === undefined) {
        acc = {
          hour,
          job: s.job_number,
          op: s.operation,
          product: s.product_number,
          units: 0,
          work_ms: 0,
          pieces: [],
        };
        accs.set(key, acc);
      }
      return acc;
    };

    // ---------------- Pass 1: events, then work minutes and units ----------------
    for (let i = 0; i < opSteps.length; i++) {
      const s = opSteps[i]!;
      const complete = s.complete_ts ?? null;

      if (s.start_ts <= horizon) {
        events.push({
          t: s.start_ts,
          kind: 1,
          job: s.job_number,
          op: s.operation,
          product: s.product_number,
        });
      }
      if (complete !== null && complete <= horizon) {
        events.push({
          t: complete,
          kind: 0,
          job: s.job_number,
          op: s.operation,
          product: s.product_number,
        });
      }
    }

    // Work minutes are read for the window's hours (pass 3) and, for eligibility, for the hours of the
    // events and the hour before the current one. A step's other hours are skipped, not walked: from
    // a zero-date start (1900, 1970) that is a million hours.
    const eventHours = events.map((e) => hourStartUtc(e.t, tz));
    eventHours.push(prevHourStartUtc(currentHour, tz));
    eventHours.sort((a, b) => a - b);
    const nextReadHour = (h: UtcMs): UtcMs => {
      if (h >= windowFrom && h < to_utc) return h;
      const next = eventHours[firstHourAtOrAfter(eventHours, h)] ?? Infinity;
      return h < windowFrom ? Math.min(next, windowFrom) : next;
    };

    for (let i = 0; i < opSteps.length; i++) {
      const s = opSteps[i]!;
      const start = s.start_ts;
      const complete = s.complete_ts ?? null;

      if (start <= now) touch(hourStartUtc(start, tz), s);

      if (complete !== null) {
        if (complete <= now) {
          const acc = touch(hourStartUtc(complete, tz), s);
          acc.units += 1;
          const cKey = `${s.job_number}|${s.operation}`;
          let list = completesByJobOp.get(cKey);
          if (list === undefined) {
            list = [];
            completesByJobOp.set(cKey, list);
          }
          list.push(complete);
        }
      }

      const end = Math.min(complete ?? now, now);
      if (end > start) {
        let h = nextReadHour(hourStartUtc(start, tz));
        while (h < end) {
          const hEnd = nextHourStartUtc(h, tz);
          const ov = Math.min(end, hEnd) - Math.max(start, h);
          if (ov > 0) {
            const acc = touch(h, s);
            acc.work_ms += ov;
            const key = `${h}|${s.job_number}|${s.operation}`;
            workByKey.set(key, (workByKey.get(key) ?? 0) + ov / MINUTE_MS);
          }
          h = nextReadHour(hEnd);
        }
      }
    }

    for (const list of completesByJobOp.values()) list.sort((a, b) => a - b);

    // ---------------- Eligibility ----------------
    const eligibilityMemo = new Map<string, boolean>();

    const pinFor = (job: string, op: string): Pin | null => {
      const list = pinIndex.get(`${operator_id}|${job}`);
      if (list === undefined) return null;
      let best: Pin | null = null;
      let bestRank = 0;
      for (const p of list) {
        const rank = p.operation === op ? 2 : p.operation === null ? 1 : 0;
        if (rank === 0) continue;
        if (
          best === null ||
          rank > bestRank ||
          (rank === bestRank && p.created_at > best.created_at)
        ) {
          best = p;
          bestRank = rank;
        }
      }
      return best;
    };

    const isEligible = (hour: UtcMs, job: string, op: string): boolean => {
      const key = `${hour}|${job}|${op}`;
      const memo = eligibilityMemo.get(key);
      if (memo !== undefined) return memo;

      let result: boolean;
      const pin = pinFor(job, op);
      if (pin !== null) {
        result = pin.mode === 'force_eligible';
      } else {
        const work = workByKey.get(key) ?? 0;
        if (hour === currentHour) {
          const elapsed = (now - hour) / MINUTE_MS;
          const threshold = Math.max(1, (settings.eligibility_minutes * elapsed) / 60);
          if (work >= threshold) {
            result = true;
          } else {
            const prev = prevHourStartUtc(hour, tz);
            const prevWork = workByKey.get(`${prev}|${job}|${op}`) ?? 0;
            result = prevWork >= settings.eligibility_minutes;
          }
        } else {
          result = work >= settings.eligibility_minutes;
        }
      }
      eligibilityMemo.set(key, result);
      return result;
    };

    // ---------------- Pass 2: ownership timeline ----------------
    events.sort((a, b) => a.t - b.t || a.kind - b.kind);

    const idleDeadline = (lastScan: UtcMs): UtcMs => {
      let remaining = idleMs;
      let cur = lastScan;
      let i = firstBreakAfter(mergedBreaks, cur);
      while (i < mergedBreaks.length) {
        const b = mergedBreaks[i]!;
        if (b.start_utc >= cur + remaining) break;
        if (b.start_utc > cur) remaining -= b.start_utc - cur;
        if (b.end_utc > cur) cur = b.end_utc;
        i++;
      }
      return cur + remaining;
    };

    const segments: Segment[] = [];
    let assigned: { job: string; op: string; product: string; since: UtcMs } | null = null;
    let lastScan: UtcMs | null = null;

    const closeSegment = (end: UtcMs): void => {
      if (assigned === null) return;
      if (end > assigned.since) {
        segments.push({
          job: assigned.job,
          op: assigned.op,
          product: assigned.product,
          from: assigned.since,
          to: end,
        });
      }
      assigned = null;
    };

    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (!isEligible(hourStartUtc(e.t, tz), e.job, e.op)) continue; // visitor scans are invisible

      if (assigned !== null && lastScan !== null) {
        const idleEnd = idleDeadline(lastScan);
        if (e.t > idleEnd) closeSegment(idleEnd);
      }

      if (e.kind === 1) {
        if (assigned === null) {
          assigned = { job: e.job, op: e.op, product: e.product, since: e.t };
        } else if (assigned.job !== e.job || assigned.op !== e.op) {
          closeSegment(e.t);
          assigned = { job: e.job, op: e.op, product: e.product, since: e.t };
        }
      } else if (assigned === null) {
        assigned = { job: e.job, op: e.op, product: e.product, since: e.t };
      }
      lastScan = e.t;
    }

    let finalAssignment: OperatorAssignment = {
      operator_id,
      job_number: null,
      operation: null,
      assigned_since: null,
      last_scan_at: lastScan,
    };
    if (assigned !== null && lastScan !== null) {
      const deadline = idleDeadline(lastScan);
      const end = Math.min(deadline, horizon);
      const stillAssigned = deadline >= horizon;
      if (stillAssigned) {
        finalAssignment = {
          operator_id,
          job_number: assigned.job,
          operation: assigned.op,
          assigned_since: assigned.since,
          last_scan_at: lastScan,
        };
      }
      closeSegment(end);
    }
    assignments.push(finalAssignment);

    // ---------------- Distribute segments across hour buckets ----------------
    for (const seg of segments) {
      let h = hourStartUtc(seg.from, tz);
      while (h < seg.to) {
        const hEnd = nextHourStartUtc(h, tz);
        const from = Math.max(seg.from, h);
        const to = Math.min(seg.to, hEnd);
        if (to > from) {
          const key = `${h}|${seg.job}|${seg.op}`;
          let acc = accs.get(key);
          if (acc === undefined) {
            acc = {
              hour: h,
              job: seg.job,
              op: seg.op,
              product: seg.product,
              units: 0,
              work_ms: 0,
              pieces: [],
            };
            accs.set(key, acc);
          }
          acc.pieces.push({ from, to });
        }
        h = hEnd;
      }
    }

    // ---------------- Pass 3: cell assembly ----------------
    for (const acc of accs.values()) {
      if (acc.hour < from_utc || acc.hour >= to_utc) continue;

      const eligible = isEligible(acc.hour, acc.job, acc.op);
      let windowMs = 0;
      let breakMs = 0;
      if (eligible && acc.pieces.length > 0) {
        const completes = completesByJobOp.get(`${acc.job}|${acc.op}`);
        for (const piece of acc.pieces) {
          windowMs += piece.to - piece.from;
          let i = firstBreakAfter(mergedBreaks, piece.from);
          while (i < mergedBreaks.length) {
            const b = mergedBreaks[i]!;
            if (b.start_utc >= piece.to) break;
            const ov = Math.min(piece.to, b.end_utc) - Math.max(piece.from, b.start_utc);
            if (ov > 0) {
              if (
                !countWorkDuringBreaks ||
                !completedInside(completes, b.start_utc, b.end_utc)
              ) {
                breakMs += ov;
              }
            }
            i++;
          }
        }
      }

      const work_minutes = acc.work_ms / MINUTE_MS;
      const window_minutes = windowMs / MINUTE_MS;
      const break_minutes = breakMs / MINUTE_MS;
      const charged_minutes = Math.max(0, window_minutes - break_minutes);

      if (acc.units === 0 && work_minutes === 0 && charged_minutes === 0) continue;

      const key = stdKey(acc.product, acc.op);
      const kept = kept_std_hr?.get(acc.hour)?.get(key);
      const std_hr = kept !== undefined ? kept : (standards.get(key)?.effective ?? null);
      const target_units = std_hr === null ? 0 : (std_hr * charged_minutes) / 60;
      const pace = std_hr !== null && target_units > 0 ? acc.units / target_units : null;
      const provisional = acc.hour === currentHour;

      let color: CellColor;
      if (!eligible) color = 'visitor';
      else if (std_hr === null) color = 'neutral';
      else if (provisional && charged_minutes < settings.neutral_minutes) color = 'neutral';
      else if (charged_minutes === 0) color = 'neutral';
      else color = colorForPace(pace, settings);

      cells.push({
        hour_start_utc: acc.hour,
        job_number: acc.job,
        product_number: acc.product,
        operation: acc.op,
        operator_id,
        units: acc.units,
        work_minutes,
        window_minutes,
        break_minutes,
        charged_minutes,
        eligible,
        provisional,
        std_hr,
        target_units,
        pace,
        color,
      });
    }
  }

  cells.sort(
    (a, b) =>
      a.hour_start_utc - b.hour_start_utc ||
      cmp(a.job_number, b.job_number) ||
      cmp(a.operation, b.operation) ||
      cmp(a.operator_id, b.operator_id),
  );
  assignments.sort((a, b) => cmp(a.operator_id, b.operator_id));

  return { cells, assignments };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the first interval whose end is strictly after `t`. */
function firstBreakAfter(merged: Interval[], t: UtcMs): number {
  let lo = 0;
  let hi = merged.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (merged[mid]!.end_utc > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function completedInside(completes: number[] | undefined, start: UtcMs, end: UtcMs): boolean {
  if (completes === undefined || completes.length === 0) return false;
  let lo = 0;
  let hi = completes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (completes[mid]! >= start) hi = mid;
    else lo = mid + 1;
  }
  return lo < completes.length && completes[lo]! <= end;
}

// ---------------------------------------------------------------------------
// 7.6 grouped cells
// ---------------------------------------------------------------------------

export function groupCells(
  cells: HourCell[],
  settings: EngineSettings,
  _now: UtcMs,
): GroupedHourCell[] {
  interface Acc {
    hour: UtcMs;
    job: string;
    product: string;
    op: string;
    units: number;
    eligible_units: number;
    charged_minutes: number;
    eligible_operators: string[];
    visitor_operators: string[];
    std_hr: number | null;
    fallback_std_hr: number | null;
    provisional: boolean;
  }
  const map = new Map<string, Acc>();
  for (const c of cells) {
    const key = `${c.hour_start_utc}|${c.job_number}|${c.operation}`;
    let acc = map.get(key);
    if (acc === undefined) {
      acc = {
        hour: c.hour_start_utc,
        job: c.job_number,
        product: c.product_number,
        op: c.operation,
        units: 0,
        eligible_units: 0,
        charged_minutes: 0,
        eligible_operators: [],
        visitor_operators: [],
        std_hr: null,
        fallback_std_hr: null,
        provisional: false,
      };
      map.set(key, acc);
    }
    acc.units += c.units;
    if (c.provisional) acc.provisional = true;
    if (acc.fallback_std_hr === null && c.std_hr !== null) acc.fallback_std_hr = c.std_hr;
    if (c.eligible) {
      acc.eligible_units += c.units;
      acc.charged_minutes += c.charged_minutes;
      if (!acc.eligible_operators.includes(c.operator_id)) acc.eligible_operators.push(c.operator_id);
      if (acc.std_hr === null && c.std_hr !== null) acc.std_hr = c.std_hr;
    } else if (!acc.visitor_operators.includes(c.operator_id)) {
      acc.visitor_operators.push(c.operator_id);
    }
  }

  const out: GroupedHourCell[] = [];
  for (const acc of map.values()) {
    const std_hr = acc.std_hr ?? acc.fallback_std_hr;
    const visitor_units = acc.units - acc.eligible_units;
    const target_units = std_hr === null ? 0 : (std_hr * acc.charged_minutes) / 60;
    const pace = std_hr !== null && target_units > 0 ? acc.eligible_units / target_units : null;

    let color: CellColor;
    if (acc.eligible_operators.length === 0) {
      color = visitor_units > 0 ? 'visitor' : 'neutral';
    } else if (std_hr === null) {
      color = 'neutral';
    } else if (acc.provisional && acc.charged_minutes < settings.neutral_minutes) {
      color = 'neutral';
    } else if (acc.charged_minutes === 0) {
      color = 'neutral';
    } else {
      color = colorForPace(pace, settings);
    }

    acc.eligible_operators.sort(cmp);
    acc.visitor_operators.sort(cmp);

    out.push({
      hour_start_utc: acc.hour,
      job_number: acc.job,
      product_number: acc.product,
      operation: acc.op,
      units: acc.units,
      eligible_units: acc.eligible_units,
      visitor_units,
      eligible_operators: acc.eligible_operators,
      visitor_operators: acc.visitor_operators,
      charged_minutes: acc.charged_minutes,
      std_hr,
      target_units,
      pace,
      color,
      provisional: acc.provisional,
    });
  }
  out.sort(
    (a, b) =>
      a.hour_start_utc - b.hour_start_utc ||
      cmp(a.job_number, b.job_number) ||
      cmp(a.operation, b.operation),
  );
  return out;
}

// ---------------------------------------------------------------------------
// 7.9 defect hour cells
// ---------------------------------------------------------------------------

export function computeDefectHourCells(
  defects: Defect[],
  from_utc: UtcMs,
  to_utc: UtcMs,
  tz: string,
): DefectHourCell[] {
  const map = new Map<string, DefectHourCell>();
  for (const d of defects) {
    if (d.found_ts < from_utc || d.found_ts >= to_utc) continue;
    const hour = hourStartUtc(d.found_ts, tz);
    const key = `${hour}|${d.job_number}|${d.operation}`;
    const cell = map.get(key);
    if (cell === undefined) {
      map.set(key, {
        hour_start_utc: hour,
        job_number: d.job_number,
        operation: d.operation,
        count: 1,
      });
    } else {
      cell.count += 1;
    }
  }
  const out = [...map.values()];
  out.sort(
    (a, b) =>
      a.hour_start_utc - b.hour_start_utc ||
      cmp(a.job_number, b.job_number) ||
      cmp(a.operation, b.operation),
  );
  return out;
}
