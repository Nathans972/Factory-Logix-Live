# FactoryLogix Live: portal design system

This is the visual and interaction spec for the manager portal and admin area (`apps/web`,
everything except the TV page, which keeps its dark legacy look on purpose). The implementation
must follow it; the demo screens in the design plan are the reference renderings.

## Principles

1. **Calm surface, loud data.** Chrome is neutral. Color is reserved for pace, status, and the one
   primary action on a page.
2. **Production, plus a separate Settings area.** The shell follows the company's other internal
   tools: a top bar (menu button, brand and plant name, centered search, freshness indicator,
   help, Settings gear, avatar with the user's name) and a 232 px rail that opens with a red band.
   The production rail has Home and a collapsible Production group (Shift view, Floor, Jobs,
   Operators, Products, and TV displays for managers). Administration is not in that rail: the
   gear opens Settings, which has its own rail (Displays, Shifts, Breaks, FactoryLogix, Mapping,
   Standards, Engine, Users, Sync health, Audit) and "Back to production". Each rail lists only the
   pages the user's role can open, so there are no lock icons. Both rails end with Dark mode and the
   version.
3. **Tables are the product.** 40 px rows, 11 px uppercase column labels, right-aligned numerics
   with tabular figures, expander rows for drill-down, sticky headers, and "Export CSV" in every
   card header.
4. **Every page reads top-down:** breadcrumb (when nested), title with one line of context,
   actions on the right, filters, KPI tiles, content cards.

## Tokens

| Token | Light | Dark |
|---|---|---|
| canvas | `#F4F6F9` | `#0F1216` |
| surface | `#FFFFFF` | `#171B21` |
| surface-2 | `#F8FAFC` | `#1D222A` |
| border | `#E4E7EC` | `#262C35` |
| border-strong | `#CBD5E1` | `#3A4351` |
| text | `#0F172A` | `#E6E9EE` |
| text-2 | `#475569` | `#A7B0BE` |
| text-3 | `#94A3B8` | `#6B7484` |
| primary | `#2457C5` (hover `#1C46A0`, soft `#E8EFFB`) | `#5B8DEF` (soft `#1B2A47`) |

Pace and status colors are the same in both themes:

| Meaning | Strong | Soft tint |
|---|---|---|
| red (below 70 %) | `#D92D20` | `#FEE4E2` |
| amber (70 to 90 %) | `#D97706` | `#FEF3C7` |
| green (90 to 105 %) | `#15803D` | `#DCFCE7` |
| blue (above 105 %) | `#0369A1` | `#E0F2FE` |
| neutral / visitor | `#64748B` | `#F1F5F9` |

Company-portal chrome (rail band, active rail row, Home greeting card):

| Token | Light | Dark |
|---|---|---|
| band (rail header) | `#B42318` | `#A3271D` |
| brand-soft / brand-ink (Home tile icon and chip) | `#FBECEB` / `#9F1F16` | `#3A1D1B` / `#F8A29B` |
| rail-bg | `#F7F8FA` | `#13171C` |
| rail-active (plus a 3 px band-colored left edge) | `#E9EDF3` | `#222A35` |
| hero (Home greeting card) | `#EEF2F8` to `#F6F8FB` | `#1B222C` to `#171B21` |

Hourly grid cells (job page and operator strips) use solid fills instead of tints: red `#D92D20`
with white text, amber `#F5C518`, green `#22C55E`, blue `#38BDF8` with dark text, visitor `#94A3B8`.
The current hour gets a 2 px primary outline.

- Radius: 12 px cards, 8 px controls, 6 px badges, 999 px chips.
- Shadow: `0 1px 2px rgba(15,23,42,.06), 0 1px 3px rgba(15,23,42,.08)`.
- Type: Inter, then "Segoe UI", then system-ui. Sizes 11 (column labels), 12, 13, 14 (body),
  15 (card titles), 17 (wizard step), 22 (page title), 26 (KPI value). Weights: 500 controls,
  600 headings, 700 values. `font-variant-numeric: tabular-nums` on all data.
- Spacing scale: 4, 8, 12, 16, 24, 28.

## Components

- **Button**: primary (filled), secondary (white with border and shadow), ghost, danger text.
  Heights 34 px and 28 px (small).
- **Input / Select**: 34 px, label above (12 px, 600), hint below (12 px, text-3). Focus ring
  `0 0 0 3px rgba(36,87,197,.15)` plus primary border.
- **Segmented control**: for shift (Day / Night) and mode (Per operator / Grouped).
- **Switch**: 36 by 20 px pill for booleans.
- **KPI tile**: label, 26 px value, hint line, optional 3 px semantic left accent.
- **Pace chip**: pill with soft tint and strong text, e.g. "96 %". Neutral chip shows a dash.
- **Status badge**: dot plus text: Online, Offline, In process, Closed, Working, Idle 18 min, Visitor.
- **Progress bar**: 6 px, primary fill. **Sparkline**: 12 bars, primary at 50 % opacity.
- **Card**: header (title, subtitle, badges, right-side actions) plus table or body. Empty state is
  centered, muted text.
- **Drawer**: 440 px, right side, for create and edit forms in Administration. Modals only for
  confirmations.
- **Stepper**: pills with numbered circles; done steps green, current primary.
- **Note panel**: success (green) and error (red) with a leading icon and a bold first line.
- **Freshness indicator**: green pill "Live · updated 11:26 AM"; amber "Data delayed since 10:58";
  red "Collector down". Lives in the top bar on every page.

## Pages

- **Home** (landing, `/`): greeting card ("Good morning, {name}" and one line of plant status),
  then a Production card with one tile per page (icon, "Production" chip, title, one-line
  description). Old `/?date=…` shift-view links go on to `/shift`.
- **TV displays** (`/displays`, managers): one card per paired TV (name, Online/Offline, the job it
  shows, mode, last seen) with a **Change job** button that opens the job picker in a drawer.
  Pairing, display options and deleting stay in Settings → Displays (admins).
- **Shift view** (`/shift`): KPI row (efficiency, units, charged hours, active jobs, defects, rows
  without standard), one card per active job with progress, efficiency chip, per-operation rows
  and operator expanders, visitor units annotated in gray, then a breakdown card with tabs.
- **Floor**: KPI row (on pace, behind, well behind, units this hour) and one table. Idle rows are
  tinted amber, visitors are muted and hidden by default.
- **Job detail**: breadcrumb, status badge, KPI tiles, tabs (Dashboard, Defects, Operators, Shift
  history), hourly grid card with the grouped control, two-column operators and shift history.
- **Product standards**: one row per route operation showing computed value and sample, median,
  FL value, adjustment, override, and the bold effective value with a provenance label; active
  adjustments and overrides listed below with remove actions.
- **Admin**: list plus drawer for displays, shifts, breaks, users; wizard-style mapping page;
  settings pages as grouped forms with a sticky save bar.
- **Setup**: centered 760 px card with the stepper.

## Out of scope

The TV page (`apps/web/src/pages/tv`) keeps its own stylesheet and dark palette.
