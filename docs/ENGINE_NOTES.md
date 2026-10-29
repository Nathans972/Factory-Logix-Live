# Engine implementation notes

These notes resolve the ambiguities in spec section 7 so the engine (`packages/engine`) has one
canonical interpretation. They are binding for the implementation and its tests. Read together with
`docs/SPEC.md` sections 5, 7 and 15 and the API contract in `packages/engine/src/index.ts`.

## General

- Pure functions only. No `Date.now()`; callers pass `now`. No timers, no I/O.
- Timestamps are UTC epoch ms. Minutes are floating point (do not round internally; views round for display).
- Operations are keyed by **name** (string). Products by product_number, jobs by job_number.
- `stdKey(product, op)` = `${product} ${op}` (single space separator).
- Time zone math uses `Intl.DateTimeFormat` only. Cache formatters per tz.

## Time (spec 5)

- `hourStartUtc(t, tz)`: take local parts of `t`, subtract minute/second/ms => works for half-hour zones and DST.
- `rollingWindowColumns(now, tz, 12)`: `h0 = hourStartUtc(now)`, columns are `h0 - 11h ... h0` **in UTC arithmetic** (subtract 3_600_000 each step). Labels via `hourLabel`. On fall-back night two columns can share a label; on spring-forward the window is still 12 consecutive UTC hours.
- `hourColumns(from, to, tz)`: start at `hourStartUtc(from)`, step by 1h in UTC until `>= to`.
- `localToUtc`: iterate `guess = Date.UTC(parts) - offset(guess)` twice. If the resulting local parts differ from the input (non-existent time), return `guess + gap` (shift forward). If ambiguous (two valid instants), pick per `opts.ambiguous` (default `earlier`). Detect ambiguity by checking `guess - 1h` and `guess + 1h` map back to the same local parts.
- Shift instance for `date`: `start = localToUtc(date, start_local)`; `end = localToUtc(date, end_local)`; if `end <= start`, `end = localToUtc(date + 1 day, end_local)`. A shift definition applies on `date` when `date` is within `[effective_from, effective_to]` and `dayOfWeek(date)` is in `days_of_week`.
- `listShiftInstances(shifts, from, to, tz)`: iterate local dates from `localDate(from) - 1 day` to `localDate(to)`, expand every applicable shift, keep those overlapping `[from, to)`, sort by start then id. Ignore identical duplicates (same shift_id/date).
- `findCurrentShift`: the instance with `start <= now < end` (if several, the one with the latest start). `findCurrentOrMostRecentShift`: current, else the instance with the greatest `end <= now` within the last 14 days.
- Breaks: for each local date from `localDate(from) - 1` to `localDate(to)`, for each applicable break (effective range + days_of_week), `start = localToUtc(date, start_local)`, `end = start + duration`. If `shift_ids` is non-null, include only if some shift in `shift_ids` has an instance (via the same date range) with `start <= breakStart < end`. Keep intervals overlapping `[from, to)`; sort; do not merge.
- `overlapWithIntervals`: intervals may overlap each other; compute the union first.
- `inLocalWindow(tz, t, start, end)`: minutes-of-day comparison; when `end <= start` the window wraps midnight.
- `nextLocalTime(tz, 'HH:MM', after)`: candidate on `localDate(after)`; if `<= after`, use the next day (loop over up to 3 days to handle DST gaps).

## Standards (spec 7.1)

Input steps are all steps for one (product, operation) in the lookback. Algorithm:

1. Filter: `complete_ts != null`, `complete_ts >= now - std_lookback_days`, `complete_ts > start_ts`, duration `<= std_max_unit_minutes`, `complete_ts < hourStartUtc(now)` (current hour excluded), and `rework_flag !== true` when `rework_flag_mapped`.
2. Eligibility: compute work minutes per (operator, job, hour) from **all** input steps (before the duration filter, using `[start, complete ?? now]` clipped to the hour), and mark eligible when `>= eligibility_minutes` (completed-hour rule only; no scaling, no continuing rule, no pins). Keep only units whose `complete_ts` hour is eligible for that operator/job. Only those hours are computed, and an hour stops taking work once it is eligible, so a step with a zero-date start (1900) is not walked hour by hour and many of them do not add to the same hours again and again.
3. Sessions per operator (across jobs of the same product/operation): sort by start; a unit joins the current session if `start <= sessionEnd + session_gap_minutes` where `sessionEnd` is the max complete seen so far; otherwise a new session starts. Busy minutes = union length of the session's intervals minus overlap with breaks (union of breaks). Per-unit minutes = busy / n. If busy is 0 (all inside a break), skip those units.
4. `median_minutes_per_unit` = median of all per-unit values (average of the two middle values for even counts). `computed_std_hr = round(60 / median, 1)`.
5. `sample_units`, `sample_operators` (distinct operator_ids among sampled units), `sample_from/to` = min/max complete_ts of sampled units.
6. If `sample_units < std_min_units` or `sample_operators < std_min_operators`: `computed_std_hr = null`, `median = null` (still report sample counts). Then `fallback_source = 'fl_std_hr'` if `fl_std_hr` is a positive number, else `'none'`. When computed is present, `fallback_source = 'computed'`. Always copy `fl_std_hr` through.

## Effective standard (spec 7.2)

- Base = `computed_std_hr ?? fl_std_hr ?? null`; `base_source` = `'computed' | 'fl_std_hr' | 'none'`.
- Adjustment: among **active** adjustments matching (product_operation with both matching > operation with matching op > product with matching product > global), take the most specific; for ties, the most recently created. `adjusted = base * (1 + percent/100)` (null if base null). Round to 1 decimal.
- Override: active overrides; `product_operation` matching both wins over `product` matching product. If present, `effective = override.std_hr`, provenance `override_*`.
- Otherwise `effective = adjusted ?? base`; provenance `'adjusted'` when an adjustment applied and base non-null, `'base_computed'` / `'base_fl'` when base only, `'none'` when null.
- `StandardAdjustment` has no `active` field in the shared type; the DB has one but only active rows are passed in. Treat all passed adjustments as active.
- `buildStandardsLookup` must create entries for every standard row and every extra key even with no standard (so views can show "none").

## Hour cells (spec 7.3–7.5, 7.7)

`computeHourCells` processes **each operator independently**, chronologically.

### Pass 1: work minutes and eligibility

For every step of the operator, for every hour bucket overlapped by `[start, complete ?? now]` (clip open steps at `now`; ignore anything after `now`), accumulate `work_minutes[hour][job|op]`.

Also record "scan events": a start event at `start_ts` and, if present, a complete event at `complete_ts`. Units are counted in the hour of `complete_ts`.

Eligibility for `(hour, job, op)`:
- Pins: a pin for `(operator, job)` with `operation` null or equal, in force at the hour's last moment `at = min(now, hourEnd - 1)` (`created_at <= at`, `expires_at` null or `> at`), forces the result (`force_eligible` => true, `force_visitor` => false); the most specific, then the newest, wins. Pins win over everything. So an hour that has ended keeps the pins in force when it ended, however long after their expiry (or removal, which ends a pin now) it is computed again, and a new pin starts with the hour it is created in.
- If `hour` is the current hour (`hour == hourStartUtc(now)`): `elapsed = (now - hour)/60000`, `threshold = max(1, eligibility_minutes * elapsed / 60)`; eligible if `work_minutes >= threshold` OR the operator was eligible on the same `(job, op)` in the previous hour bucket (`hour - 1h`, evaluated with the completed-hour rule).
- Else (completed hour): eligible if `work_minutes >= eligibility_minutes`.
- A `(hour, job, op)` with zero work minutes and zero units and no events is not evaluated.

### Pass 2: timeline (ownership windows)

Build the operator's event list (start/complete events across **all** jobs), sorted by time (ties: complete before start). Drop events whose `(hour-of-event, job, op)` is **not eligible** (visitor scans never start, end, or extend a window). Then sweep:

```
state: assigned = null | {job, op, since}; lastScan = null
segments: list of {job, op, from, to}

for each event e (time t) in order:
  if assigned != null:
     idleEnd = idleDeadline(lastScan)      // lastScan + idle_timeout, skipping break time
     if t > idleEnd: close segment at idleEnd; assigned = null
  if e.kind == 'start':
     if assigned == null or assigned.(job,op) != e.(job,op):
        if assigned: close segment at t
        assigned = {e.job, e.op, since: t}; open segment at t
  else (complete):
     if assigned == null: assigned = {e.job, e.op, since: t}; open segment at t
     // complete on another job while assigned does not switch
  lastScan = t

after last event: if assigned: end = min(idleDeadline(lastScan), now, to_utc); close segment at end
   (if idleDeadline < now the assignment is cleared: assignment state -> null)
```

`idleDeadline(lastScan)`: the instant `t` such that non-break minutes in `[lastScan, t]` equal `idle_timeout_minutes` (walk through break intervals sorted by start).

The pre-`from_utc` steps supplied by the caller establish the state at `from_utc` naturally because the sweep starts at the earliest supplied step. Emit only cells whose hour is in `[from_utc, to_utc)`.

Note: eligibility for an event's hour must be known before the sweep. Pass 1 covers every hour whose work minutes are read: the hours in `[from_utc, to_utc)`, the hours of the events and the hour before the current one. A step's other hours are skipped, not walked (a zero-date start, 1900 or 1970, is a million hours). For the current-hour "continuing operator" rule, pass 1 evaluates the previous hour first (it is a completed hour).

### Pass 3: cell assembly

For each `(hour, job, op)` the operator touched (has work minutes, units, events or a segment):

- `units` = count of steps with `complete_ts` in the hour on that job/op.
- `window_minutes` = sum of segment overlap with the hour (0 for visitors).
- `break_minutes` = overlap of those segment pieces with breaks (union). If `count_work_during_breaks` is true, a break interval is not subtracted when the operator completed at least one unit inside that break interval on this job/op.
- `charged_minutes = window_minutes - break_minutes` (never negative).
- `std_hr` from `kept_std_hr[hour][stdKey(product, op)]` when it has that entry (null included: an hour that has ended keeps the StdHr it was judged against, spec 7.7; the collector passes it), else from the lookup (`effective` or null).
- `target_units = std_hr * charged_minutes / 60` (0 when std null).
- `pace = units / target_units` when `target_units > 0` and std non-null, else null.
- `provisional = hour == currentHour`.
- Color:
  - not eligible => `'visitor'`
  - std_hr null => `'neutral'`
  - provisional and `charged_minutes < neutral_minutes` => `'neutral'`
  - `charged_minutes == 0` (eligible but no window, e.g. only complete scans while unassigned never happens; still guard) => `'neutral'`
  - else bands by pace: `< red_below` red; `< yellow_below` yellow; `<= blue_above` green; else blue.
  - `'blank'` is never emitted for an existing cell; it is the absence of a cell (views render blanks).

`work_minutes` in the output is the pass-1 value.

Output `assignments`: for every operator seen: `{operator_id, job_number, operation, assigned_since, last_scan_at}` reflecting the state after the sweep (nulls when unassigned).

### Grouped cells (spec 7.6)

Per `(hour, job, op)`: `units` = sum of all cells' units; `eligible_units` = sum over eligible cells; `visitor_units = units - eligible_units`; `charged_minutes` = sum over eligible cells; `std_hr` = the (common) std of the cells; `target = std * charged / 60`; `pace = eligible_units / target`; color as above using `provisional` (any cell provisional) and `charged < neutral_minutes` => neutral; no eligible operators => `'visitor'` if visitor units > 0 else `'neutral'`.

### Defect hour cells (spec 7.9)

Bucket defects by `hourStartUtc(found_ts)`, `(job, op)`, count. Only `found_ts` in `[from, to)`.

## Roll-ups (spec 7.11)

Over per-operator cells: visitor cells contribute only to `visitor_units` (not units, not charged, not earned). For eligible cells: `units`, `charged_minutes`, and when std non-null `earned_hours += units / std_hr` and the cell's charged minutes count toward efficiency; else increment `rows_without_std` (flag). Cells without a std are excluded from efficiency, not used to blank it: `efficiency = earned / (charged hours of the cells with a std)`, null when those are 0 (every cell lacks a std, or no charged time). `charged_hours_without_std` = the charged hours of the cells without a std (part of `charged_hours`), so the UI can show what was left out. Color: `colorForEfficiency` uses the same bands; null => neutral. `eligible_operators` = distinct operators among eligible cells. Groupings: by_job (key = job), by_operation (key = op), by_operator (key = operator_id, label = display name or id), by_job_operation (key = `${job}|${op}`). Sort each list by key. `overall` key `'overall'`.

## Views

### TvDashboard (spec 8.3, 7.8, 7.9, 7.10)

- `columns` are provided (12 or fewer). Rows:
  - Separate mode: one row per `(operation, operator)` that has any cell in the window. `visitor_row = true` when the operator is a visitor in every hour where a cell exists (no eligible cell); such rows are **omitted** (spec 8.5 "if an operator is a visitor in every hour of the window, the row is omitted"). Rows where the operator is eligible in some hours and visitor in others are shown; visitor hours render with the `'visitor'` color.
  - Grouped mode: one row per operation (`operator_id: null`), cells from `groupCells`.
  - Cells array is aligned to `columns` (one `TvCell` per column; missing => `{units:0, color:'blank', pace:null, charged_minutes:0, eligible:false, visitor:false, provisional:false}`).
  - `prior` = matching `PriorCount` (per operator in separate mode; summed per operation in grouped mode).
  - `shift` = sum of cell units across the columns. `std_day = std_hr * shift_length_hours` (null when std null) — only meaningful when `show_std_day`.
  - Row order: route sequence (index in `route`; unknown operations after, in first-seen order), then operator name/id.
  - `operation_seq` = 1-based index in the route (or 1000+ for unknown).
- Defect rows: one per operation present in `route` or in defect cells / prior defects with a non-zero count; cells aligned to columns; `shift_qty` = sum; `prior` from `prior_defects`.
- Job header: `qty_complete = work_order.qty_complete ?? derived_qty_complete ?? 0`; `progress = qty_released > 0 ? qty_complete / qty_released : 0` (clamp to [0, 1]).

### ShiftView (spec 9.2)

- Apply filters (job, product, operation, operator) to cells first; a job section is included when its job is in `active_job_numbers` and passes the filters. Jobs with no cells still appear (with zero rows) if active.
- Per job: operations ordered by route; each operation row aggregates eligible cells (`charged`, `units`, `target`, `pace`, color with no neutral rule except `charged < neutral_minutes`), `visitor_units` separately; `operators` = per-operator aggregates (eligible and visitors; visitors flagged, color `'visitor'`). Job efficiency via `computeRollups` on the job's cells.
- Row totals (here and in OperatorDetail): a cell keeps the StdHr in force when it was computed, so a standard changed mid-range gives one row several. `target` = sum of the cells' own `std * charged / 60`; `pace` = earned hours / charged hours over the same cells, the `computeRollups` arithmetic (with a single StdHr that is `units / target`), so an operation row always equals the efficiency of the same cells. Cells without a StdHr are left out of the pace as they are out of efficiency (pace null when none has one), and the `charged < neutral_minutes` neutral rule looks at the charged minutes of the cells with one, the time actually judged. The row's `std_hr` is the latest hour's (the standard in force now, as the TV and product page show it); null only when no cell has one.
- Summary from `computeRollups(all filtered cells)`; `active_jobs` = number of job sections; `eligible_operators` = distinct operators with an eligible cell.
- `in_progress = shift.start_utc <= now < shift.end_utc`.

### FloorView (spec 9.3)

One row per `(operator, job, op)` with an **eligible** cell in the current hour; plus visitor rows (`visitor: true`) for visitor-only cells so the UI can toggle them. `units_12h` = sum of the operator's units over `window_cells` (all jobs). `last_scan_at` from assignments; `minutes_since_scan = (now - last_scan)/60000`; `idle_flag = minutes_since_scan > floor_idle_flag_minutes`. Sort by operator name, job, op.

### OperatorDetail (spec 9.4)

- `strips`: one per `(job, op)` the operator touched within `columns`, cells aligned to columns like the TV; `std_hr` = the latest hour's.
- `rows`: per `(job, op)` over the full `range`: sums of window/charged minutes, `units` over the eligible cells and `visitor_units` over the visitor cells (visitor units never enter the pace, spec 7.3, as in ShiftView), `target`, pace and `std_hr` as in the row totals above, color (same bands, neutral when charged < neutral_minutes), `eligible_hours`/`visitor_hours` counts, `pinned` from an active pin.
- `summary`: `computeRollups` over the operator's cells in `range`, `.overall`: the earned-hours efficiency of the same cells as the operator's `by_operator` row in ShiftView (the page's Pace tile). Units and targets summed across rows with different StdHr would lean towards the fast operations.

### JobDetail (spec 9.5)

- `operators`: per operator over `all_cells`: units (all), charged (eligible only), list of operations.
- `shift_history`: for each shift instance, roll up cells with `hour_start_utc` in `[start, end)`; skip shifts with no cells. Order by shift start.

### ProductView (spec 9.6)

One row per route operation (plus any operation with a standard row not in the route). `effective` via `resolveEffectiveStandard`. `adjustments` returned = those in scope (global, product match, operation in route, product_operation match).

## Tests (spec 14, 15)

Write vitest tests under `packages/engine/test/` for every rule above and every acceptance scenario 1–13 in spec section 15 (use `America/New_York` and explicit `now` values; scenario 10 uses 2025-11-02 fall-back). Use small helper builders for steps. Tests must be deterministic and fast (< 5 s total).
