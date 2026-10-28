# REST API contract

All endpoints are served by `apps/api` under `/api`. Responses are JSON. Timestamps are UTC epoch
milliseconds. DTO names refer to types exported from `@fld/shared` (`packages/shared/src/api-types.ts`
and `engine-types.ts`). The web app's `DataSource` interface (`apps/web/src/data/DataSource.ts`) mirrors
this contract one-to-one so the GitHub Pages demo (mock) and the real backend are interchangeable.

Auth: session cookie (`fld_session`, httpOnly, signed JWT). Roles: `viewer` < `manager` < `admin`.
Unauthenticated requests to protected routes return `401 {error:'unauthorized'}`; insufficient role returns `403`.
Validation errors return `400 {error:'bad_request', message, issues?}`.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/health` | none | | `AppHealth` |
| GET | `/api/health/sync` | none | | `SyncHealth` |
| GET | `/api/events` | none | SSE stream | `SseEvent` per message (event name = `type`) |
| GET | `/api/setup/status` | none | | `SetupStatus` |
| POST | `/api/setup/admin` | none (only while no users exist) | `SetupAdminRequest` | `AuthMe` (logs in) |
| POST | `/api/auth/login` | none | `LoginRequest` | `AuthMe` |
| POST | `/api/auth/logout` | any | | `OkResponse` |
| GET | `/api/auth/me` | none | | `AuthMe` (`user:null` when not logged in) |
| POST | `/api/tv/register` | none | `TvRegisterRequest` | `TvState` (creates display row w/ pairing code if new: at most 10 new a minute per client address, then `429`; first deletes unclaimed displays not seen for a day, and all but the 1,000 most recently seen) |
| GET | `/api/tv/:token/state` | none | | `TvState` (also records heartbeat `last_seen_at`) |
| GET | `/api/portal/shifts` | viewer | | `ShiftPickerResponse` |
| GET | `/api/portal/shifts/instances?from=&to=` | viewer | UTC ms range | `ShiftInstanceListItem[]` |
| GET | `/api/portal/shift-view?date=&shift_id=&job=&product=&operation=&operator=` | viewer | omit date/shift_id for current-or-most-recent | `ShiftView` |
| GET | `/api/portal/floor?show_visitors=` | viewer | | `FloorView` |
| GET | `/api/portal/operators?q=` | viewer | | `OperatorListItem[]` |
| GET | `/api/portal/operators/:id?from=&to=` or `?date=&shift_id=` | viewer | default: last 12 hours | `OperatorDetail` |
| GET | `/api/portal/jobs?q=&active=` | viewer | | `JobListResponse` (active = activity in last 7 days, sorted by last activity) |
| GET | `/api/portal/jobs/:job` | viewer | | `JobDetail` |
| GET | `/api/portal/dashboard/:job?grouped=&shift_length_hours=&show_std_day=` | viewer | | `TvDashboard` |
| GET | `/api/portal/products?q=` | viewer | | `ProductListItem[]` |
| GET | `/api/portal/products/:z` | viewer | | `ProductView` |
| POST | `/api/portal/products/:z/adjustments` | manager | `CreateAdjustmentRequest` (scope product or product_operation) | `StandardAdjustment` |
| DELETE | `/api/portal/adjustments/:id` | manager | | `OkResponse` |
| POST | `/api/portal/products/:z/overrides` | manager | `CreateOverrideRequest` | `StandardOverride` |
| DELETE | `/api/portal/overrides/:id` | manager | | `OkResponse` (sets active=false) |
| POST | `/api/portal/products/:z/recompute` | manager | | `OkResponse` (async; notifies collector) |
| GET | `/api/portal/pins?operator_id=&job_number=` | viewer | | `PinListResponse` |
| POST | `/api/portal/pins` | manager | `CreatePinRequest` | `Pin` |
| DELETE | `/api/portal/pins/:id` | manager | | `OkResponse` |
| GET | `/api/displays` | manager | | `Display[]` (same shape as the admin list; the manager TV displays page) |
| PUT | `/api/displays/:id/job` | manager | `SetDisplayJobRequest` (`{ job_number: string \| null }`) | `Display` (changes only the job; audit `display.job_changed`; emits `display_updated` so the TV switches at once) |
| GET | `/api/admin/displays` | admin | | `Display[]` |
| POST | `/api/admin/displays/claim` | admin | `ClaimDisplayRequest` | `Display` |
| PATCH | `/api/admin/displays/:id` | admin | `UpdateDisplayRequest` | `Display` |
| POST | `/api/admin/displays/:id/repair` | admin | `RepairDisplayRequest` | `Display` (moves the new token onto this record, deletes the temp row) |
| DELETE | `/api/admin/displays/:id` | admin | | `OkResponse` |
| GET | `/api/admin/shifts` | viewer | | `ShiftDef[]` |
| POST | `/api/admin/shifts` | admin | `ShiftWrite` | `ShiftDef` |
| PUT | `/api/admin/shifts/:id` | admin | `ShiftWrite` | `ShiftDef` (versioning: closes old with effective_to = new.effective_from - 1 day, inserts new) |
| DELETE | `/api/admin/shifts/:id` | admin | | `OkResponse` |
| GET | `/api/admin/breaks` | viewer | | `BreakDef[]` |
| POST | `/api/admin/breaks` | admin | `BreakWrite` | `BreakDef` |
| PUT | `/api/admin/breaks/:id` | admin | `BreakWrite` | `BreakDef` |
| DELETE | `/api/admin/breaks/:id` | admin | | `OkResponse` |
| GET | `/api/admin/settings` | viewer | | `SettingsResponse` |
| PATCH | `/api/admin/settings` | admin | `SettingsPatch` | `SettingsResponse` |
| GET | `/api/admin/connection` | admin | | `ConnectionResponse` (never includes password) |
| PUT | `/api/admin/connection` | admin | `FlConnection` (password optional = keep, only while `base_url` stays on the saved server: same scheme, host and port; 400 otherwise) | `ConnectionResponse` |
| POST | `/api/admin/connection/test` | admin | optional `FlConnection` body to test unsaved values (without a password, the saved one is only sent when `base_url` is on the saved server) | `ConnectionTestResult` |
| GET | `/api/admin/mapping` | admin | | `MappingResponse` |
| PUT | `/api/admin/mapping` | admin | `MappingConfig` | `MappingResponse` (validates; notifies collector to restart) |
| GET | `/api/admin/mapping/metadata` | admin | | `ODataMetadata` (fetches live `$metadata`) |
| POST | `/api/admin/mapping/preview` | admin | `MappingPreviewRequest` | `MappingPreviewResult` |
| GET | `/api/admin/standards` | manager | | `StandardsAdminResponse` |
| POST | `/api/admin/standards/adjustments` | manager | `CreateAdjustmentRequest` (global / operation) | `StandardAdjustment` |
| DELETE | `/api/admin/standards/adjustments/:id` | manager | | `OkResponse` |
| POST | `/api/admin/standards/recompute` | manager | `RecomputeStandardsRequest` | `OkResponse` |
| GET | `/api/admin/users` | admin | | `User[]` |
| POST | `/api/admin/users` | admin | `CreateUserRequest` | `User` |
| PATCH | `/api/admin/users/:id` | admin | `UpdateUserRequest` | `User` |
| GET | `/api/admin/sync` | admin | | `SyncHealth` |
| GET | `/api/admin/sync/log?limit=` | manager | | `SyncLogEntry[]` (managers can open Sync health, so they can read the poll log; includes `ingested` / `skipped` per pull) |
| POST | `/api/admin/backfill/run` | admin | | `OkResponse` (sets requested_now) |
| GET | `/api/admin/audit?limit=&offset=` | admin | | `AuditListResponse` |

## SSE (`/api/events`)

Each message: `event: <type>` + `data: <SseEvent JSON>`. A `heartbeat` is sent every 25 s.
The API emits `data_updated` when the collector `NOTIFY`s on Postgres channel `fld_data_updated`
(payload: JSON `{hours:[...]}`), `display_updated` after any display change, `sync_health` when the
collector's health state changes, and `settings_updated` after settings/mapping/shift/break changes.
The stream needs no login, so `display_updated` carries only `display_id`, never a TV's
`device_token` (the token is the only credential the `/api/tv/*` endpoints check).
A client that stops reading is disconnected once 128 KB is waiting for it, instead of the API
keeping every later message in memory; EventSource reconnects by itself. At most 1,000 streams are
open at once: past that a new stream gets only `retry: 60000` and is closed, so the browser tries
again a minute later (on an error status EventSource would give up for good).

## Collector control (Postgres NOTIFY channel `fld_control`)

Payload JSON: `{cmd:'restart'} | {cmd:'backfill_now'} | {cmd:'recompute_standards', product_number?: string} | {cmd:'recompute_cells', from_utc, to_utc}`.
The API sends these; the collector listens. Commands that must survive a collector restart are
also persisted (`backfill_progress.requested_now`, settings).

## Export CSV

CSV export is done client-side from the rendered table data; no server endpoint.
