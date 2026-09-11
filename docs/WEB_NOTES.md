# Web app implementation notes

Binding notes for `apps/web` (React 18 + Vite + React Router 6 + TanStack Query 5, plain CSS).
Read with `docs/SPEC.md` sections 8, 9, 10, 12 and `docs/API.md`.

## What already exists (do not restructure)

- `vite.config.ts` (aliases `@fld/shared`, `@fld/engine` → package **source**, `@` → `src`; `/api` dev proxy to `localhost:3001`; `base` from `VITE_BASE_PATH`).
- `src/main.tsx` providers: QueryClient → DataSourceProvider → AuthProvider → BrowserRouter(basename = `import.meta.env.BASE_URL`).
- `src/App.tsx` route map. Page components live at the paths it imports; replace the placeholder files in place, keep the export names.
- `src/data/DataSource.ts` — the interface both backends implement. `src/data/index.ts` picks `MockDataSource` when `VITE_DATA_SOURCE=mock`, else `ApiDataSource('/api')`. `IS_MOCK` is exported.
- `src/data/DataSourceContext.tsx` — `useDataSource()`.
- `src/auth/AuthContext.tsx` — `useAuth()` (`user`, `loading`, `needsSetup`, `login`, `logout`, `refresh`), `hasRole(user, min)`. `src/auth/RequireAuth.tsx` handles redirects to `/setup` and `/login`.
- `src/ui/primitives.tsx` (Button, Panel, PageHeader, Stat, Banner, Spinner, ErrorBox, Empty, ColorChip, PaceChip, Field, Input, Select, Checkbox, DaysPicker, Modal, Tabs), `src/ui/Table.tsx` (`DataTable` — sortable + "Export CSV"), `src/ui/DemoBadge.tsx`.
- `src/lib/format.ts` (time/date/pct/num helpers taking the plant tz), `src/lib/csv.ts`.
- `src/styles/global.css` — portal/admin theme + class names used by the primitives (`.shell`, `.sidebar`, `.main`, `.grid-*`, `.stat`, `.chip-*`, `.cell.c-*`, `.dt-*`, `.modal*`, `.tabs`, `.auth-*`).

## Conventions

- Data fetching: TanStack Query with `useDataSource()`; query keys `['shiftView', params]`, etc. Errors render `<ErrorBox>`; loading renders `<Spinner>`.
- Live refresh: a hook `useLiveRefetch(types: SseEvent['type'][], onEvent)` in `src/lib/useLive.ts` subscribes via `ds.subscribe` and invalidates the given queries. The TV also refetches on a 60 s timer as a fallback and re-renders at the top of each local hour (spec 8.4).
- Plant time zone: read from `AppHealth.plant_timezone` (query `['health']`, refetched every 60 s) and from `TvState.plant_timezone` on the TV. Provide `usePlantTz()` in `src/lib/usePlantTz.ts` (falls back to the browser tz until loaded).
- URL state: filters and pickers persist in the query string (`useSearchParams`).
- Every portal table uses `DataTable` with `exportName` (spec 9.7).
- No heavy UI kits. Plain CSS. The TV page has its own stylesheet `src/pages/tv/tv.css` and must not depend on the portal theme.
- Role gating in UI: manager-only actions (pins, adjustments/overrides, recompute) are hidden for viewers; admin-only pages show a "not allowed" message for managers except `/admin/standards` and `/admin/sync` (readable by managers).

## TV page (spec 8) — `src/pages/tv/`

- `TvPage.tsx`: identity = `localStorage['fld_device_token']` (also a cookie `fld_device_token`, 10 years, path `/`) or `?token=<uuid>`; generate with `crypto.randomUUID()`. On mount `ds.tvRegister(token)`, then poll `ds.tvState(token)` every 60 s AND on SSE `data_updated`/`display_updated`. In mock mode `?demo=1` → separate display, `?demo=2` → grouped display (the mock resolves these tokens to pre-claimed displays; any other token shows the pairing screen first and auto-claims after ~8 s so reviewers see both states).
- States (spec 8.2): unclaimed (big code "This TV is **4821**. Claim it in the admin portal." + admin URL), unassigned ("No job assigned" + display name + code), assigned (dashboard), backend unreachable (keep last dashboard, banner "Dashboard offline since HH:MM" using the time of the first failed fetch), data delayed (banner "Data delayed since HH:MM" from `sync.delayed_since`).
- `TvDashboard.tsx`: a pure presentational component taking `TvDashboard` + `show_gauge` + tz + `updated_at` — reused by the portal job page. Layout per spec 8.3: header row (job, product number, product name, Qty Complete / Qty Rel.), output table (Operation | Operator (hidden when grouped) | StdHr | Prior | 12 hour columns | Shift | StdDay (if show_std_day)), defect table (Operation | Prior | 12 hours | ShiftQty; non-zero cells red), ring gauge bottom-left (SVG, progress %), clock bottom-right (plant-local, ticking each second) with "updated HH:MM:SS".
- Style tokens (`TV_COLORS`, `TV_CELL_TEXT` from `@fld/shared`): background `#0b0b0b`, primary text `#d7f000`, header labels `#e8e8e8`, 1 px white grid lines, cell fills red/yellow/green/blue, neutral/visitor gray `#5a5a5a`. Wide sans-serif at large sizes (e.g. `font-family: 'Arial Black', 'Segoe UI', Arial, sans-serif` with `font-stretch`/letter-spacing; scale with `vw`/`vh` so a 1080p TV fills the screen). Dark text on yellow/green/blue, white on red. Visitor cells carry a small "V" marker (spec 14 accessibility). Operation names wrap to two lines instead of truncating.
- Hour column labels come from `columns[i].label`. Cells: `units` always displayed (empty string for `blank`), never a projection.
- Update in place (React state), no page reloads, no flicker: keep the previous dashboard while refetching.

## Portal (spec 9) — `src/pages/portal/`

- `PortalLayout.tsx`: sidebar (brand, nav: Shift view `/`, Floor `/floor`, Jobs `/jobs`, Operators `/operators`, Products `/products`, Admin `/admin` when manager+), user + logout at the bottom, data-freshness indicator (from `syncHealth`, refreshed on `sync_health` events) in the top bar.
- `ShiftPage.tsx` (default): shift picker (date input + shift select from `shiftPicker()`; default current-or-most-recent), header stats (efficiency w/ color, total units, charged hours, active jobs, eligible operators, freshness), active jobs sections (job header + per-operation rows + expander to per-operator rows; visitor units as small annotation), breakdown tabs (by job / by operation / by operator) using `rollups`, filters (job, product, operation, operator) persisted in URL, live refetch when `in_progress`.
- `FloorPage.tsx`: `floor(showVisitors)`, one row per eligible operator, idle rows flagged (`row-flag`), toggle visitors (muted rows `row-visitor`), sortable/filterable columns, live.
- `OperatorsPage.tsx`: searchable list → `/operators/:id`. `OperatorPage.tsx`: header (name, current assignment), 12-hour cell strips (reuse a `CellStrip` component with the TV colors), range table, date/shift picker (query `date`+`shift_id` or default last 12 h), pin/unpin (manager) via `pins`/`createPin`/`deletePin`.
- `JobsPage.tsx`: searchable job list (active filter) → `/jobs/:job`. `JobPage.tsx`: `TvDashboard` component with grouped/separate toggle, defect table, progress, operators list, shift-over-shift history table, "Open on TV" (displays showing this job).
- `ProductsPage.tsx` → `/products/:z`. `ProductPage.tsx`: one row per route operation showing base computed StdHr, sample size (units, operators, from–to), median minutes/unit, FL StdHr, active adjustment, active override, effective StdHr + provenance, computed_at; manager actions (modal with required note): set/clear adjustment (product / product_operation), set/clear override, "Recompute now".

## Auth pages — `src/pages/auth/`

- `LoginPage.tsx`: username/password, error display, redirect to `?next` or `/`.
- `SetupPage.tsx` (spec 10.10 first-run wizard): steps: create admin → plant time zone (settings) → FactoryLogix connection (+ test) → mapping wizard (embed the same component as admin) → shifts → breaks → backfill (schedule / run now). Each step saves via the DataSource and can be skipped; show `SetupStatus.steps` progress. After the admin is created the user is logged in (`refresh()`).

## Admin (spec 10) — `src/pages/admin/`

- `AdminLayout.tsx`: sub-nav: Displays, Shifts, Breaks, Connection, Mapping, Standards, Engine, Users, Sync health, Audit; link back to portal.
- `DisplaysPage.tsx`: list (name, code, job, mode, last seen, online/offline), Claim modal (code, name, job picker with free-text search over `jobs(q)`, options), Edit modal, Re-pair (enter the new code), Delete.
- `ShiftsPage.tsx`, `BreaksPage.tsx`: CRUD with `DaysPicker`, time inputs, effective dates; show validation errors from the API.
- `ConnectionPage.tsx`: URL, username, password (blank = keep), timestamp mode + plant tz (settings), Test connection (shows version + entity sets found), poll/page/overlap/timeout/breaker/backfill settings, Run backfill now.
- `MappingPage.tsx`: 4-step wizard (spec 10.7): (1) entity set per dataset from live metadata (`mappingMetadata()`), optional datasets can be "not used"; (2) per target field pick a source field (dropdown filtered by type kind: timestamps only show timestamp fields; required fields marked); (3) watermark field per dataset (or none); (4) Test & preview per dataset (`mappingPreview`) showing rows grid + derived checks + warnings; Save (`updateMapping`).
- `StandardsPage.tsx`: global adjustment + per-operation adjustments (create/delete with note), standard computation settings (lookback, min units, min operators, max unit minutes, session gap, nightly time), "Recompute all standards now".
- `EnginePage.tsx`: eligibility minutes, neutral minutes, idle timeout, count_work_during_breaks, color bands (advanced), floor idle flag minutes.
- `UsersPage.tsx`: list, create, change role, deactivate, reset password.
- `SyncPage.tsx`: per-source state, breaker state, backfill progress, recent sync_log entries; auto-refresh 10 s.
- `AuditPage.tsx`: paginated audit entries with before/after JSON (collapsible).

## Mock data source (spec 12) — `src/data/mock/`

- `simulator/world.ts`: fictional company "Northbridge Circuit Assembly"; products `PB-2200 Controller Board`, `IO-410 Interface Board`, `PS-900 Power Module`; work orders `J00004673-0000` … (released 200–800); route subset per product from: SMT Placement, Reflow, AOI, Selective Solder - Top, Selective Solder - Bottom, ICT, Functional Test, Conformal Coat, Final Inspection, Pack; 14 invented operators (`JRivera`, `MChen`, `TOkafor`, `LNguyen`, `SPatel`, `AKowalski`, `DMorales`, `KYamada`, `RSingh`, `EBrooks`, `FHaddad`, `NIvanova`, `BOsei`, `CDubois`); shifts Day 07:00–19:00 / Night 19:00–07:00 (every day); breaks 09:30/15, 12:00/30, 14:00/15, 17:30/15 and night equivalents 21:30/15, 00:00/30, 02:00/15, 05:30/15; base rates per operation (Selective Solder ~30/h, Functional Test ~12/h, Pack ~60/h, others in between) with per-operator speed factors.
- `simulator/history.ts`: seeded PRNG (e.g. mulberry32) generating 30 days of unit_steps/defects/work orders ending at "now", deterministic per seed. Keep it under ~150k steps; generate lazily once and cache.
- `simulator/live.ts`: advances in real time from page load (`tick()` on a 5 s interval, scaled by a speed factor `window.__fldDemo.speed` / `?speed=` param; expose `window.__fldDemo = { setSpeed, getState }` as the hidden reviewer control) and scripts the scenarios in spec 12.4: one operator blue, one green, one yellow, one red; a visitor scanning 6 rework boards in 2 minutes on another job; an operator switching jobs at the half hour; the 14:00 break; defects 1–3/h on two operations; a display whose job changes at a scripted moment (~3 min after load); two displays (separate + grouped) on the same job.
- `MockDataSource.ts`: holds world state + in-memory admin state (displays, shifts, breaks, settings, users, adjustments, overrides, pins, audit) that resets on reload; computes every view with the engine (`computeHourCells` over the needed range with a 3 h lookback, `groupCells`, `computeDefectHourCells`, `computeStandard` for all product/operations at startup from history, `buildStandardsLookup`, `buildTvDashboard`, `buildShiftView`, `buildFloorView`, `buildOperatorDetail`, `buildJobDetail`, `buildProductView`, `computeRollups`, `rollingWindowColumns`, `listShiftInstances`, `findCurrentOrMostRecentShift`, `expandBreaks`). Cache hour cells for completed hours; recompute only current + previous hour on each tick. `subscribe()` emits `data_updated` after each tick and `display_updated` on admin changes. `me()` returns a demo admin user (`demo`) so the portal opens without login; `login` accepts any credentials; `setupStatus` → `needs_setup:false`. `syncHealth` returns ok (with a scripted 2-minute "delayed" episode ~5 min after load to demonstrate the banner). Connection test/metadata/preview return canned successful results with a fake entity list.

## Verification expectations

- `pnpm --filter @fld/web typecheck` clean; `pnpm build:web:mock` succeeds; `pnpm dev:web:mock` renders `/tv?demo=1`, `/tv?demo=2`, `/`, `/floor`, `/operators/JRivera`, `/jobs/J00004673-0000`, `/products/PB-2200`, `/admin/*` without console errors.
