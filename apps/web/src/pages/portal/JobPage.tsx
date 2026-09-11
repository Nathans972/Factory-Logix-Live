/**
 * Job detail (spec 9.5, docs/design/job-detail.html).
 *
 * Breadcrumb → title with status → KPI row → tabs. The dashboard tab carries the light-theme
 * hourly grid (the same `TvDashboard` DTO the floor TV renders) plus the operators and
 * shift-over-shift cards.
 */
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { TvDashboard, TvRow } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { IS_MOCK } from '../../data';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { downloadCsv } from '../../lib/csv';
import { formatInt, formatNum, formatPct, shortDate } from '../../lib/format';
import {
  Breadcrumbs,
  Button,
  Card,
  CardHeader,
  ErrorBox,
  HourlyGrid,
  KpiRow,
  KpiTile,
  PageHeader,
  ProgressBar,
  Segmented,
  Spinner,
  StatusBadge,
  Tabs,
  cellAccent,
} from '../../ui';
import { JobDefectsTable, JobOperatorsTable, JobShiftHistoryTable } from './components/JobTables';
import { rowOperatorLabel } from '../tv/tvLogic';

type JobTab = 'dashboard' | 'defects' | 'operators' | 'history';

const TABS: { value: JobTab; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'defects', label: 'Defects' },
  { value: 'operators', label: 'Operators' },
  { value: 'history', label: 'Shift history' },
];

const CLOSED_RE = /clos|complet|cancel/i;

/** `/tv` with the mock demo token so reviewers land on a claimed display. */
function tvHref(): string {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return base + '/tv' + (IS_MOCK ? '?demo=1' : '');
}

function exportDashboard(job: string, dash: TvDashboard): void {
  downloadCsv(
    'job-' + job + '-hourly',
    [
      { header: 'Operation', value: (r: TvRow) => r.operation },
      { header: 'Operator', value: (r: TvRow) => rowOperatorLabel(r) },
      { header: 'StdHr', value: (r: TvRow) => r.std_hr },
      { header: 'Prior', value: (r: TvRow) => r.prior },
      ...dash.columns.map((c, i) => ({ header: c.label, value: (r: TvRow) => r.cells[i]?.units ?? 0 })),
      { header: 'Shift', value: (r: TvRow) => r.shift },
      ...(dash.show_std_day ? [{ header: 'StdDay', value: (r: TvRow) => r.std_day }] : []),
    ],
    dash.rows,
  );
}

export function JobPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const { job = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const grouped = params.get('grouped') === '1';
  const tab = (params.get('tab') as JobTab | null) ?? 'dashboard';

  const detail = useQuery({ queryKey: ['jobDetail', job], queryFn: () => ds.jobDetail(job) });
  const list = useQuery({ queryKey: ['jobs', job, false], queryFn: () => ds.jobs(job, false), staleTime: 60_000 });
  useLiveRefetch(['data_updated']);

  const d = detail.data;
  const dash = d ? (grouped ? d.dashboard_grouped : d.dashboard_separate) : null;
  const item = list.data?.jobs.find((j) => j.job_number === job) ?? null;

  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value == null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  // ---- header ------------------------------------------------------------
  const closed = item ? (item.status ? CLOSED_RE.test(item.status) : !item.active) : false;
  const statusLabel = closed ? 'Closed' : (item?.status ?? 'In process');
  const displays = d?.displays_showing ?? [];
  const tvNames = displays.map((x) => x.name ?? 'Display ' + x.id).join(', ');
  const tvLabel =
    displays.length === 0 ? 'Not on any TV' : 'On ' + displays.length + ' TV' + (displays.length === 1 ? '' : 's') + ' · ' + tvNames;

  // ---- KPIs --------------------------------------------------------------
  // `shift_history` is oldest-first: "this shift" is the one in progress, else the most recent.
  const history = d?.shift_history ?? [];
  const shiftNow =
    history.find((r) => d != null && d.generated_at >= r.shift.start_utc && d.generated_at < r.shift.end_utc) ??
    history[history.length - 1] ??
    null;
  const unitsInWindow = dash ? dash.rows.reduce((s, r) => s + r.shift, 0) : 0;
  const defectsTotal = dash ? dash.defect_rows.reduce((s, r) => s + r.prior + r.shift_qty, 0) : 0;
  const defectsWindow = dash ? dash.defect_rows.reduce((s, r) => s + r.cells.reduce((a, b) => a + b, 0), 0) : 0;
  const topDefectOps = (dash?.defect_rows ?? [])
    .map((r) => ({ op: r.operation, n: r.cells.reduce((a, b) => a + b, 0) }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((r) => r.op);
  const visitors = new Set((d?.dashboard_separate.rows ?? []).filter((r) => r.visitor_row).flatMap((r) => r.operators)).size;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Jobs', to: '/jobs' }, { label: job }]} />

      <PageHeader
        title={
          <>
            {job}
            <StatusBadge tone={closed ? 'off' : 'ok'}>{statusLabel}</StatusBadge>
          </>
        }
        subtitle={
          dash ? (
            <>
              <Link className="link" to={'/products/' + encodeURIComponent(dash.job.product_number)}>
                {dash.job.product_number}
              </Link>
              {dash.job.product_name ? ' · ' + dash.job.product_name : ''}
              {item?.fl_created_at ? ' · Released ' + shortDate(item.fl_created_at, tz) : ''}
              {' · ' + formatInt(dash.job.qty_released) + ' units'}
            </>
          ) : (
            'Loading…'
          )
        }
        actions={
          <>
            <StatusBadge tone={displays.length ? 'info' : 'neutral'}>{tvLabel}</StatusBadge>
            <Segmented
              value={grouped ? 'grouped' : 'separate'}
              onChange={(v) => setParam('grouped', v === 'grouped' ? '1' : null)}
              options={[
                { value: 'separate', label: 'Per operator' },
                { value: 'grouped', label: 'Grouped' },
              ]}
            />
            <Button disabled={!dash} onClick={() => dash && exportDashboard(job, dash)}>
              Export CSV
            </Button>
          </>
        }
      />

      {detail.isError && <ErrorBox error={detail.error} />}
      {!d && !detail.isError && <Spinner />}

      {d && dash && (
        <>
          <KpiRow>
            <KpiTile
              label="Qty complete"
              value={
                <>
                  {formatInt(dash.job.qty_complete)} <span className="kpi-den">/ {formatInt(dash.job.qty_released)}</span>
                </>
              }
              hint={<ProgressBar value={dash.job.progress} width="100%" />}
            />
            <KpiTile
              label="Efficiency this shift"
              value={formatPct(shiftNow?.efficiency)}
              accent={cellAccent(shiftNow?.color)}
              hint={
                shiftNow
                  ? formatNum(shiftNow.earned_hours, 1) + ' h earned / ' + formatNum(shiftNow.charged_hours, 1) + ' h charged'
                  : 'no shift recorded yet'
              }
            />
            <KpiTile label="Units in window" value={formatInt(unitsInWindow)} hint="last 12 hours" />
            <KpiTile
              label="Defects"
              value={formatInt(defectsTotal)}
              accent={defectsTotal > 0 ? 'red' : 'none'}
              hint={formatInt(defectsWindow) + ' in the window' + (topDefectOps.length ? ' · ' + topDefectOps.join(', ') : '')}
            />
            <KpiTile
              label="Operators"
              value={formatInt(d.operators.length)}
              hint={formatInt(visitors) + ' visitor' + (visitors === 1 ? '' : 's')}
            />
          </KpiRow>

          <Tabs value={tab} onChange={(v) => setParam('tab', v === 'dashboard' ? null : v)} tabs={TABS} />

          {tab === 'dashboard' && (
            <>
              <Card>
                <CardHeader
                  title="Hourly output"
                  subtitle="Rolling 12 hours · same rules as the floor TV"
                  actions={
                    <>
                      <span className="card-sub">Current hour outlined</span>
                      <a className="btn btn-ghost btn-sm" href={tvHref()} target="_blank" rel="noreferrer">
                        Open TV view
                      </a>
                    </>
                  }
                />
                <HourlyGrid dashboard={dash} tz={tz} />
              </Card>

              <div className="pair2">
                <JobOperatorsTable rows={d.operators} exportName={'job-' + job + '-operators'} />
                <JobShiftHistoryTable
                  rows={d.shift_history}
                  tz={tz}
                  now={d.generated_at}
                  exportName={'job-' + job + '-shift-history'}
                />
              </div>
            </>
          )}

          {tab === 'defects' && <JobDefectsTable dashboard={dash} exportName={'job-' + job + '-defects'} />}
          {tab === 'operators' && <JobOperatorsTable rows={d.operators} exportName={'job-' + job + '-operators'} />}
          {tab === 'history' && (
            <JobShiftHistoryTable rows={d.shift_history} tz={tz} now={d.generated_at} exportName={'job-' + job + '-shift-history'} />
          )}
        </>
      )}
    </>
  );
}
