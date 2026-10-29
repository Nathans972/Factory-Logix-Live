# REST API contract

All endpoints are served by `apps/api` under `/api`. Responses are JSON. Timestamps are UTC epoch
milliseconds. DTO names refer to types exported from `@fld/shared` (`packages/shared/src/api-types.ts`
and `engine-types.ts`). The web app's `DataSource` interface (`apps/web/src/data/DataSource.ts`) mirrors
this contract one-to-one so the GitHub Pages demo (mock) and the real backend are interchangeable.

Auth: session cookie (`fld_session`, httpOnly, signed JWT). Roles: `viewer` < `manager` < `admin`.
The cookie carries the user's session version and only counts while it matches `users.session_version`:
logging out, an admin password reset and deactivation bump it, which ends every session the user has.
Unauthenticated requests to protected routes return `401 {error:'unauthorized'}`; insufficient role returns `403`.
Validation errors return `400 {error:'bad_request', message, issues?}`. Dates in a request body are
`YYYY-MM-DD` and must be a day on the calendar (`2026-02-29` is a 400).
A database statement still running after 15 s is cancelled, so that it cannot keep one of the API's
10 database connections; its request returns `503 {error:'unavailable', message:'the database took too long to answer'}`.
Migrations at start-up have no such limit.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/health` | none | | `AppHealth` |
| GET | `/api/health/sync` | none | | `SyncHealth` |
| GET | `/api/events` | none | SSE stream | `SseEvent` per message (event name = `type`) |
| GET | `/api/setup/status` | none | | `SetupStatus` |
| POST | `/api/setup/admin` | none (only while no users exist) | `SetupAdminRequest` | `AuthMe` (logs in; `409` once a user exists; at most 10 a minute per client address, then `429`) |
| POST | `/api/auth/login` | none | `LoginRequest` | `AuthMe` |
| POST | `/api/auth/logout` | any | | `OkResponse` (ends every session of the logged-in user, on every device, not only this browser's cookie) |
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
| GET | `/api/portal/jobs/:job` | viewer | | `JobDetail` (a job with activity but no work order yet takes the product of its activity and 0 released; `404` only when it has neither) |
| GET | `/api/portal/dashboard/:job?grouped=&shift_length_hours=&show_std_day=` | viewer | | `TvDashboard` (same fallback for a job without a work order; a TV assigned to it shows this dashboard) |
| GET | `/api/portal/products?q=` | viewer | | `ProductListItem[]` |
| GET | `/api/portal/products/:z` | viewer | | `ProductView` |
| POST | `/api/portal/products/:z/adjustments` | manager | `CreateAdjustmentRequest` (scope product or product_operation) | `StandardAdjustment` (turns off the active one on the same scope; audit `standards.adjustment_replaced`) |
| DELETE | `/api/portal/adjustments/:id` | manager | | `OkResponse` (scope product or product_operation; `400` for global and operation ones, which `DELETE /api/admin/standards/adjustments/:id` removes) |
| POST | `/api/portal/products/:z/overrides` | manager | `CreateOverrideRequest` | `StandardOverride` (turns off the active one on the same scope; audit `standards.override_replaced`) |
| DELETE | `/api/portal/overrides/:id` | manager | | `OkResponse` (sets active=false) |
| POST | `/api/portal/products/:z/recompute` | manager | | `OkResponse` (async; notifies collector) |
| GET | `/api/portal/pins?operator_id=&job_number=` | viewer | | `PinListResponse` (pins in force now) |
| POST | `/api/portal/pins` | manager | `CreatePinRequest` | `Pin` |
| DELETE | `/api/portal/pins/:id` | manager | | `OkResponse` (ends the pin now; the row is kept for the hours it covered, spec 7.3) |
| GET | `/api/displays` | manager | | `Display[]` (same shape as the admin list; the manager TV displays page) |
| PUT | `/api/displays/:id/job` | manager | `SetDisplayJobRequest` (`{ job_number: string \| null }`) | `Display` (changes only the job; audit `display.job_changed`; emits `display_updated` so the TV switches at once) |
| GET | `/api/admin/displays` | admin | | `Display[]` |
| POST | `/api/admin/displays/claim` | admin | `ClaimDisplayRequest` | `Display` |
| PATCH | `/api/admin/displays/:id` | admin | `UpdateDisplayRequest` | `Display` |
| POST | `/api/admin/displays/:id/repair` | admin | `RepairDisplayRequest` | `Display` (moves the new token onto this record, deletes the temp row) |
| DELETE | `/api/admin/displays/:id` | admin | | `OkResponse` |
| GET | `/api/admin/shifts` | viewer | | `ShiftDef[]` |
| POST | `/api/admin/shifts` | admin | `ShiftWrite` | `ShiftDef` |
| PUT | `/api/admin/shifts/:id` | admin | `ShiftWrite` | `ShiftDef` (a later effective_from versions it: closes old with effective_to = new.effective_from - 1 day, unless it already ended earlier, inserts new, and adds the new id to every break whose `shift_ids` holds the old one, in one transaction. Otherwise the row is updated in place, and 400 if that would change the times or days of a version in effect before the plant's today) |
| DELETE | `/api/admin/shifts/:id` | admin | | `OkResponse` |
| GET | `/api/admin/breaks` | viewer | | `BreakDef[]` |
| POST | `/api/admin/breaks` | admin | `BreakWrite` | `BreakDef` |
| PUT | `/api/admin/breaks/:id` | admin | `BreakWrite` | `BreakDef` |
| DELETE | `/api/admin/breaks/:id` | admin | | `OkResponse` |
| GET | `/api/admin/settings` | viewer | | `SettingsResponse` |
| PATCH | `/api/admin/settings` | admin | `SettingsPatch` | `SettingsResponse` |
| GET | `/api/admin/connection` | admin | | `ConnectionResponse` (never includes password; `password_unreadable: true` when this server's `ENCRYPTION_KEY` cannot decrypt the saved one, as after restoring a backup from another install; a password saved inside `base_url` by an earlier version shows as `***`) |
| PUT | `/api/admin/connection` | admin | `FlConnection` (password optional = keep, only while `base_url` and `username` are the saved ones and the saved password can be decrypted; 400 otherwise, and when `base_url` holds a user name or password) | `ConnectionResponse` |
| POST | `/api/admin/connection/test` | admin | optional `FlConnection` body to test unsaved values (without a password, the saved one is only sent when `base_url` and `username` are the saved ones) | `ConnectionTestResult` (`ok: false` asking for the password again when the saved one is needed but cannot be decrypted, or saying to take the user name and password out of a `base_url` that holds them; nothing is sent then) |
| GET | `/api/admin/mapping` | admin | | `MappingResponse` |
| PUT | `/api/admin/mapping` | admin | `MappingConfig` | `MappingResponse` (validates; keeps a `unit_steps` or `defects` natural key it replaces in the `mapping_key_history` setting, see docs/MAPPING.md; notifies collector to restart) |
| GET | `/api/admin/mapping/metadata` | admin | | `ODataMetadata` (fetches live `$metadata`; 400 asking for the password again when the saved one cannot be decrypted, or when the saved `base_url` holds a user name or password) |
| POST | `/api/admin/mapping/preview` | admin | `MappingPreviewRequest` | `MappingPreviewResult` (400 asking for the password again when the saved one cannot be decrypted, or when the saved `base_url` holds a user name or password) |
| GET | `/api/admin/standards` | manager | | `StandardsAdminResponse` |
| POST | `/api/admin/standards/adjustments` | manager | `CreateAdjustmentRequest` (global / operation) | `StandardAdjustment` (turns off the active one on the same scope; audit `standards.adjustment_replaced`) |
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

Hour cells are stored with the settings, shifts and breaks of when they were computed, and on its
own the collector only recomputes the current and previous hour and the hours new rows touch. So
after a change to a shift, a break, or a setting the cells depend on (`HOUR_CELL_SETTINGS_KEYS`:
plant time zone, eligibility, neutral and idle timeout minutes, work during breaks, color bands),
the API sends `restart` and then `recompute_cells` from the start of yesterday, plant time, to now:
the TVs and the shifts of today and yesterday. Earlier days keep the settings they were computed
with. The collector runs it like a standards recompute (no poll meanwhile, heartbeat every 30 s),
and hours it could not recompute are tried again after every poll.

## Export CSV

CSV export is done client-side from the rendered table data; no server endpoint.
