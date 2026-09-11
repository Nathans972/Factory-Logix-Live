# Design reference renderings

These files are the approved reference screens from the portal redesign (design plan
`plan-87ea973984f8420a`). They are **not shipped**; they exist so the implementation can be
compared against the approved look pixel for pixel. Open any `.html` file directly in a browser.

- `reference.css` — the complete stylesheet used by every screen (tokens + components).
- `shift-view.html` — landing page: shell, KPI row, job cards with expanders, breakdown tabs.
- `job-detail.html` — breadcrumb, status badge, KPIs, tabs, hourly grid, two-column cards.
- `admin-displays.html` — admin list + the 440 px "Claim a TV" drawer.
- `setup.html` — first-run wizard with stepper and connection test result.

Rules of thumb when implementing (see `../DESIGN.md` for the full spec):

- Class names in the app are your own; the visual result must match these files.
- Light theme is the default. Dark theme is a token flip on `[data-theme="dark"]`.
- The TV page keeps its own stylesheet and is out of scope.
