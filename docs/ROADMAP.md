# Known issues and roadmap

Open items that are known and deliberately not done yet. Each one is a candidate GitHub issue;
they live here until they are opened there.

## 1. Make the hourly 24-hour re-pull conditional or nightly

Once per hour the collector re-pulls the last `late_data_hours` (default 24) of `unit_steps`
and `defects` (`latePullIfDue` in `apps/collector/src/sync/poller.ts`). It runs for both
data sources whatever kind of watermark they have, including a reliable last-modified field
that already catches late updates. By estimate it is about 75% of the collector's
FactoryLogix traffic.

- Measure on site first: rows and duration per re-pull (`unit_steps:late` and `defects:late`
  in the Sync log) against the regular polls.
- Then skip it for data sources whose watermark is a last-modified timestamp, or run it once a
  night instead of hourly, or both.

## 2. Keyset paging for large time windows

Window pulls (backfill days, the late-data re-pull) page with `$top` / `$skip`. On a large
window `$skip` gets slower page by page on the server, and rows inserted mid-pull can shift
pages. Page on the ordered timestamp instead (`$filter=ts gt <last seen>`, with a tie-breaker
on the natural key), or follow `@odata.nextLink` when the service offers it.

## 3. Decide which extra fields `raw_events` keeps

`raw_events` is meant to preserve every field FactoryLogix sent, but the collector requests
only the mapped columns (`$select`), so unmapped fields never arrive. Decide which extra fields
are worth keeping (and the extra transfer), and add them to `$select`, for example as an
"also keep" list in the mapping.

## 4. Shift efficiency when some rows lack a standard

Shift efficiency shows a dash as soon as any row in the shift has no standard (StdHr). Consider
computing it over the rows that have one and showing the excluded share next to it (e.g.
"1.08, 12% of hours without a standard").

## 5. TV device-token check and a Secure session cookie

- Optional TV device-token check: TV endpoints are unauthenticated by design and identify a
  TV by its token. Offer an optional allow-list or signed token for plants that want one.
- Mark the session cookie `Secure` when the app runs behind HTTPS (for example when
  `x-forwarded-proto` is `https`, or with an explicit setting).
