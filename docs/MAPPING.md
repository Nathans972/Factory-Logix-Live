# Mapping FactoryLogix data sources

The collector never hard-codes FactoryLogix field names. Instead, an administrator maps this
application's six datasets to FactoryLogix OData entity sets and fields, once, in **Admin >
Mapping**. This document explains what you are looking at and how to fill it in correctly.

## OData entity sets and `$metadata`

FactoryLogix exposes its DataMiner data sources as **OData entity sets** — HTTP/JSON
collections you can query with `$filter`, `$select`, `$orderby`, `$top`, and `$skip`. The
service is self-describing: `http://<factorylogix-server>:6065/odata/$metadata` returns an
EDMX (XML) document listing every entity set and, for each one, every field and its type
(string, number, date/time, boolean).

Open `$metadata` in a browser (it will prompt for the FactoryLogix user and password) before
you start mapping, so you know the real entity set and field names for your installation —
the names shown in this document and in `docs/SPEC.md` are illustrative placeholders, not
real FactoryLogix field names. The mapping wizard in Admin > Mapping also fetches and displays
this same metadata live, so you do not need to read the raw XML by hand.

## The six datasets

Two datasets are **required** — the collector will not run without them. The other four are
optional; leaving them unmapped degrades specific features gracefully rather than failing.

### `work_orders` — Work orders (jobs) — required

One row per job: J-number, product, quantities, status.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `job_number` | yes | string | Job / work order number (J-number) |
| `product_number` | yes | string | Product number (Z-number) |
| `product_name` | no | string | Product description |
| `qty_released` | yes | number | Quantity released |
| `qty_complete` | no | number | Quantity complete (derived if not available) |
| `status` | no | string | Job status |
| `created_at` | no | timestamp | Created / released date |
| `modified_at` | no | timestamp | Last modified timestamp |

### `unit_steps` — Unit process events — required

One row per unit per operation, with start and complete timestamps. This is the dataset
everything else is computed from.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `unit_id` | yes | string | Unit serial / ID |
| `job_number` | yes | string | Job number |
| `product_number` | no | string | Product number (derived from the work order if not available) |
| `operation` | yes | string | Operation / step name |
| `operation_seq` | no | number | Operation sequence number in the route |
| `operator` | yes | string | Operator user name |
| `start_ts` | yes | timestamp | Start scan timestamp |
| `complete_ts` | yes | timestamp | Complete scan timestamp |
| `result` | no | string | Pass / fail result |
| `rework_flag` | no | boolean | Rework / re-process flag |
| `modified_at` | no | timestamp | Last modified timestamp |

### `defects` — Defects — optional

One row per defect record.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `unit_id` | yes | string | Unit serial / ID |
| `job_number` | yes | string | Job number |
| `operation` | yes | string | Operation where found |
| `operator` | no | string | Operator who logged it |
| `defect_code` | no | string | Defect code |
| `description` | no | string | Defect description |
| `found_ts` | yes | timestamp | Timestamp found |
| `status` | no | string | Defect status |
| `modified_at` | no | timestamp | Last modified timestamp |

### `operators` — Operators — optional

User IDs and display names. Derived from `unit_steps`/`defects` events when not mapped.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `operator_id` | yes | string | User name / ID |
| `display_name` | no | string | Display name |

### `routes` — Product routes — optional

Ordered operations per product. Derived from events (distinct operations per product number,
ordered by sequence number or first-seen order) when not mapped.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `product_number` | yes | string | Product number |
| `operation` | yes | string | Operation name |
| `sequence` | yes | number | Sequence in route |

### `standards` — FactoryLogix standard hours — optional

Standard units per hour per product/operation, used only as a fallback when there is not
enough history to compute a standard ourselves.

| Field | Required | Type | Meaning |
|---|---|---|---|
| `product_number` | yes | string | Product number |
| `operation` | yes | string | Operation name |
| `std_hr` | yes | number | Standard units per hour |

A target field may always be left mapped to **"not available"** even inside a required
dataset, as long as it is not itself marked required in the table above (`work_orders.status`,
for example). What happens for each optional field is covered in
["Graceful degradation"](#graceful-degradation-when-a-field-is-not-available) below.

## Watermark vs. time-window mode

Each dataset is polled incrementally so FactoryLogix is never asked to hand over its whole
history on every poll (spec 4.5):

- **Watermark mode** (preferred): you pick a `watermark_field` — a timestamp or
  monotonically-increasing ID field, e.g. `ModifiedDate`. Each poll asks FactoryLogix for rows
  with `watermark_field >= last_watermark - overlap`, in ascending order. After a successful
  pull the watermark advances to the maximum value seen. Timestamps after the time of the poll
  don't count, so one row stamped in the future (a station clock that is wrong, a 9999-12-31
  placeholder) is still ingested but can't make later polls skip new rows. The overlap
  (`poll_overlap_minutes`, default 10) re-fetches a few extra minutes each time so nothing is
  lost to clock skew; upserts by natural key make the re-fetched rows harmless.
- **Time-window mode**: choose "none" for the watermark field in step 3 of the wizard. The
  collector instead filters on that dataset's primary timestamp (`complete_ts`/`start_ts` for
  unit steps, `found_ts` for defects, `modified_at`/`created_at` for work orders) using the
  same overlap. Use this when the entity set has no reliable last-modified field.
- Small dimension datasets with **no timestamp at all** (`operators`, `routes`, `standards`,
  and `work_orders` if nothing else is available) are pulled in full, at most 20 pages per poll
  (10,000 rows at the default page size). A longer list is read over several polls: each poll
  goes on where the last one stopped and starts over at the top once it has reached the end
  (after a collector restart, the pass starts again from the top). The backfill pulls such a
  `work_orders` whole in one go.
- `unit_steps` and `defects` **must** have either a watermark field or a primary timestamp
  field mapped; the collector refuses to run an unbounded pull against a high-volume table.

Regardless of mode, once per hour the collector also re-pulls the last `late_data_hours`
(default 24) of `unit_steps` and `defects` to catch rows FactoryLogix updated after the fact
(a defect closed later, a unit marked reworked after the initial scan). A failed re-pull is
recorded under source `late_data` in Admin > Sync and retried after an hour, then after 2 and
4 hours, at most every 6 hours, until one succeeds; the regular polls are not affected.

## Natural keys

Every dataset has a **natural key**: a list of *source* field names whose combined values
uniquely identify a row (spec 6.1). The collector upserts by natural key, so re-polling the
same row (because of the overlap window, or a late-data re-pull) updates it in place instead of
duplicating it. Typical keys:

- `work_orders`: the job number alone, e.g. `["WorkOrderNumber"]`.
- `unit_steps`: usually unit + job + operation + start time, e.g.
  `["UnitSerial", "WorkOrderNumber", "OperationName", "StartedDate"]` — a unit can appear more
  than once on the same job/operation (rework), so the start timestamp disambiguates repeats.
- `defects`: a defect ID if FactoryLogix has one, e.g. `["DefectId"]`.

Pick fields that are always present and that do not change between the initial scan and a
later update to the same row.

The natural key also de-duplicates the raw payload archive: `raw_events` gets a new row for a
key only when the payload FactoryLogix sent differs from the last one stored for that key, so
re-reading unchanged rows costs no disk.

A row that arrives without one of its required target fields (or whose product or operation
cannot be resolved) is skipped rather than stored half-filled. Admin > Sync shows the skipped
count per pull; if it stays above zero, check the mapping of the required fields.

## Timestamp modes

FactoryLogix may return timestamps in different shapes depending on version and configuration.
Set `fl_timestamp_mode` in Admin > Connection to match what you see in the metadata types and
sample rows during the Test & preview step:

| Mode | Meaning |
|---|---|
| `offset_present` (default) | ISO 8601 strings include a UTC offset or `Z` (e.g. `2025-06-01T14:30:00-04:00`) and are parsed directly. If a string with no offset shows up, it is interpreted as UTC and a one-time warning is logged. |
| `utc` | Timestamps have no offset, and the naive value should be read as UTC. |
| `local_no_offset` | Timestamps have no offset, and the naive value should be read as **plant-local** time. |

**What `local_no_offset` changes, in both directions:**

- **Reading.** Naive strings (`2025-06-01T14:30:00`) and offset-less JSON dates
  (`/Date(1748788200000)/`, the OData v2 form of `Edm.DateTime`, whose number is the wall-clock
  time counted as if it were UTC) are read as plant-local wall-clock time. A value with an
  explicit offset (`...-04:00`, `/Date(1748788200000+0300)/`) is still taken as the instant it
  names.
- **Writing.** Time filters the collector sends (`$filter=... ge datetime'...'`) use the same
  form FactoryLogix returns: on an OData v2/v3 service, an `Edm.DateTime` (or untyped) field is
  compared against plant-local wall-clock time, e.g. `datetime'2025-06-01T10:30:00'` for
  14:30 UTC in New York in summer.
- **Not changed:** OData v4 literals and `Edm.DateTimeOffset` fields always carry an offset, so
  they stay in UTC (`2025-06-01T14:30:00Z`) and mean the same instant whatever the mode.
  If a v4 FactoryLogix service ever returns offset-less values for a `DateTimeOffset` field,
  check on install day whether its filters behave as UTC before relying on this mode.

The `utc` and `offset_present` modes read and write exactly as before.

**The fall-back-night rule (`local_no_offset` only):** on the one night per year clocks fall
back, one local hour occurs twice and a naive timestamp in that hour is ambiguous. The
collector resolves it by watching the order rows arrive in: if a row's naive timestamp is more
than 30 minutes earlier than the previous row from the same source, the clock has gone back, and
that row and the source's following rows in that hour are treated as the *second* occurrence. A
row the collector reads again (the poll overlap and the late-data re-pull re-read recent rows)
keeps the time it was given the first time. In the normal case (no fall-back in progress) it
resolves to the first (earlier) occurrence. This only matters for one night a year and does not
require any action from you.

**Verify which mode applies** by checking the EDM type of the timestamp fields in `$metadata`
(`Edm.DateTimeOffset` fields normally carry an offset; `Edm.DateTime` usually does not) and by
looking at sample values in the Test & preview grid.

## Worked example

This is the mapping shipped as `EXAMPLE_MAPPING` in `packages/shared/src/mapping.ts`. **The
entity set and field names are illustrative placeholders** — replace every source name with
what your `$metadata` actually shows.

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
      "status": "Status",
      "created_at": "CreatedDate",
      "modified_at": "ModifiedDate"
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
      "rework_flag": null,
      "modified_at": null
    }
  },
  "defects": {
    "entity_set": "Defects",
    "watermark_field": "ModifiedDate",
    "key": ["DefectId"],
    "fields": {
      "unit_id": "UnitSerial",
      "job_number": "WorkOrderNumber",
      "operation": "OperationName",
      "operator": "OperatorName",
      "defect_code": "DefectCode",
      "description": "DefectDescription",
      "found_ts": "FoundDate",
      "status": "Status",
      "modified_at": "ModifiedDate"
    }
  },
  "operators": null,
  "routes": null,
  "standards": null
}
```

In this example, `unit_steps.rework_flag` and `unit_steps.modified_at` are mapped to `null`
("not available"), and the `operators`, `routes`, and `standards` datasets are not mapped at
all. See the next section for what that means in practice.

## Test & preview

Step 4 of the mapping wizard runs the mapped query for the last hour (`$top=50`, ordered by
the watermark or primary timestamp, descending) and shows the raw rows plus derived checks.
What each one means:

- **Distinct operators / distinct jobs** — count of distinct values seen in the sample for the
  `operator` and `job_number` fields. A very low number (especially "1 distinct operator") on a
  busy line usually means the wrong source field was picked.
- **Start / complete present %** (`unit_steps` only) — the share of sampled rows that have a
  non-blank start or complete timestamp.
- **Sample durations (minutes)** — start-to-complete duration for up to 20 sampled units, so you
  can sanity-check they look like real work times (seconds to tens of minutes), not zero or
  wildly large.
- **Timestamp skew** — the newest mapped timestamp in the sample compared to the server's own
  clock, in minutes. A large skew usually means the wrong `fl_timestamp_mode` or the wrong
  plant time zone.

Warnings you may see, and what to do about them:

| Warning | Meaning / what to check |
|---|---|
| `fewer than half of the sampled rows have a complete timestamp` | The `complete_ts` field is mapped to the wrong column, or FactoryLogix records start and complete as separate rows rather than separate columns on one row — re-check the entity set shape in `$metadata`. |
| `the sample contains at most one distinct operator; check the operator field` | The `operator` field is likely mapped to a constant column, an ID that isn't varying, or the wrong field entirely. |
| `<N> row(s) had an unparsable <field> value` | Some sampled values could not be parsed as a timestamp. Confirm the field really is a date/time field and that `fl_timestamp_mode` matches its format. |
| `newest <field> in the sample is <N> minutes from the server clock; check the timestamp mode` | Fires when the skew exceeds 90 minutes. Almost always a `fl_timestamp_mode` mismatch, or the plant time zone is set incorrectly. |
| `the query returned no rows` | The entity set or filter matched nothing in the last hour. Check that the entity set name is correct, that there is recent activity on the floor, and that the watermark/timestamp field you picked actually advances. |
| `[required ]field <target> -> <source> is missing from the returned rows` | The source field name does not appear in the returned rows at all — a structural mismatch. Re-check spelling and case in `$metadata`; if the field lives on a related entity, it may need a navigation path (e.g. `Operator/UserName`). |

## Graceful degradation when a field is not available

Mapping a field to "not available" (or leaving an entire optional dataset unmapped) never stops
the app from running; specific features fall back instead:

- **`qty_complete` not mapped** — derived as the count of distinct units that completed the
  last operation in the product's route on that job.
- **`routes` dataset not mapped** — the route (ordered operation list) for each product is
  derived from `unit_steps`: distinct operations per product, ordered by `operation_seq` when
  present, otherwise by first-seen order.
- **`unit_steps.rework_flag` not mapped** — no rework exclusion is attempted when computing
  standards. The eligibility filter and the median (rather than the mean) still absorb most of
  the effect of rework scan-throughs.
- **`standards` dataset (FactoryLogix StdHr) not mapped, or the computed standard has too
  little history** — with no FactoryLogix StdHr to fall back to, the hour cell is still
  computed but shown with the `neutral` color (no judgment), and the product page shows StdHr as
  a dash instead of a number.
- **`operators` dataset not mapped** — the operator list (ID and display name) is derived from
  the operators seen in `unit_steps`/`defects` events.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Connection test fails with `HTTP 401` or `HTTP 403` | Wrong FactoryLogix user name/password, or the account lacks OData rights | Re-enter credentials in Admin > Connection; confirm the account can open `$metadata` in a browser |
| Connection test fails with "the address answered, but not with OData $metadata (got text/html)" | The URL reaches a web server, but not the OData service: a sign-in page, the IIS default page, a proxy page, or an OData error | Use the OData service root (e.g. `http://<factorylogix-server>:6065/odata`); `<that URL>/$metadata` must show EDMX XML in a browser |
| Connection test or Admin > Sync says `connection refused`, `host not found` or `host name lookup failed` | Wrong host name or port, the OData service is not running, or the dashboard server cannot resolve the name | Check the host and port in the URL (`6065` by default) and that the Report Scheduler Service is running; if the name does not resolve, use the server's IP address |
| Connection test or Admin > Sync says `no answer, a firewall may be dropping the connection` | A firewall between the dashboard server and FactoryLogix drops the traffic instead of refusing it | Allow TCP from the dashboard server to the FactoryLogix server on the OData port |
| Connection test or Admin > Sync says `certificate not trusted` or `TLS handshake failed` | An `https://` URL whose certificate is self-signed, issued by an internal CA or made out to another host name; or `https://` on a port that only speaks plain HTTP | The dashboard only trusts publicly trusted certificates: use the OData service's `http://` URL if it has one (the default is `http://<factorylogix-server>:6065/odata`) |
| Preview or poll returns no rows | Wrong entity set name, or no recent activity in the filtered time range | Check the entity set name against live `$metadata`; widen the preview window by checking activity on the floor in the last hour |
| Timestamp skew warning / hour columns look shifted | `fl_timestamp_mode` does not match how FactoryLogix serializes dates, or `plant_timezone` is wrong | Compare a sample value in the preview grid to the EDM type in `$metadata` (`Edm.DateTimeOffset` vs `Edm.DateTime`); fix the mode and/or the plant time zone in Admin > Connection |
| "field X -> Y is missing from the returned rows" (structural mismatch) | Field name typo, wrong case beyond what the app tolerates, or the field is on a related/nested entity | Re-check the field name in `$metadata`; if it is a navigation property, map it with a `/`-separated path, e.g. `Operator/UserName` |
| Everything works but StdHr is always a dash | Not enough history yet, or `standards` isn't mapped | Wait for backfill and the nightly recompute (or run Admin > Standards > Recompute now); map the `standards` dataset if you want a FactoryLogix fallback in the meantime |
