# FactoryLogix Live Production Dashboard and Manager Portal

## Product Specification v1.0

This document is the complete specification for a standalone, on-premises web application that reads production data from an Aegis FactoryLogix MES installation, stores it in its own database, and serves (1) live TV dashboards on the factory floor and (2) a manager portal with shift-level views, drill-downs, and administration. It is written so that an engineer or an AI coding agent can build the system without further context.

Everything in this document was agreed with the product owner. Where a decision was left open, it is marked **ASSUMPTION** and a default is given. Where something must be verified on-site, it is marked **VERIFY**.

---

## Table of Contents

1. Purpose, Scope, and Constraints
2. Glossary
3. System Architecture
4. FactoryLogix Integration (Collector)
5. Time and Time Zones
6. Data Model
7. Calculation Engine
8. TV Display Application
9. Manager Portal
10. Admin Area
11. Settings and Defaults
12. Demo Build (GitHub Pages)
13. Repository, Delivery, and Deployment
14. Non-Functional Requirements
15. Acceptance Scenarios
16. Open Items, Assumptions, and Future Work

---

## 1. Purpose, Scope, and Constraints

### 1.1 Purpose

The customer runs Aegis FactoryLogix MES on-premises. Operators scan every board (unit) at the start and completion of each process step. The customer's existing floor dashboard is an old browser page that refreshes every 10 minutes, colors hours only against a manually entered "standard hour" value that is rarely maintained, and is visually dated. Managers who want to see what is happening across the floor have to use FactoryLogix DataMiner, job by job, which is slow and awkward.

This product replaces the floor dashboard and gives managers a single live view, while never touching or loading the FactoryLogix system beyond a small, throttled, read-only poll.

### 1.2 Goals

- Live floor dashboards on TVs that refresh every 1 to 2 minutes (3 minutes maximum).
- Keep the look and layout of the existing dashboard so operators are not disoriented. Improve it only where it is clearly broken or unhelpful.
- Compute realistic hourly standards from historical data instead of relying on manually entered values, with manager overrides.
- Color hours by pace (prorated), not by raw count, so the current hour is meaningful from the first minutes.
- Handle "touch-up" rework scans and mid-hour job switching correctly.
- Store all ingested data permanently in our own database so future tools can be built on it without re-querying FactoryLogix.
- A manager portal that shows, in one place, every active job, every operator, hourly output, and a shift-level "are we on target" number, defaulting to the current shift.
- Admin screens for displays, shifts, breaks, standards, users, and the FactoryLogix connection.
- Delivered as a GitHub repository with a README that lets the customer's IT install it on their own server, plus a public demo on GitHub Pages using simulated data.

### 1.3 Non-Goals (v1)

- Not multi-tenant. Built for one company. No SaaS.
- Never writes to FactoryLogix. Read-only.
- No mobile-specific management UI. Managers use desktops.
- No projected-count display on the TV (the color already conveys pace).
- No direct SQL access to the FactoryLogix database.
- No IPC-CFX or real-time message bus integration in v1 (polling is sufficient).

### 1.4 Hard Constraints

1. **Isolation.** The application runs as a separate process set with its own database, ideally on its own VM. If this application fails, FactoryLogix and the factory keep running. If FactoryLogix is unreachable, this application keeps serving the last known data with a visible "data delayed" indicator.
2. **Load protection.** All reads from FactoryLogix are incremental, paged, time-limited, and circuit-broken. The one-time historical backfill is chunked and throttled.
3. **On-premises, internal only.** Served on an internal hostname (no public domain). TVs and managers reach it over the plant LAN.
4. **Read-only credentials.** The FactoryLogix account used by the collector has the minimum rights needed to read DataMiner data sources.
5. **No real customer data in the demo.** The public demo uses invented company, product, job, operator, and process names.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| FactoryLogix (FL) | Aegis Software's MES. Source of all production data. |
| DataMiner | The reporting/analysis area of FactoryLogix Analytics. Its "data sources" are the system-defined views we read via OData. |
| Report Scheduler Service | The FactoryLogix Windows service that also hosts the OData endpoint. |
| OData | Open Data Protocol. HTTP/JSON, self-describing (`$metadata`), supports `$filter`, `$select`, `$top`, `$orderby`, `$skip`. |
| Job / J-number | A work order for a specific production run. Format resembles `J#########-####`. Has Qty Released and Qty Complete. |
| Product / Z-number | The product (and its process/route) identifier. Format resembles `Z####-##`. Stable across many jobs. Standards are keyed by Z-number, never by J-number. |
| Operation / Step | A process step in the product's route, e.g. "Selective Solder - Top". |
| Unit / Board | One physical item being produced. Identified by serial or unit ID. |
| Start scan / Complete scan | FactoryLogix records when a unit is started at an operation and when it is completed there. These two timestamps define the unit's work interval at that operation. |
| Operator | The FactoryLogix user who performed the scans (e.g. `JDoe`). |
| Display | One TV. Identified by a pairing code and device token. Assigned exactly one job at a time. |
| Hour cell | One (operator, job, operation, clock hour) bucket with units, charged minutes, eligibility, pace, and color. The fundamental computed record. |
| StdHr | Standard units per hour for (Z-number, operation). Computed from history, adjustable, overridable. |
| StdDay | StdHr multiplied by the configured shift length in hours. Optional column. |
| Eligible operator | An operator who, in a given hour, spent at least the configured minimum work time on a job/operation and therefore "counts" as working it. |
| Visitor | An operator whose scans on a job/operation in an hour fall below the eligibility threshold (typically rework scan-throughs). Their units count toward totals; they are not counted as an operator. |
| Ownership window | The wall-clock span during which an eligible operator is considered to own a job/operation within an hour. Includes idle time. Breaks are subtracted. |
| Charged minutes | Ownership window minutes minus break minutes. The denominator of pace. |
| Pace | Units completed divided by target units, where target = StdHr × charged minutes / 60. |
| Shift | A named schedule (start, end, days, effective-from). Plant-wide. Used by the portal only. |
| Break | A scheduled interval (start, duration) subtracted from charged minutes. Plant-wide. Used everywhere. |
| Rolling window | The TV shows the current clock hour plus the previous 11 (12 columns). The window slides every hour. |
| Prior | Units on the job completed before the rolling window (TV) or before the shift (portal). |
| Earned hours | Units divided by StdHr. Used to roll up efficiency across jobs with different standards. |
| Efficiency | Earned hours divided by charged hours, across a set of hour cells. |

---

## 3. System Architecture

### 3.1 Components

```
+---------------------------+          +--------------------------------------+
|  FactoryLogix (customer)  |  OData   |  Collector (Node/TS service)         |
|  Report Scheduler Service | <------- |  - polls every N seconds             |
|  http://<host>:6065/odata |          |  - incremental, paged, throttled     |
+---------------------------+          |  - maps fields per mapping config    |
                                       |  - upserts into our DB               |
                                       |  - triggers engine recompute         |
                                       +------------------+-------------------+
                                                          |
                                                          v
                                       +--------------------------------------+
                                       |  PostgreSQL 16 + TimescaleDB         |
                                       |  raw events, normalized tables,      |
                                       |  hour_cells, standards, config       |
                                       +------------------+-------------------+
                                                          |
                                       +------------------+-------------------+
                                       |  API (Node/TS, Fastify)              |
                                       |  REST + Server-Sent Events           |
                                       |  auth, roles, admin endpoints        |
                                       +------------------+-------------------+
                                                          |
                     +------------------------------------+-----------------------------+
                     v                                    v                             v
        +------------------------+          +------------------------+      +------------------------+
        |  TV Display (web)      |          |  Manager Portal (web)  |      |  Admin (web)           |
        |  /tv                   |          |  /                     |      |  /admin                |
        +------------------------+          +------------------------+      +------------------------+

        Shared package: packages/engine (pure TypeScript calculation engine, no I/O).
        Used by the API/collector on the server and by the browser in the demo build.
```

### 3.2 Recommended stack

**Recommendation, not a mandate.** The one architectural requirement is that the calculation engine be a pure, dependency-free TypeScript package so the same code runs on the server (production) and in the browser (GitHub Pages demo). Everything else may be swapped if the builder has a strong reason.

- Language: TypeScript everywhere (single language, shared engine and types).
- Database: PostgreSQL 16 with the TimescaleDB extension (hypertables, compression, continuous aggregates).
- Backend: Node.js 20 LTS, Fastify, `pg` driver, `node-cron` or equivalent for scheduled jobs.
- Frontend: React 18 + Vite, React Router, TanStack Query for data fetching, plain CSS or CSS modules (the TV page must be pixel-controllable; avoid heavy UI kits on it).
- Realtime to browser: Server-Sent Events (SSE) with polling fallback. WebSockets are acceptable but not required.
- Packaging: Docker Compose (four services: db, collector, api, web/nginx).
- Monorepo tooling: pnpm workspaces.

### 3.3 Data flow

1. Collector polls FactoryLogix OData on an interval (default 90 seconds).
2. Each poll pulls only rows changed since the last watermark for each data source, with an overlap margin, and upserts them into normalized tables. The raw JSON payload is stored alongside.
3. After each successful poll, the engine recomputes hour cells for the affected time range (current hour and previous hour, plus any older hours touched by late-arriving rows). Hours whose recompute fails are recomputed again after the next poll, and until they are the poll does not count as successful for the health state (4.6).
4. The API pushes a "data updated" event over SSE. TV pages and portal views refetch their data.
5. Nightly (configurable time), the engine recomputes standards for every (Z-number, operation) that received new data.

### 3.4 Failure behavior

- FactoryLogix unreachable or slow: collector backs off (see 4.6). TV and portal continue to show last data with a banner "Data delayed since HH:MM".
- Our database down: API returns 503; TV shows "Dashboard unavailable" with the display name and pairing code; nothing on the FactoryLogix side is affected.
- Collector crash: restarts under Docker's restart policy; resumes from persisted watermarks.

---

## 4. FactoryLogix Integration (Collector)

### 4.1 Primary method: OData connector

FactoryLogix (2019.1 and later) exposes DataMiner data sources over OData, hosted by the Report Scheduler Service:

- URL: `http://<factorylogix-server>:6065/odata`
- Metadata: `http://<factorylogix-server>:6065/odata/$metadata` (returns EDMX XML listing every entity set and its fields)
- Authentication: HTTP Basic with a FactoryLogix user name and password. FactoryLogix performs the authentication (not Windows, not SQL). Anonymous access does not work.
- Prerequisite on the FactoryLogix side: the Report Scheduler Service must be running and pointed at the correct database.

Standard OData query options apply: `$filter`, `$select`, `$orderby`, `$top`, `$skip`, `$count`. Use `$select` to fetch only mapped columns.

**VERIFY on-site before or at install:** (a) FactoryLogix version is 2019.1 or later; (b) `$metadata` responds when opened in a browser on the plant network with a FactoryLogix login; (c) OData is licensed/enabled for their installation (the documentation does not tie it to the xStream add-on, but FactoryLogix modules are licensed individually). The `$metadata` XML is also the schema reference the mapping wizard needs.

**Version 1 assumption:** The customer's existing data and licensing are assumed sufficient. Build against the documented, system-defined DataMiner data source shapes; let the mapping wizard resolve field names; surface any structural mismatch at install time through the connection test and preview step (see 10.7).

### 4.2 Fallback method: scheduled template export

If OData is unavailable, FactoryLogix can export data on a schedule: a DataMiner template is created, the Report Scheduler runs it at an interval, and the output is written to a folder. Exporting data grid or pivot table data to a folder automatically requires the FactoryLogix **xStream** add-on; without it the scheduler only produces charts/formatted reports or emails.

The collector must have a pluggable "source" abstraction so a `FileDropSource` (watch a folder, parse CSV/XLSX, dedupe by key) can be implemented later without changing anything downstream. Do not build the file source in v1; build the abstraction.

### 4.3 Never use direct SQL

Reading the FactoryLogix SQL Server directly is prohibited. It couples us to an undocumented schema, breaks on upgrades, and can void vendor support.

### 4.4 Data required from FactoryLogix

The collector must obtain, via mapped data sources:

1. **Work order header** (one row per job): job number (J), product number (Z), product description/name, quantity released, quantity complete, status, created/released dates. If quantity complete is not available as a field, derive it as the count of units that completed the last operation in the job's route.
2. **Unit process events** (one row per unit per operation, or start/complete events joinable by unit and operation): unit ID (serial), job number, product number, operation name/ID, operation sequence number, operator ID/name, start timestamp, complete timestamp, result (pass/fail) if present, rework/re-process flag if present, last-modified timestamp if present.
3. **Defects** (one row per defect record): unit ID, job number, operation where found, defect code/description, operator, timestamp, status.
4. **Operators** (list of user IDs and display names) if available; otherwise derive from the events.
5. **Route/operations per product** (ordered list of operations for a Z-number) if available; otherwise derive from events (distinct operations per Z, ordered by sequence number or by first-seen order).
6. **FactoryLogix standard hour** per (Z, operation) if present. Used only as a fallback when we have insufficient history.

**VERIFY:** exact data source names and field names; whether start and complete timestamps are two columns on one row or two rows; whether a rework flag exists; whether a reliable last-modified timestamp exists per data source.

### 4.5 Incremental polling algorithm

For each mapped data source `S`:

```
watermark[S] = last successfully ingested value of S.watermark_field (timestamp or monotonically increasing ID),
               persisted in table sync_state.
overlap      = settings.poll_overlap_minutes (default 10)

on each poll:
  since = watermark[S] - overlap
  loop:
    rows = GET S ?$filter=<watermark_field> ge since
                 &$orderby=<watermark_field> asc
                 &$top=<page_size default 500>
                 &$skip=<offset>
                 &$select=<mapped columns>
           with HTTP timeout settings.odata_timeout_seconds (default 20)
    upsert rows by natural key (see 6.1)          // idempotent; overlap re-pulls are harmless
    store raw payload in raw_events                // only when new or changed (raw_event_hashes)
    if rows.length == 0: break
    if rows.length < page_size and an earlier request of this pull came back full: break
    offset += rows.length
  watermark[S] = max watermark value seen, not counting timestamps after the poll time
                 (only after the whole pull succeeds)
  record poll stats (rows, ingested, skipped, duration, status) in sync_log
```

Rules:
- A row stamped in the future (a station with a wrong clock, a 9999-12-31 placeholder) is ingested but does not move a timestamp watermark: a watermark ahead of real time would make every later poll skip new rows. A stored watermark found ahead of the poll time is replaced; that poll reads from the first-run lookback (2 h).
- If a data source has no usable watermark field, use a time window on the primary timestamp with the same overlap, and additionally re-pull the last `settings.late_data_hours` (default 24) once per hour to catch late updates (defect closed later, unit reworked).
- A data source with no watermark yet (the first run) reads from 2 h back; work_orders reads from as far back as the late-data re-pull reads unit steps (`late_data_hours`), so the jobs of the first run's unit steps are in the database. A unit step whose job is still not in the database (a job still running that FactoryLogix last changed before that) fetches its work order by job number first (`<job field> eq '<job>'`, 10 jobs a request joined by `or`). Otherwise the job is missing from the job lists, and a step that takes its product from the work order is skipped every time it is read, until the backfill reaches the job (never with `backfill_days` 0). A job FactoryLogix does not have is asked for at most once an hour; a lookup that fails is logged and the steps are written as they would be without it.
- Page size and overlap are settings. Keep pages small (500) so no single query is heavy.
- A service that pages on its own side answers with `@odata.nextLink`. Follow the links: `rows` above is what the request and its links returned together. `$top` still caps that total, so a full answer is not the end; the next request skips past it.
- A service with a result limit below `page_size` answers with fewer rows than `$top` and no nextLink even when more rows match. Read as the end, that would stop every pull at the limit: once the overlap holds more rows than that, every poll reads the same oldest rows and the watermark never moves again. So a short answer is the end only after a request of the same pull came back full (the service sends `$top` rows when it has them). Until then the next request skips past the short answer's rows, and only an empty answer ends the pull. A pull of one short page costs one more, empty request. A service that ignores `$skip` answers that request with the short answer again; the pull ends there instead of reading it again up to the page cap.
- FactoryLogix answers each page request from the table as it is at that moment. A row read on one page that changes before the next request moves to the end of the order, every row behind its old place moves up one, and the next `$skip` steps over a row that no later poll reads (it is behind the new watermark). So a pull notes the natural key and watermark value of every row it reads. A row that comes back on a later page of the same pull with another value means rows moved (a row inserted ahead only brings the last row read back unchanged, which loses nothing): the pull reads again from the watermark at the end of the page that row was first read on (`ge` that value, no overlap, offset 0), until a pass reads through with nothing moving; the watermark is that pass's. If rows are still moving at the page cap, or the place to read again from has not moved on, the watermark stops there and the next poll reads on from it. The late-data re-pull and the backfill windows do the same; the backfill's work-order window is open at the end, so a job changed during it comes back instead of leaving the window.
- A poll reads at most 200 pages; the watermark is the maximum read so far. When more rows than that fall in the overlap window (a bulk update giving them all one ModifiedDate), a poll that started again from the watermark would read the same rows every time and never get past them. So a poll that stops at the page cap with nothing moving notes where it stopped, and the next poll, while the watermark is still the one it stored, goes on with the same query from a page before that offset. Rows read before that point that changed in between have moved to the end and the rows behind them have moved up, so it first looks for the last row read: found unchanged within the first two pages, nothing was stepped over; otherwise it reads again from the watermark. The stop point is kept in memory; after a restart the poll reads from the watermark.
- Poll data sources sequentially, not in parallel, to keep FactoryLogix load flat.
- Every query has a hard timeout. A timed-out query counts as a failure for the circuit breaker.

### 4.6 Throttling and circuit breaker

- After `settings.breaker_failure_threshold` (default 3) consecutive failed polls (HTTP error, timeout), the collector enters backoff: retry after 2× interval, then 4×, up to `settings.breaker_max_backoff_minutes` (default 10). A successful poll resets it.
- A refused login (HTTP 401, or 403 while nothing else came back that poll) is not retried: it does not heal by itself, and repeated failed logins can lock the FactoryLogix account. The collector stops polling with it (no backfill chunk, no `$metadata` either), says so in Sync health, and polls again once the FactoryLogix connection is saved again (any save, including one that keeps the password) or the collector restarts. A refused backfill chunk stops the backfill until the next poll.
- Health state (`ok`, `degraded`, `down`, last success time) is exposed by the API and shown in admin and as the "data delayed" banner on TV/portal when the last successful poll is older than 3× the poll interval.

### 4.7 Historical backfill

- On first run (and on demand from admin), backfill `settings.backfill_days` (default 180) of history, oldest first, one day per chunk, with `settings.backfill_pause_seconds` (default 5) between chunks.
- Backfill runs only inside the configured off-shift window (`settings.backfill_window`, default 22:00 to 05:00 plant time) unless an admin explicitly runs it "now".
- The first day of the range is saved when the backfill starts and every chunk counts from it, so a backfill that runs across midnight processes every day exactly once.
- When the download completes, standards are computed, then the hour cells of every backfilled day are recomputed one day per chunk (status `recoloring`, same window and pause rules) so the history gets standards and colors.
- Progress (days downloaded, the saved first day, the recoloring counters) is persisted, so after a restart the backfill resumes at the next day of the phase it was in.

### 4.8 Field mapping

Mapping is configuration, not code. See 10.7 for the wizard. The collector reads a `mapping.json` (stored in DB, editable in admin) of the form:

```json
{
  "work_orders": {
    "entity_set": "WorkOrders",
    "watermark_field": "ModifiedDate",
    "key": ["WorkOrderNumber"],
    "fields": {
      "job_number": "WorkOrderNumber",
      "product_number": "PartNumber",
      "product_name": "PartDescription",
      "qty_released": "QuantityReleased",
      "qty_complete": "QuantityComplete",
      "status": "Status"
    }
  },
  "unit_steps": {
    "entity_set": "UnitProcessHistory",
    "watermark_field": "CompletedDate",
    "key": ["UnitSerial", "WorkOrderNumber", "OperationName", "StartedDate"],
    "fields": {
      "unit_id": "UnitSerial",
      "job_number": "WorkOrderNumber",
      "product_number": "PartNumber",
      "operation": "OperationName",
      "operation_seq": "OperationSequence",
      "operator": "OperatorName",
      "start_ts": "StartedDate",
      "complete_ts": "CompletedDate",
      "result": "Result",
      "rework_flag": null
    }
  },
  "defects": { "...": "..." }
}
```

Entity set and field names above are illustrative placeholders; real names come from `$metadata`. Any target field may be mapped to `null` (not available), and the engine must degrade gracefully (see 7.1 for rework flag absence).

---

## 5. Time and Time Zones

The existing dashboard does not handle daylight saving time. This system must.

1. **Storage:** every timestamp in our database is stored as `timestamptz` (UTC).
2. **Plant time zone:** a single IANA time zone in settings (e.g. `America/New_York`). All clock-hour bucketing, column labels, shift and break definitions, and display clocks use it.
3. **Hour buckets:** an hour cell is the local clock hour `[HH:00, HH+1:00)` converted to a UTC range. On the fall-back night one local hour occurs twice; the engine keys hour cells by `hour_start_utc`, so both occurrences are distinct cells, and the TV label shows the local hour for each (two columns may share a label that night; acceptable). On the spring-forward night one local hour does not exist; the rolling window simply contains 12 consecutive UTC hours.
4. **Rolling windows** are computed in UTC (now minus 11 full hours), so DST transitions do not create gaps or overlaps.
5. **FactoryLogix timestamp interpretation:** a setting `fl_timestamp_mode` with values `offset_present` (ISO strings include offset; parse directly), `utc` (naive strings are UTC), or `local_no_offset` (naive strings are plant-local). For `local_no_offset`, the ambiguous repeated hour on fall-back night is resolved by monotonic ordering: if a row's naive timestamp is more than 30 minutes earlier than the previous row from the same data source in ingestion order (rows compared as instants), treat it and that source's following rows in the repeated hour as the second occurrence, until a row outside that hour. A row read again (overlap, late-data re-pull) keeps the reading it got first, and a second-occurrence reading later than the time the rows were fetched is never used. In `local_no_offset` mode offset-less `/Date(ms)/` values are read as plant wall-clock time too, and time filters on OData v2/v3 `Edm.DateTime` fields are written in plant wall-clock time (`datetime'...'`; a lower bound in the first pass through the fall-back night's repeated hour is written an hour earlier, so the second pass is not filtered out); OData v4 and `Edm.DateTimeOffset` literals stay UTC. **VERIFY** which mode applies by inspecting `$metadata` types and sample rows.
6. **Shifts and breaks** are defined in local time and may cross midnight. They are expanded to concrete UTC intervals per calendar day when evaluated.

---

## 6. Data Model

PostgreSQL. Names are suggestions; keep the semantics. `hour_cells`, `unit_steps`, `defects`, and `raw_events` should be TimescaleDB hypertables partitioned on their primary timestamp with compression enabled for chunks older than 7 days.

### 6.1 Ingested (normalized) tables

**products**
- `product_number` (Z) PK, `name`, `first_seen_at`, `last_seen_at`

**operations**
- `id` PK, `name` (unique), `first_seen_at`

**product_routes**
- `product_number`, `operation_id`, `sequence` (int), PK(product_number, operation_id)

**operators**
- `operator_id` (FL user name) PK, `display_name`, `first_seen_at`, `last_seen_at`

**work_orders**
- `job_number` (J) PK, `product_number` FK, `product_name`, `qty_released` int, `qty_complete` int, `status`, `fl_created_at`, `fl_modified_at`, `ingested_at`, `updated_at`

**unit_steps**  (hypertable on `start_ts`)
- `id` bigserial, `unit_id`, `job_number`, `product_number`, `operation_id`, `operator_id`, `start_ts` timestamptz, `complete_ts` timestamptz null, `result`, `rework_flag` bool null, `fl_modified_at`, `natural_key` text unique (built from mapping key), `ingested_at`, `updated_at`
- Indexes: (operator_id, start_ts), (job_number, operation_id, complete_ts), (product_number, operation_id, complete_ts), (complete_ts)

**defects**  (hypertable on `found_ts`)
- `id`, `unit_id`, `job_number`, `operation_id`, `operator_id`, `defect_code`, `description`, `found_ts`, `status`, `natural_key` unique

**raw_events**  (hypertable on `received_at`)
- `id`, `source` text, `natural_key`, `payload` jsonb, `received_at`
- Purpose: preserve every field FactoryLogix sent, including unmapped ones, so future tools can use them. Compress aggressively.
- One row per version of a record: a re-read whose payload is unchanged is not stored again.

**raw_event_hashes**
- `source`, `natural_key` (PK together), `payload_hash` (sha256 of the last stored payload JSON), `updated_at`

**sync_state**
- `source` PK, `watermark` text, `last_success_at`, `last_error`, `consecutive_failures` int, `backfill_progress` jsonb
- Source `late_data`: `watermark` is the last late-data re-pull attempt; failures back off (1 h, doubling, at most 6 h).

**sync_log**
- `id`, `source`, `started_at`, `finished_at`, `rows`, `ingested`, `skipped`, `status`, `error`

### 6.2 Computed tables

**hour_cells**  (hypertable on `hour_start_utc`)
- `hour_start_utc` timestamptz, `job_number`, `product_number`, `operation_id`, `operator_id`
- `units` int (completed in this hour by this operator on this job/operation)
- `work_minutes` numeric (sum of start-to-complete overlap with the hour; eligibility measure)
- `window_minutes` numeric (ownership window inside the hour, before breaks)
- `break_minutes` numeric
- `charged_minutes` numeric (= window − break)
- `eligible` bool
- `provisional` bool (true while the hour is current)
- `std_hr` numeric (the standard in effect when computed)
- `target_units` numeric, `pace` numeric null, `color` enum('blank','neutral','red','yellow','green','blue','visitor')
- `computed_at`
- PK(hour_start_utc, job_number, operation_id, operator_id)

**defect_hour_cells**
- `hour_start_utc`, `job_number`, `operation_id`, `count` int; PK(hour_start_utc, job_number, operation_id)

**operator_assignment_state**
- `operator_id` PK, `job_number`, `operation_id`, `assigned_since`, `last_scan_at`
- The engine's carried-forward "what is this operator currently on" state, used to anchor windows at the top of the hour.

**standards**
- `product_number`, `operation_id`, `computed_std_hr` numeric null, `median_minutes_per_unit`, `sample_units` int, `sample_operators` int, `sample_from`, `sample_to`, `computed_at`, `fallback_source` enum('computed','fl_std_hr','none'), `fl_std_hr` numeric null
- PK(product_number, operation_id). Keep a `standards_history` table with the same columns plus `id` for audit.

**standard_adjustments**
- `id`, `scope` enum('global','product','operation','product_operation'), `product_number` null, `operation_id` null, `percent` numeric (e.g. +20 or −10), `created_by`, `created_at`, `note`

**standard_overrides**
- `id`, `scope` enum('product','product_operation'), `product_number`, `operation_id` null, `std_hr` numeric, `created_by`, `created_at`, `note`, `active` bool

### 6.3 Configuration tables

**displays**
- `id`, `pairing_code` char(4) unique, `device_token` uuid unique, `name` null, `claimed_at` null, `job_number` null, `group_operators` bool default false, `show_std_day` bool default true, `show_gauge` bool default true, `shift_length_hours` numeric default 12, `last_seen_at`, `created_at`

**shifts**
- `id`, `name`, `start_local` time, `end_local` time, `days_of_week` int[] (0=Sunday), `effective_from` date, `effective_to` date null, `created_by`, `created_at`

**breaks**
- `id`, `name`, `start_local` time, `duration_minutes` int, `days_of_week` int[], `shift_ids` int[] null (null = all shifts), `effective_from` date, `effective_to` date null, `created_by`, `created_at`

**settings**
- `key` PK, `value` jsonb, `updated_by`, `updated_at`  (see section 11)

**users**
- `id`, `username` unique, `password_hash` (argon2 or bcrypt), `role` enum('admin','manager','viewer'), `active`, `created_at`, `last_login_at`, `session_version` (bumped by logout, password reset and deactivation to end the user's sessions)

**audit_log**
- `id`, `at`, `user_id`, `action`, `entity`, `entity_id`, `before` jsonb, `after` jsonb

**operator_pins**
- `id`, `operator_id`, `job_number`, `operation_id` null, `mode` enum('force_eligible','force_visitor'), `created_by`, `created_at`, `expires_at` null
- Manager override for the eligibility rules (see 7.3).

### 6.4 Size and retention

Estimate: 20,000 units/day × 15 operations = 300,000 unit_steps/day, plus defects and raw payloads. Under 100 MB/day uncompressed; with TimescaleDB compression, a year is tens of GB at most. No deletion in v1. Provide a `retention_days` setting (default null = keep forever) for raw_events only.

---

## 7. Calculation Engine

The engine is a pure TypeScript package (`packages/engine`) with no database or network access. It takes plain data (unit steps, defects, work orders, standards, shifts, breaks, settings, "now") and returns hour cells and roll-ups. The server feeds it from the database; the demo feeds it from an in-browser simulator. All rules below live only in the engine.

### 7.1 Standard hour (StdHr) computation

Computed per (product Z-number, operation), across all jobs and all operators, from historical unit_steps.

**Sample selection**
- Units with both `start_ts` and `complete_ts`.
- Only units completed by operators who were eligible (7.3) on that job/operation in that hour. Visitor scan-throughs are excluded.
- Exclude units with `rework_flag = true` when the flag is mapped. When it is not mapped, no rework exclusion is attempted (the median and the eligibility filter provide most of the protection).
- Exclude units whose raw duration exceeds `settings.std_max_unit_minutes` (default 120): these are almost always forgotten scan-outs.
- Sample window: `settings.std_lookback_days` (default 365).

**Batching correction (sessions)**
Operators sometimes scan several boards in, work them, then scan several out, which inflates per-unit durations. Correct for it:
1. For each operator, group their units on (Z, operation) into sessions: consecutive units whose intervals are within `settings.session_gap_minutes` (default 10) of each other.
2. Session busy minutes = length of the union of the units' `[start, complete]` intervals, minus overlap with defined breaks.
3. Per-unit minutes for that session = busy minutes / units in session. Every unit in the session is assigned that value.
4. When there is no overlap and no batching, this reduces to the plain start-to-complete duration.

**Aggregation**
- `median_minutes_per_unit` = median across all sampled units (each unit carries its session's per-unit value).
- `computed_std_hr` = 60 / median_minutes_per_unit, rounded to one decimal.

**Minimum sample**
- Require at least `settings.std_min_units` (default 20) units and `settings.std_min_operators` (default 2) distinct operators. Otherwise `computed_std_hr = null` and the fallback applies.

**Fallback**
- If a FactoryLogix StdHr is mapped and non-zero for (Z, operation), use it with `fallback_source = 'fl_std_hr'`.
- Otherwise `fallback_source = 'none'`: hour cells are computed but colored `neutral` (no judgment), and the TV shows StdHr as a dash.

**Scheduling**
- Nightly at `settings.std_recompute_time` (default 02:00 plant time), recompute every (Z, operation) that received new completed units since the last run. Also on demand from admin (single product or all). Write to `standards` and append to `standards_history`.
- A nightly run that fails is tried again after 10 minutes, doubling up to every 2 hours, until a recompute of all products goes through. Until then the sync health (4.6) is `degraded` and its last error says the standards could not be recomputed. `sync_state` (source `standards_recompute`) keeps the last recompute of all products that went through, and how many nightly attempts have failed since.

### 7.2 Effective standard (adjustments and overrides)

Effective StdHr for (Z, operation) is resolved in this order:

1. Base = `computed_std_hr`, else `fl_std_hr`, else null.
2. Apply the single most specific active percentage adjustment: `product_operation` > `operation` > `product` > `global`. Effective = base × (1 + percent/100). Only one adjustment applies; they do not stack.
3. If an active hard override exists, it replaces everything: `product_operation` override > `product` override (applies to all operations of that product).

The portal's product view shows all four values (base, adjustment, override, effective) and their provenance. Changing any of them writes to `audit_log`.

### 7.3 Eligibility (visitor rule)

Problem: operators frequently "scan through" a handful of boards on a job they are not working (boards missed earlier, rework). Counting them as operators would add a mostly empty, red row and skew grouped targets and standards.

Rule, evaluated per (operator, job, operation, hour):

- `work_minutes` = sum over the operator's units on that job/operation of the overlap between `[start_ts, complete_ts or now]` and the hour bucket. (No union here; batching only makes eligibility easier, which is acceptable.)
- **Completed hours:** eligible if `work_minutes >= settings.eligibility_minutes` (default 10).
- **Current hour:** the threshold scales with elapsed time so the rule works from the first minutes: `threshold = max(1, eligibility_minutes × elapsed_minutes_in_hour / 60)`. An operator is also provisionally eligible if they were eligible on the same job/operation in the previous hour (continuing operator). Eligibility in the current hour may flip as evidence accumulates; that is expected.
- Slow operations are safe: a step whose standard is 5 units/hour has about 12 minutes of work time on one board (60 / 5), so it still clears the 10-minute threshold.
- Manager pins (`operator_pins`) force eligibility either way for a job (optionally a specific operation) until removed or expired.

**Consequences of being a visitor:** the operator's units on that job/operation still count toward job totals (Prior, Shift column, Qty Complete, defect counts). They do not create an operator row in separate mode with color (they appear as a gray "visitor" row, see 8.5), do not contribute charged minutes in grouped mode, do not count in the pace numerator, and their units are excluded from standards.

### 7.4 Ownership windows and charged minutes

Pace is judged against wall-clock time the operator owned a job, so idle time counts against them. This is deliberate: measuring only "active" time would hide off-task time.

Build each operator's timeline from their scans across **all** jobs, after removing scans on job/operations where they are a visitor (visitor scans never start or end a window).

For (operator, job, operation, hour):

- **Anchor (window start):**
  - If the operator's carried assignment at the end of the previous hour (`operator_assignment_state`) is this job/operation, the window starts at the top of the hour.
  - Otherwise it starts at the operator's first `start_ts` on this job/operation within the hour.
- **Switch:** the window ends when the operator records a `start_ts` on a different eligible job/operation. That moment begins the other window.
- **Idle timeout:** if the operator has no scan (start or complete) on any job for more than `settings.idle_timeout_minutes` (default 30), the window ends at `last_scan + idle_timeout` and the assignment is cleared. Minutes inside defined breaks do not count toward the idle timeout. If the operator returns later, a new segment starts at that scan. Default should exceed the longest scheduled break.
- **Hour end / now:** the window is clipped to the hour bucket; in the current hour it runs to `now` if still assigned.
- **Multiple segments** on the same job/operation within an hour (A, then B, then back to A) are summed.
- `window_minutes` = total segment length inside the hour.
- `break_minutes` = overlap of the segments with defined breaks. Optional setting `count_work_during_breaks` (default false): when true, break minutes are only subtracted if the operator completed no units during the break.
- `charged_minutes` = window_minutes − break_minutes.

Update `operator_assignment_state` as the timeline is processed so the next hour anchors correctly. The engine must process hours in chronological order for a given operator.

### 7.5 Target, pace, and color

For each eligible (operator, job, operation, hour) cell:

- `units` = number of units with `complete_ts` in the hour, completed by this operator on this job/operation.
- `target_units` = effective StdHr × charged_minutes / 60.
- `pace` = units / target_units (null if target is 0 or StdHr is null).

Color bands (percent of target):

| Condition | Color |
|---|---|
| No scans and no window in this hour | blank (empty cell) |
| StdHr unavailable | neutral (gray text, no fill) |
| Current hour and charged_minutes < `settings.neutral_minutes` (default 5) | neutral |
| pace < 0.70 | red |
| 0.70 ≤ pace < 0.90 | yellow |
| 0.90 ≤ pace ≤ 1.05 | green |
| pace > 1.05 | blue |
| Operator is a visitor on this job/operation | visitor (gray fill, count shown) |

Completed hours use the same formula; charged minutes already reflect partial presence (arrived mid-hour, left mid-hour) and breaks, so the old dashboard's "first hour is always red" problem disappears.

The cell displays the actual `units` count, never a projection.

### 7.6 Grouped-operator mode

When a display is set to group operators by operation, one row per (job, operation):

- `units` = sum of units across all operators, including visitors (it is a production count).
- `charged_minutes` = sum of charged minutes across **eligible** operators only.
- `target_units` = StdHr × charged_minutes / 60.
- pace numerator = units completed by eligible operators only (visitor units are shown in the count but excluded from pace).
- Color bands as in 7.5. Neutral if summed charged minutes < neutral_minutes.

This replaces any "multiply by operator count" logic and remains correct when people arrive or leave mid-hour.

### 7.7 Real-time behavior

- The engine recomputes the current hour and the previous hour after every successful poll. Cells for the current hour are marked `provisional = true`.
- When an hour ends, it is recomputed once more on the next poll and marked final. Late-arriving rows (detected by the overlap re-pull or the hourly late-data pull) trigger recomputation of exactly the hours they touch.
- Effective latency is one poll interval plus processing (target under 2 minutes end to end).
- Cells for the current hour may change row membership, eligibility, and color as the hour progresses. This is correct and expected.

### 7.8 Rolling 12-hour window (TV)

- Columns = the 12 clock hours ending with the current hour: `[now − 11h, now]`, labeled with the local hour (e.g. `10 11 12 13 ... 21`).
- At the top of each hour the leftmost column drops and a new one appears on the right.
- Both the output table and the defect table use the same 12 columns.
- `Prior` = units on this job completed by that operator/operation before the window start.
- `Shift` = sum of the 12 visible cells. (Name retained from the old dashboard. Prior + Shift = the operator's total on the job.)
- `StdDay` = effective StdHr × display.shift_length_hours (default 12). Optional column. **ASSUMPTION:** the old dashboard's StdDay semantics are unclear; this definition was chosen as the most useful.

### 7.9 Defects

- `defect_hour_cells` = count of defects by (job, operation, hour) across all operators combined.
- The TV's bottom table shows Prior (before window), the 12 hourly counts, and ShiftQty (sum of the 12). Any non-zero cell is red-filled; zeros are plain.

### 7.10 Job progress

- `progress = qty_complete / qty_released` (0 if released is 0). Drives the ring gauge. `qty_complete` comes from the work order header when mapped, otherwise the count of distinct units that completed the last operation of the product's route on this job.

### 7.11 Shift roll-ups (portal)

Given a shift instance (a concrete UTC interval from a shift definition and a calendar day) and the set of eligible hour cells inside it:

- Per row (operator/job/operation, or grouped): sum units, sum charged minutes, target = StdHr × charged/60, pace, color (same bands, no neutral rule except when charged < neutral_minutes).
- Roll-up across rows with different standards uses **earned hours**: `earned_hours = units / StdHr` per row; `charged_hours = charged_minutes / 60`.
- `efficiency = Σ earned_hours / Σ charged_hours`. 100% = producing exactly at standard across everything. Colored with the same bands (0.70, 0.90, 1.05).
- Provide roll-ups by job, by operation, by operator, and overall. Rows with a null StdHr are excluded from efficiency and flagged in the UI.
- A job is **active in the shift** if it has at least one unit_step with a start or complete inside the shift interval.

---

## 8. TV Display Application

### 8.1 Access and pairing

- Route: `http://<internal-host>/tv` (any TV browser, full-screen/kiosk).
- On first load the page generates a `device_token` (UUID), stores it in `localStorage` and a long-lived cookie, and registers with the API, which returns a 4-digit `pairing_code`.
- Unclaimed state: full-screen message "This TV is **4821**. Claim it in the admin portal." with the internal admin URL.
- The page polls (or subscribes via SSE) for its assignment. Once claimed and assigned a job, the dashboard renders.
- If the API answers that it does not know the token (the first registration failed, or the display was deleted or re-paired onto another TV), the page registers the same token again and shows the new pairing code.
- Persistence: token survives reboots and normal cache behavior. If storage is cleared, the TV shows a new code; the admin "re-pair" action lets a manager attach the new code to the existing display record (keeping name and settings). The page also accepts `?token=<uuid>` so a bookmark can restore identity.
- Heartbeat: the TV pings every poll so admin shows "last seen".

### 8.2 States

| State | Screen |
|---|---|
| Unclaimed | Pairing code screen |
| Claimed, no job assigned | "No job assigned" with display name and code |
| Assigned | Dashboard |
| Backend unreachable | Last rendered dashboard stays, plus a banner "Dashboard offline since HH:MM" |
| Data delayed (FactoryLogix unreachable) | Dashboard with banner "Data delayed since HH:MM" |
| Job changed in admin | Dashboard swaps to the new job within one poll |

### 8.3 Layout (must match the existing dashboard closely)

The existing dashboard is a dark page with large yellow-green text, white grid lines, and colored hour cells. Reproduce that look. Reference layout (values are illustrative):

```
+---------------------------------------------------------------------------------------------+
| J000000000-0000        Z0000-00        PCBA, EXAMPLE BOARD                0            500  |
|                                                                        Qty Complete  Qty Rel.|
|---------------------------------------------------------------------------------------------|
| Operation           | Operator  | StdHr | Prior | 10 | 11 | 12 | 13 | ... | 21 | Shift | StdDay|
| Selective Solder-Top| JDoe      |  30   |  30   |    |    |    |  3 | ... | 43 |  118  |  360  |
| Selective Solder-Bot| ASmith    |  28   |  41   |    |    |    |  4 | ... | 38 |  128  |  336  |
|                                                                                             |
|                              (empty space for more rows)                                    |
|                                                                                             |
|  (ring gauge)   | Operation            | Prior | 10 | 11 | ... | 21 | ShiftQty |            |
|    0.00%        | Selective Solder-Top |   0   |  0 |  0 | ... |  0 |    0     |            |
|                 | Selective Solder-Bot |   1   |  0 |  0 | ... |  0 |    1     |            |
|                                                                                 9:10:17 PM  |
+---------------------------------------------------------------------------------------------+
```

**Header row:** job number, product number, product name, Qty Complete, Qty Released. No job dropdown (the job is assigned in admin).

**Output table (top):**
- Columns: Operation, Operator (hidden in grouped mode), StdHr, Prior, 12 hour columns, Shift, StdDay (if enabled).
- Removed from the old design: ProjHr (never populated), WIP (never populated).
- Operation names are not truncated: widen the column or wrap to two lines.
- One row per (operation, eligible operator) in separate mode; one row per operation in grouped mode. Visitor rows in separate mode: see 8.5.
- Rows ordered by route sequence, then operator name.
- Hour cell background per 7.5. Text color on filled cells must remain legible (dark text on yellow/green/blue, white on red).

**Defect table (bottom):** Operation, Prior, 12 hour columns, ShiftQty. Combined across operators. Non-zero cells red.

**Ring gauge (bottom left):** job progress percentage (7.10). The old one never updated; ours must. Can be disabled per display.

**Clock (bottom right):** current plant-local time, ticking every second, with a small "updated HH:MM:SS" showing the last data refresh.

**Visual style tokens:** background `#0b0b0b`; primary text `#d7f000` (yellow-green); header labels `#e8e8e8`; grid lines `#ffffff` at 1px; red `#d21f1f`; yellow `#e6c700`; green `#2fa84f`; blue `#3bb0e0`; neutral/visitor `#5a5a5a`. Font: a wide sans-serif at large sizes (readable from 10 m). Exact tokens may be tuned in review; keep the overall feel.

### 8.4 Refresh

- Data refresh follows the poll (default 90 s). The page subscribes to SSE and refetches on "data updated"; fallback polling every 60 s if SSE is unavailable.
- The window rolls at the top of the hour locally even if no data event has arrived.
- No page reloads; update in place to avoid flicker.

### 8.5 Visitor rows (separate mode)

Operators who are visitors on this job in a given hour are shown so their scans are visible, but without judgment: the row is rendered in gray, cells show the count with a gray fill, no StdHr comparison. If an operator is a visitor in every hour of the window, the row is omitted. Grouped mode folds visitor units into the operation row's count (7.6).

### 8.6 Display settings (per display, editable in admin)

- Name
- Assigned job (J-number), selectable from active and recent jobs, with free-text search
- Group operators by operation (bool, default false)
- Show StdDay column (bool, default true) and shift_length_hours (default 12)
- Show ring gauge (bool, default true)

---

## 9. Manager Portal

### 9.1 Access

- Route `/`. Login required. Roles: `viewer` (read), `manager` (read + pins + standards adjustments), `admin` (everything).
- Desktop-first layout. No mobile-specific work required.

### 9.2 Shift view (default landing page)

- The portal auto-selects the shift currently in progress from the plant clock and shift definitions. A shift picker allows any past shift (date + shift name). If no shift is in progress, show the most recent one.
- **Header:** shift name and interval, overall efficiency (7.11) with color, total units completed, total charged hours, number of active jobs, number of eligible operators, and the data-freshness indicator.
- **Active jobs table:** one section per active job: job number, Z-number, product name, Qty Complete / Qty Released, job efficiency. Under it, one row per operation (grouped) with an expander to per-operator rows: StdHr, eligible operators, units, charged minutes, target, pace, color. Visitor units shown as a small annotation.
- **Breakdown tabs:** by job, by operation, by operator, each with earned hours, charged hours, efficiency, sortable.
- **Filters:** job, Z-number, operation, operator. Filters persist in the URL.
- **Refresh:** live via SSE for the current shift; static for past shifts.

### 9.3 Floor overview (live)

- Route `/floor`. One row per eligible operator for the current hour: operator, job, product, operation, units this hour, pace color, units in the last 12 hours, minutes since last scan.
- Operators with no scan in `settings.floor_idle_flag_minutes` (default 15) are flagged.
- Toggle to show visitors (muted rows).
- Filter and sort on any column.

### 9.4 Operator detail

- Route `/operators/:id`. Header with operator name and current assignment.
- The same 12-hour cell strip the TV uses, one strip per job/operation the operator touched, with the same colors.
- Table of every job/operation touched in the selected range: window minutes, charged minutes, units, target, pace, eligible/visitor.
- Date and shift picker to view any past day or shift.
- Link to pin/unpin the operator on a job (manager role).

### 9.5 Job detail

- Route `/jobs/:job`. The TV dashboard rendered in the browser (same component, with a toggle for grouped/separate), plus: defect table, Qty Complete/Released and progress, the list of operators with their totals, and a shift-over-shift history table for this job (units, charged hours, efficiency per shift).
- "Open on TV" shows which displays currently show this job.

### 9.6 Product view (standards)

- Route `/products/:z`. For each operation in the product's route: base computed StdHr, sample size (units, operators, date range), median minutes per unit, FactoryLogix StdHr (if mapped), active percentage adjustment, active override, effective StdHr, and last computed time.
- Manager actions: set/clear a percentage adjustment (product, operation, or product+operation), set/clear a hard override (product or product+operation), recompute now. All actions require a note and are audited.
- Global adjustment and per-operation-type adjustments are edited in admin (10.5).

### 9.7 Exports

- Every table has "Export CSV" (current filtered view). This is the DataMiner replacement for most day-to-day needs.

---

## 10. Admin Area

Route `/admin`. Admin role only unless noted.

### 10.1 Displays

- List: name, pairing code, assigned job, mode, last seen, online/offline.
- Claim: enter a pairing code, give it a name, assign a job, set options.
- Edit/re-pair/delete.

### 10.2 Shifts

- Plant-wide. Fields: name, start (local time), end (local time, may be next day), days of week, effective-from date, optional effective-to.
- Editing creates a new version with a new effective-from; past shifts are always evaluated against the definition in effect on that day. Validation prevents overlapping shifts on the same day.
- Editing the version in effect today starts the new version today unless another date is picked. Without a later effective-from, a version already in effect before today keeps its times and days (its name and dates can still change).
- A break that applies to selected shifts keeps applying to a shift after it is edited: the new version is added to the break's `shift_ids`.

### 10.3 Breaks

- Plant-wide. Fields: name, start (local), duration (minutes), days of week, applies to (all shifts or selected shifts), effective-from/to.
- Example: "Afternoon break", 14:00, 15 minutes, Mon-Fri, all shifts. This removes 15 minutes from the 14:00 hour's charged minutes for every operator whose window overlaps it.

### 10.4 FactoryLogix connection

- Server URL, user name, password (stored encrypted at rest), timestamp mode (5.5), plant time zone.
- The server URL cannot hold a user name or password (`http://user:password@server/...`): they go in their own fields, where the password is stored encrypted. Save and "Test connection" refuse such a URL, and one saved before that is never used.
- The stored password is only ever sent with the server URL and user name it was saved with. Changing either one (even just the path) needs the password typed again: "Test connection" sends no stored password, and Save is refused until the password is entered.
- "Test connection": fetches `$metadata`, reports version/entity sets found.
- Poll interval, page size, overlap, timeouts, breaker settings, backfill settings, "Run backfill now".

### 10.5 Standards (global)

- Global percentage adjustment; per-operation-type adjustments (e.g. all "Selective Solder - Top" +10%).
- Standard computation settings (7.1): lookback days, min units, min operators, max unit minutes, session gap, nightly time.
- "Recompute all standards now".

### 10.6 Engine settings

- Eligibility minutes, neutral minutes, idle timeout, count_work_during_breaks, color band thresholds (advanced; defaults 70/90/105), floor idle flag minutes.

### 10.7 Mapping wizard

- Step 1: pick the entity set for each required dataset (work orders, unit steps, defects, operators, routes, standards) from the live `$metadata` list.
- Step 2: for each target field, pick the source field from a dropdown of that entity set's fields (type-checked: timestamps must be date/time types). Required fields are marked; optional ones may be set to "not available".
- Step 3: pick the watermark field per dataset (or "none", which enables time-window mode).
- Step 4: **Test and preview**: run each mapped query for the last hour with `$top=50`, show the rows in a grid, and show derived checks: distinct operators, distinct jobs, start/complete present, timestamp zone sanity (compare to plant clock), sample durations. Any structural surprise is visible here on install day.
- Save writes `mapping.json` to settings and restarts the collector.

### 10.8 Users

- Create/disable users, set roles, reset passwords. First-run setup creates the initial admin.
- Disabling a user or resetting their password ends every session they have; so does logging out.

### 10.9 Sync health

- Per data source: last success, last error, watermark, rows in last poll, poll duration trend, breaker state, backfill progress. Recent sync_log entries.

### 10.10 First-run setup wizard

On first launch with an empty database: create admin user → plant time zone → FactoryLogix connection test → mapping wizard → shifts → breaks → start backfill (schedule or now). The app is usable for live data immediately; standards populate after backfill and the first nightly run (or a manual recompute).

---

## 11. Settings and Defaults

| Key | Default | Notes |
|---|---|---|
| `plant_timezone` | (required) | IANA name |
| `fl_timestamp_mode` | `offset_present` | see 5.5 |
| `poll_interval_seconds` | 90 | 60 to 180 recommended |
| `poll_page_size` | 500 | |
| `poll_overlap_minutes` | 10 | |
| `late_data_hours` | 24 | hourly re-pull depth |
| `odata_timeout_seconds` | 20 | |
| `breaker_failure_threshold` | 3 | |
| `breaker_max_backoff_minutes` | 10 | |
| `backfill_days` | 180 | |
| `backfill_pause_seconds` | 5 | |
| `backfill_window` | 22:00 to 05:00 | plant time |
| `eligibility_minutes` | 10 | 7.3 |
| `neutral_minutes` | 5 | 7.5 |
| `idle_timeout_minutes` | 30 | 7.4; should exceed longest break |
| `count_work_during_breaks` | false | 7.4 |
| `color_red_below` | 0.70 | |
| `color_yellow_below` | 0.90 | |
| `color_blue_above` | 1.05 | |
| `std_lookback_days` | 365 | 7.1 |
| `std_min_units` | 20 | |
| `std_min_operators` | 2 | |
| `std_max_unit_minutes` | 120 | |
| `session_gap_minutes` | 10 | |
| `std_recompute_time` | 02:00 | plant time |
| `floor_idle_flag_minutes` | 15 | 9.3 |
| `retention_days_raw_events` | null | keep forever |

---

## 12. Demo Build (GitHub Pages)

### 12.1 Purpose

A public, static demo so decision makers can see the TV dashboard and the portal before deciding to install. It must contain no real customer data, names, products, jobs, or process configuration.

### 12.2 Architecture

- The web app is built once with a `DataSource` interface:
  - `ApiDataSource` (production): calls the REST API and subscribes to SSE.
  - `MockDataSource` (demo): runs an in-browser simulator and the shared engine; no network.
- Build flag `VITE_DATA_SOURCE=mock` produces the demo bundle. A GitHub Actions workflow builds on push to `main` and deploys `apps/web/dist` to GitHub Pages (base path configured for the repo name).
- A persistent badge "DEMO: simulated data" is shown on every page in mock mode.
- Admin screens in the demo operate on in-memory state (changes reset on reload) so visitors can click through claiming a display, editing shifts, breaks, and standards.

### 12.3 Simulated world

- Company: a fictional contract electronics manufacturer (e.g. "Northbridge Circuit Assembly").
- Products (Z-style numbers in a different format from the customer's): `PB-2200 Controller Board`, `IO-410 Interface Board`, `PS-900 Power Module`.
- Work orders in a different format from the customer's: `WO-26-00187`, `WO-26-00190`, etc., each with a released quantity (200 to 800).
- Route (subset per product): SMT Placement, Reflow, AOI, Selective Solder - Top, Selective Solder - Bottom, ICT, Functional Test, Conformal Coat, Final Inspection, Pack.
- Operators: 14 invented names (e.g. `JRivera`, `MChen`, `TOkafor`, `LNguyen`, ...). Never use names from the customer's dashboard.
- Shifts: Day 07:00-19:00, Night 19:00-07:00. Breaks: 09:30 (15 min), 12:00 (30 min), 14:00 (15 min), 17:30 (15 min), and night equivalents.
- Standards: the simulator seeds 30 days of history with per-operator speed factors so computed standards exist and differ by operation (e.g. Selective Solder ~30/hr, Functional Test ~12/hr, Pack ~60/hr).

### 12.4 Live simulation scenarios

The simulator advances in real time (with a hidden speed control for reviewers) and deliberately produces:
- One operator steadily above standard (blue), one at standard (green), one in the yellow band, one well below (red).
- A "visitor" who scans 6 rework boards on a job in two minutes and returns to their own job (gray row in separate mode; folded in grouped mode; no red).
- An operator who works Job A for the first half of the hour and Job B for the second half (both rows correct, each judged on its own window).
- A scheduled break at 14:00 reducing that hour's target.
- Defects trickling in at 1 to 3 per hour on two operations.
- A display whose job changes at a scripted moment.
- Two displays: one in separate mode, one grouped, showing the same job.

### 12.5 Demo pages

- `/tv?demo=1` shows a pairing screen and then a claimed dashboard; `/tv?demo=2` shows the grouped variant.
- `/` portal shift view with the seeded shift in progress; `/floor`; operator and job drill-downs; `/products/PB-2200`; `/admin` (in-memory).

---

## 13. Repository, Delivery, and Deployment

### 13.1 Repository layout

```
/
  README.md                     overview, screenshots, quick start, links to docs/
  docs/
    SPEC.md                     this document
    INSTALL.md                  step-by-step on-prem install
    MAPPING.md                  how to map FactoryLogix data sources, with examples
    OPERATIONS.md               backups, upgrades, logs, troubleshooting
    CALCULATIONS.md             plain-language explanation of standards, eligibility, pace, colors
  docker-compose.yml
  .env.example
  packages/
    engine/                     pure TS calculation engine + unit tests
    shared/                     types, zod schemas, constants
  apps/
    collector/                  OData polling, ingestion, backfill, standards scheduler
    api/                        Fastify REST + SSE, auth, admin endpoints
    web/                        React app: /tv, /, /admin; DataSource abstraction; mock simulator
  db/
    migrations/                 SQL migrations (node-pg-migrate or equivalent)
  .github/workflows/
    ci.yml                      install, build the shared packages, typecheck, lint, every test suite, build the demo
    pages.yml                   build mock and deploy to GitHub Pages
```

### 13.2 README requirements

- What it is, what it is not (read-only, standalone, no impact on FactoryLogix).
- Screenshots of TV and portal (from the demo).
- Link to the live demo.
- Requirements: a server or VM on the plant LAN (4 vCPU, 8 GB RAM, 100 GB disk recommended), Docker and Docker Compose, network access to the FactoryLogix server on port 6065, a read-only FactoryLogix user, FactoryLogix 2019.1+ with Report Scheduler Service running.
- Quick start: clone, copy `.env.example` to `.env`, `docker compose up -d`, open `http://<host>:8080`, complete the first-run wizard.
- TV setup: open `http://<host>:8080/tv` on the TV's browser in kiosk mode, claim the code in admin.
- Pointers to INSTALL, MAPPING, OPERATIONS, CALCULATIONS.

### 13.3 Deployment

- Docker Compose services: `db` (postgres + timescaledb, named volume), `collector`, `api`, `web` (nginx serving the built frontend and reverse-proxying `/api` and `/events` to `api`). Single published port (default 8080). Optional TLS via the customer's reverse proxy.
- Windows note: if the customer's servers are Windows-only, the recommended host is a small Linux VM (Ubuntu LTS) on their hypervisor. Docker Desktop on Windows Server is possible but not recommended for an always-on service.
- Configuration via `.env` (DB password, session secret, plant time zone) and the admin UI for everything else.
- Backups: `docs/OPERATIONS.md` documents `pg_dump` on a schedule and volume backup. Upgrades: `git pull && docker compose pull && docker compose up -d`; migrations run automatically on API start.
- Health endpoints: `/api/health` (app), `/api/health/sync` (collector state).

---

## 14. Non-Functional Requirements

- **Performance:** TV page renders within 1 s of data arrival; portal shift view loads in under 2 s for a 12-hour shift with 200 operators; hour cell recompute for two hours completes in under 5 s; a single OData poll completes in under 30 s under normal conditions.
- **Load on FactoryLogix:** sequential, paged, `$select`-limited queries; no query without a time filter after backfill; total daily OData transfer well under 100 MB.
- **Reliability:** all services restart automatically; collector is idempotent and resumable; no data loss on restart.
- **Security:** portal and admin behind login; passwords hashed (argon2id); FactoryLogix password encrypted at rest with a key from `.env`; TV route unauthenticated by design (internal network, production counts only) with an optional display token check; no outbound internet access required at runtime.
- **Observability:** structured JSON logs; sync health in admin; audit log for all configuration and standards changes.
- **Testing:** the engine package has unit tests for every rule in section 7, including DST transitions, eligibility scaling in the current hour, batching correction, window switching, idle timeout, break subtraction, grouped targets, and earned-hours roll-ups. The mock simulator doubles as an integration fixture.
- **Accessibility of the TV page:** high contrast, no reliance on color alone for critical states (the cell number is always shown; visitor rows carry a small "V" marker).

---

## 15. Acceptance Scenarios

Each scenario is encoded as a test and is demonstrable in the demo. Scenarios 1 to 13 are engine tests (`packages/engine/test/acceptance.test.ts`); scenarios 14 and 15 are web tests that play the TV against the mock data source (`apps/web/src/pages/tv/scenarios.test.ts`).

1. **Partial first hour.** Operator starts at 15:20, completes 4 units by 16:00 with StdHr 30. Charged minutes = 40, target = 20, pace = 0.20, red. Same operator with 18 units: pace 0.90, green.
2. **Current hour prorating.** At 09:10, continuing operator has 5 units, StdHr 30, no breaks. Charged = 10, target = 5, pace = 1.00, green. At 09:03 with 0 units: charged 3 < 5, neutral.
3. **Visitor rework.** Operator on Job A scans 8 rework boards on Job B between 10:40 and 10:42 (start≈complete). Job B work_minutes ≈ 2 < threshold → visitor. Job B units total includes 8; Job B has no operator row for them (separate mode: gray row); Job A's window is unbroken through 10:40-10:42.
4. **Split hour.** Operator works Job A 09:00-09:40, then Job B 09:40-10:00. Job A charged 40, Job B charged 20, both eligible, each judged on its own window.
5. **Break subtraction.** Break 14:00-14:15. Operator continuing through the 14:00 hour with 22 units, StdHr 30: charged 45, target 22.5, pace 0.98, green.
6. **Idle timeout.** Operator's last scan 11:10, no scans after. Window ends 11:40 (idle_timeout 30). Hour 12 shows no row for that operator.
7. **Batching correction.** Operator scans 10 boards in at 08:00 and all 10 out at 08:50. Session busy = 50 min, per-unit = 5 min; standard reflects 12/hr, not 1.2/hr.
8. **Grouped mode.** Two eligible operators, charged 60 and 30 minutes, 50 units combined, StdHr 30: target 45, pace 1.11, blue. A visitor's 3 units are shown in the count (53) but excluded from pace.
9. **Rolling window.** At 21:59 columns are 10..21; at 22:00 columns are 11..22; Prior increases by the units that fell out of the window.
10. **DST fall-back.** Two cells with hour_start_utc one hour apart both labeled "01"; no double counting; rolling window still 12 consecutive hours.
11. **Standards fallback.** New product with 12 sampled units (< 20): computed null; if FL StdHr mapped use it; otherwise cells neutral and StdHr shows a dash.
12. **Override precedence.** Base 30, global +10% → 33; operation +20% → 36 (most specific wins, no stacking); hard override 40 → 40.
13. **Shift efficiency.** Rows: (60 units, StdHr 30, 60 min) and (10 units, StdHr 12, 60 min). Earned = 2.0 + 0.833 = 2.833 h; charged = 2.0 h; efficiency 1.42, blue.
14. **Data delayed.** Collector fails 3 polls; TV shows the delayed banner with the last success time; dashboard content remains; banner clears after the next success.
15. **Pairing.** New TV shows a 4-digit code; admin claims it, names it, assigns a job; TV renders within one poll; reboot preserves identity.

---

## 16. Open Items, Assumptions, and Future Work

### Must verify at install (do not block the build)
- FactoryLogix version and OData availability (`$metadata` test).
- Exact data source and field names; presence of start and complete timestamps as separate fields; rework flag; last-modified watermark fields; operator list; route data; FL StdHr field.
- Timestamp zone mode.
- Whether Qty Complete is provided or must be derived.

### Assumptions made in this spec
- StdDay = StdHr × configured shift length (default 12), optional column.
- ProjHr and WIP are dropped.
- The ring gauge is kept and made functional as job progress.
- Shifts and breaks are plant-wide (confirmed by product owner).
- Longest shift is 12 hours; TV uses a rolling 12-hour window regardless of shift.
- Percentage adjustments do not stack; most specific wins.
- Visitor units count toward totals but not toward pace or standards.

### Future work (not in v1)
- IPC-CFX subscription for sub-minute updates.
- File-drop source implementation (xStream export) as a real fallback.
- Additional tools on the historical database: yield and DPMO trends, operator learning curves, job cost/time estimates from standards, alerts (email/Teams) on pace or defect thresholds.
- Optional TV authentication token.
- Scheduled PDF/CSV reports from the portal.
