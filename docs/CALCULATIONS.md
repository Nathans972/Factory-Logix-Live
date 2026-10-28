# How the numbers work

This is a plain-language explanation of every calculation behind the TV dashboards and the
manager portal, for managers and supervisors rather than engineers. For the precise rules, see
`docs/SPEC.md` section 7 and `docs/ENGINE_NOTES.md`; the numbers below match those exactly.

## 1. Standard hour (StdHr)

**StdHr** is how many units per hour a product/operation should produce — the number
everything else is judged against. It is computed per (product, operation) from your own
production history, not entered by hand.

**How history is sampled**

- Only completed units (both a start and a complete scan) from the last `std_lookback_days`
  (default **365 days**) are considered. The current, still-open hour is never included.
- Only units completed by an operator who was **eligible** on that job/operation in that hour
  (see section 3) are counted — a quick rework scan-through does not get counted as production
  time for that operation's standard.
- If FactoryLogix tells us a unit was **reworked**, it is excluded — but only when the rework
  flag is actually mapped. If it is not mapped, no rework exclusion happens; the eligibility
  filter and the use of a median (below) absorb most of the distortion anyway.
- Units that took longer than `std_max_unit_minutes` (default **120 minutes**) are dropped —
  these are almost always a forgotten scan-out, not real work time.

**Correcting for batching (sessions)**

Operators sometimes scan several boards in, work all of them, then scan them all out together.
Taken literally, that makes each board look like it took the whole batch's time. To correct
for it, units from the same operator on the same product/operation that are close together in
time (within `session_gap_minutes`, default **10 minutes**, of each other) are grouped into a
**session**. The session's real elapsed time (minus any break overlap) is divided evenly across
the units in it. A single board worked start-to-finish with no batching is simply its own
one-unit session — the correction changes nothing for normal work.

**The standard itself**

- `median_minutes_per_unit` — the median (not the average) of every sampled unit's per-unit
  minutes. The median is used because it is far less sensitive to the occasional very slow or
  very fast outlier than an average would be.
- `computed_std_hr = 60 / median_minutes_per_unit`, rounded to one decimal place.

**Minimum sample**

A standard is only computed when there are at least `std_min_units` (default **20**) sampled
units from at least `std_min_operators` (default **2**) different operators. Below that, the
computed standard is left blank (`null`) rather than trusting too small a sample.

**Fallback, and what you see when there's no standard yet**

- If a computed standard isn't available yet, but FactoryLogix has its own standard hour value
  mapped for that product/operation, that value is used instead.
- If neither is available, the hour cells are still computed and shown — units, charged
  minutes, everything — but they are colored **neutral** (no judgment) instead of red/yellow/
  green/blue, and StdHr is shown as a dash.

**When it recomputes**

Every night at `std_recompute_time` (default **02:00** plant time), every product/operation
that received new completed units is recomputed. A manager can also trigger a recompute on
demand for one product or for everything (Admin > Standards, or the product page).

## 2. Adjustments vs. overrides

The **effective** StdHr used everywhere on the TV and in the portal is resolved in three steps,
most specific wins, and only one of the last two ever applies:

1. **Base** = the computed standard, or the FactoryLogix StdHr fallback, or nothing.
2. **Adjustment** (a percentage, e.g. "+10%") — the single **most specific active** adjustment
   applies: an adjustment scoped to this exact product+operation beats one scoped to just this
   operation type, which beats one scoped to just this product, which beats a plant-wide
   global adjustment. **Adjustments never stack** — only the most specific one applies.
3. **Override** (a hard replacement number) — if an active override exists, it **replaces
   everything above it**, adjustment included. A product+operation override beats a
   product-wide override.

**Worked example (spec scenario 12):** Base StdHr is 30.

| Step | Effective StdHr |
|---|---|
| Base only | 30 |
| + a global adjustment of +10% | 33 |
| An operation-level adjustment of +20% instead applies (more specific; does not add to the global one) | 36 |
| A hard override of 40 is set | 40 |

The override wins outright — the 36 from the adjustment is irrelevant once an override is
active. The product page (`/products/:z`) shows all four numbers — base, adjustment, override,
effective — and where each one came from, and every change is written to the audit log with
the note the manager entered.

## 3. Eligibility and visitors

Operators frequently "scan through" a handful of boards on a job they are not actually
working that hour — most often rework they were asked to clear, or boards they missed earlier.
Counting every scan as if the operator were working that job all hour would create a mostly
empty, artificially red row and would drag down that operation's standard. So the system
distinguishes:

- **Eligible operator** — spent enough time on a job/operation in an hour to count as actually
  working it.
- **Visitor** — scanned units on a job/operation without spending enough time to count as
  working it. Their units still count toward the job's totals (Prior, Shift, Qty Complete,
  defect counts) — production happened — but they do not get a colored row, do not contribute
  charged minutes, do not count toward pace, and their units are excluded from standards.

**The rule:**

- **Completed hours:** eligible if the operator spent at least `eligibility_minutes` (default
  **10 minutes**) of work time on that job/operation during the hour.
- **Current hour:** the 10-minute bar would unfairly flag everyone as a visitor in the first
  few minutes of every hour, so the threshold scales with how much of the hour has elapsed:
  `threshold = max(1, eligibility_minutes × elapsed_minutes / 60)`. At 6 minutes into the hour
  the bar is only 1 minute; by the top of the next hour it is the full 10. An operator who was
  already eligible on the same job/operation in the **previous** hour is also provisionally
  eligible right away (the "continuing operator" rule), so a long-running job doesn't flicker
  to a visitor at the top of every hour while evidence catches up.
- **Manager pins** (Admin/portal, manager role) force an operator eligible or force them to be
  treated as a visitor on a job (optionally a specific operation), overriding the rule above
  until the pin is removed or expires.

Slow operations are naturally safe under this rule: a 5-units/hour operation gives an operator
about 12 minutes of work time on a single board (60 ÷ 5), which still clears the 10-minute bar.

## 4. Ownership windows and charged minutes

Pace is judged against **wall-clock time an operator owned a job** — including any idle time in
the middle of it. That is deliberate: only counting "active" scanning time would hide time an
operator spent off-task.

- **Anchor (window start):** if the operator was already assigned to this job/operation at the
  end of the previous hour, the window starts at the top of the current hour. Otherwise it
  starts at their first scan on this job/operation.
- **Switch:** the window ends the instant the operator starts scanning a different eligible
  job/operation — that moment opens the new window.
- **Idle timeout:** if an operator has no scan on anything for more than
  `idle_timeout_minutes` (default **30 minutes**), their window closes at that 30-minute mark
  and they are no longer "assigned" anywhere. Time spent inside a scheduled break does not
  count against the idle clock. If they scan again later, a fresh window opens.
- Multiple back-and-forth segments on the same job/operation within one hour are added
  together.
- **Charged minutes** = the window minutes minus any overlap with scheduled breaks
  (`break_minutes`). The `count_work_during_breaks` setting (default **off**) can instead only
  subtract a break when the operator completed **no** units during it — i.e. if they worked
  through the break, that time is not taken away from them.

## 5. Target, pace, and color

For every (operator, job, operation, hour):

- `target_units = effective StdHr × charged_minutes / 60`
- `pace = units / target_units`

Color bands (the thresholds — 70/90/105 — are configurable in Admin > Engine; these are the
defaults):

| Condition | Color |
|---|---|
| No scans and no window this hour | blank (empty cell) |
| StdHr unavailable | neutral (gray text, no fill) |
| Current hour and charged minutes < `neutral_minutes` (default 5) | neutral |
| pace < 0.70 | red |
| 0.70 ≤ pace < 0.90 | yellow |
| 0.90 ≤ pace ≤ 1.05 | green |
| pace > 1.05 | blue |
| Operator is a visitor on this job/operation | visitor (gray fill, count shown, no judgment) |

The cell always shows the **actual unit count**, never a projected number. Because charged
minutes already reflect a partial hour (arrived mid-hour, left mid-hour, a break in the
middle), a completed hour where someone only worked 20 minutes is judged against a 20-minute
target, not a full hour's — this is why partial hours are not automatically red (see the FAQ).

## 6. Grouped mode

Some TVs are configured to show one row per operation instead of one row per operator (Admin >
Displays > "Group operators by operation"):

- `units` = every unit completed on that operation this hour, **including visitor units** — it
  is a raw production count.
- `charged_minutes` = summed across **eligible operators only**.
- `target_units = StdHr × charged_minutes / 60`.
- The pace numerator is **eligible operators' units only** — visitor units are still shown in
  the displayed count, but do not affect pace or color.

**Worked example (spec scenario 8):** Two eligible operators on the same operation, charged 60
and 30 minutes (90 combined), 50 units between them, StdHr 30. `target = 30 × 90 / 60 = 45`.
`pace = 50 / 45 = 1.11` → **blue**. A visitor who scanned 3 more units on that operation makes
the displayed count 53, but pace still uses 50 (the eligible units) — the visitor's units do
not change the color.

## 7. Rolling 12-hour window (TV) — Prior, Shift, StdDay

The TV shows the 12 clock hours ending with the current hour (e.g. `10 11 12 13 ... 21`). At
the top of every hour the oldest column drops off the left and a new one appears on the right.

- **Prior** — units on this job completed by this operator/operation **before** the window
  started. Prior plus the 12 visible columns equals the operator's whole total on the job.
- **Shift** — the sum of the 12 visible hourly columns (the name is kept from the legacy
  dashboard; it is not the same as a portal shift).
- **StdDay** (optional column) — effective StdHr × the display's configured shift length in
  hours (default **12**).

## 8. Defects

The defect table at the bottom of the TV mirrors the same 12 columns: Prior (before the
window), the 12 hourly counts, and ShiftQty (their sum) — counted per operation, combined
across every operator. Any hour with one or more defects is filled red; hours with zero
defects are plain.

## 9. Job progress

The ring gauge shows `progress = qty_complete / qty_released` (0% if nothing has been
released). `qty_complete` comes straight from the FactoryLogix work order when that field is
mapped; otherwise it is derived as the count of units that completed the job's last route
operation.

## 10. Shift roll-ups: earned hours and efficiency

The portal's shift view, and every breakdown by job/operation/operator, need to combine rows
that have **different standards** into one number. Multiplying units together would not mean
anything across different operations, so roll-ups use **earned hours** instead:

- `earned_hours = units / StdHr` for each row (this is "how many standard hours of output this
  row represents").
- `charged_hours = charged_minutes / 60`.
- `efficiency = (sum of earned_hours) / (sum of charged_hours)` across the rows being rolled
  up. 100% means the group produced exactly at standard overall. It is colored with the same
  70/90/105 bands as pace. Rows with no StdHr are left out of the efficiency number and flagged
  in the UI rather than silently treated as zero.

**Worked example (spec scenario 13):** two rows in a shift — 60 units at StdHr 30 with 60
charged minutes, and 10 units at StdHr 12 with 60 charged minutes.

```
earned = 60/30 + 10/12 = 2.0 + 0.833 = 2.833 hours
charged = 60/60 + 60/60 = 1.0 + 1.0 = 2.0 hours
efficiency = 2.833 / 2.0 = 1.42  ->  blue (142%, well above the 105% blue threshold)
```

## More worked examples

**Partial first hour (spec scenario 1).** An operator starts at 15:20 and completes 4 units by
16:00 on a StdHr-30 operation. Charged minutes = 40 (15:20 to 16:00). `target = 30 × 40/60 =
20`. `pace = 4/20 = 0.20` → **red**. With 18 units in that same 40 minutes instead: `pace =
18/20 = 0.90` → **green**. Notice the target itself is only 20, not 30 — because charged
minutes reflect the partial hour, not the full 60.

**Current-hour prorating (spec scenario 2).** At 09:10, a continuing operator has 5 units on a
StdHr-30 job, no breaks. Charged = 10 minutes so far. `target = 30 × 10/60 = 5`. `pace = 5/5 =
1.00` → **green**, from the first few minutes of the hour. At 09:03 with 0 units yet: charged =
3 minutes, which is below `neutral_minutes` (5) → **neutral** (too early to judge).

**Split hour (spec scenario 4).** An operator works Job A from 09:00–09:40, then Job B from
09:40–10:00. Job A gets 40 charged minutes, Job B gets 20 — each judged on its own window, both
eligible, no penalty for switching mid-hour.

**Break subtraction (spec scenario 5).** A 15-minute break runs 14:00–14:15. An operator
continuing through the whole 14:00 hour completes 22 units on a StdHr-30 job. Window = 60
minutes, minus the 15-minute break = **charged 45 minutes**. `target = 30 × 45/60 = 22.5`.
`pace = 22/22.5 = 0.98` → **green**.

## FAQ

**Why is my first hour not red anymore?**
The old dashboard judged every hour against a full hour's target, so arriving at 15:20 and
only having 40 minutes to work with before 16:00 always looked bad. This system's target
scales with the minutes actually charged to that hour, so a partial hour is judged fairly
against a partial target (see the worked examples above).

**Why does a cell change color mid-hour?**
The current hour is marked **provisional** and is recomputed after every poll. As units keep
completing and charged minutes keep accumulating, pace — and therefore color — can legitimately
move until the hour closes. This is expected, not a bug; once the hour ends it is computed one
final time and stops changing.

**Why is an operator missing from the TV?**
Either they were a **visitor** (not eligible) in every hour currently on screen — the row is
intentionally omitted rather than shown as an all-gray row (spec 8.5) — or their idle timeout
expired with no scans in the visible window, so they have no open window on any job right now.

**What happens when a standard changes during a shift?**
Hours that have already been computed keep the StdHr they were judged against; only hours
computed after the change (an override, an adjustment, or the nightly recompute) use the new
one. A row on the shift view or the operator page adds its hours up: its target is the sum of
each hour's own target, and its pace is earned hours over charged hours — the same arithmetic
as the job efficiency, so the two always agree for the same work (with a single standard it is
simply units / target). The StdHr column shows the latest standard. If part of the row ran with
no standard at all, the row is left unjudged, just like the job efficiency.

**Why is StdHr a dash?**
There is not yet enough sampled history for that product/operation (fewer than the configured
minimum units or distinct operators) and no FactoryLogix StdHr is mapped as a fallback. Cells
still compute and display units normally; they are just shown in neutral gray until a standard
exists — after backfill finishes and the nightly recompute runs, or after a manual recompute
from Admin > Standards.
