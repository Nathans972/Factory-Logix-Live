/** Job detail: the TV dashboard embedded in the portal plus totals and history (spec 9.5). */
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { JobOperatorTotal, JobShiftHistoryRow, TvDefectRow } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDate, formatHours, formatMinutes, formatPct, formatTime } from '../../lib/format';
import { ColorChip, DataTable, ErrorBox, PageHeader, Panel, Spinner, Stat, Tabs, type Column } from '../../ui';
import { TvDashboard } from '../tv';
import { ProgressBar } from './components/ProgressBar';

export function JobPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const { job = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const grouped = params.get('grouped') === '1';

  const detail = useQuery({ queryKey: ['jobDetail', job], queryFn: () => ds.jobDetail(job) });
  useLiveRefetch(['data_updated']);

  const d = detail.data;
  const dash = d ? (grouped ? d.dashboard_grouped : d.dashboard_separate) : null;

  const defectColumns: Column<TvDefectRow>[] = dash
    ? [
        { key: 'operation', header: 'Operation', render: (r) => r.operation },
        { key: 'prior', header: 'Prior', align: 'right', render: (r) => r.prior },
        ...dash.columns.map((c, i) => ({
          key: `h${c.hour_start_utc}`,
          header: c.label,
          align: 'right' as const,
          value: (r: TvDefectRow) => r.cells[i] ?? 0,
          render: (r: TvDefectRow) => r.cells[i] ?? 0,
        })),
        { key: 'shift', header: 'Shift qty', align: 'right', render: (r) => r.shift_qty },
      ]
    : [];

  const operatorColumns: Column<JobOperatorTotal>[] = [
    {
      key: 'operator',
      header: 'Operator',
      value: (r) => r.operator_name ?? r.operator_id,
      render: (r) => <Link to={`/operators/${encodeURIComponent(r.operator_id)}`}>{r.operator_name ?? r.operator_id}</Link>,
    },
    { key: 'operations', header: 'Operations', value: (r) => r.operations.join(' / '), render: (r) => r.operations.join(' / ') },
    { key: 'units', header: 'Units', align: 'right', render: (r) => r.units },
    { key: 'charged', header: 'Charged', align: 'right', value: (r) => Math.round(r.charged_minutes), render: (r) => formatMinutes(r.charged_minutes) },
  ];

  const historyColumns: Column<JobShiftHistoryRow>[] = [
    { key: 'shift', header: 'Shift', value: (r) => `${r.shift.date} ${r.shift.name}`, render: (r) => `${r.shift.name} · ${formatDate(r.shift.start_utc, tz)}` },
    { key: 'units', header: 'Units', align: 'right', render: (r) => r.units },
    { key: 'charged', header: 'Charged h', align: 'right', value: (r) => r.charged_hours, render: (r) => formatHours(r.charged_hours) },
    { key: 'earned', header: 'Earned h', align: 'right', value: (r) => r.earned_hours, render: (r) => formatHours(r.earned_hours) },
    {
      key: 'efficiency',
      header: 'Efficiency',
      align: 'right',
      value: (r) => r.efficiency,
      render: (r) => <ColorChip color={r.color}>{formatPct(r.efficiency)}</ColorChip>,
    },
  ];

  return (
    <>
      <PageHeader
        title={job}
        subtitle={
          dash ? (
            <span>
              <Link to={`/products/${encodeURIComponent(dash.job.product_number)}`}>{dash.job.product_number}</Link>
              {dash.job.product_name ? ` · ${dash.job.product_name}` : ''}
              {` · updated ${formatTime(d?.generated_at ?? null, tz, true)}`}
            </span>
          ) : (
            'Loading…'
          )
        }
        actions={
          <Tabs
            value={grouped ? 'grouped' : 'separate'}
            onChange={(v) =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                if (v === 'grouped') next.set('grouped', '1');
                else next.delete('grouped');
                return next;
              })
            }
            tabs={[
              { value: 'separate', label: 'Per operator' },
              { value: 'grouped', label: 'Grouped' },
            ]}
          />
        }
      />

      {detail.isError && <ErrorBox error={detail.error} />}
      {!d && !detail.isError && <Spinner />}

      {d && dash && (
        <>
          <div className="tv-embed">
            <TvDashboard dashboard={dash} showGauge tz={tz} updatedAt={d.generated_at} compact />
          </div>

          <div className="grid grid-4 mb">
            <Stat label="Qty complete" value={dash.job.qty_complete} />
            <Stat label="Qty released" value={dash.job.qty_released} />
            <Stat label="Progress" value={formatPct(dash.job.progress)} hint={<ProgressBar value={dash.job.progress} />} />
            <Stat
              label="Defects"
              value={dash.defect_rows.reduce((s, r) => s + r.shift_qty + r.prior, 0)}
              hint={`${dash.defect_rows.reduce((s, r) => s + r.shift_qty, 0)} in the window`}
            />
          </div>

          <DataTable
            title="Defects"
            columns={defectColumns}
            rows={dash.defect_rows}
            rowKey={(r) => r.operation}
            exportName={`job-${job}-defects`}
            dense
            emptyMessage="No defects recorded"
          />

          <DataTable
            title="Operators on this job"
            columns={operatorColumns}
            rows={d.operators}
            rowKey={(r) => r.operator_id}
            exportName={`job-${job}-operators`}
            defaultSort={{ key: 'units', dir: 'desc' }}
            emptyMessage="No operator activity yet"
          />

          <DataTable
            title="Shift history"
            columns={historyColumns}
            rows={d.shift_history}
            rowKey={(r) => `${r.shift.date}|${r.shift.shift_id}`}
            exportName={`job-${job}-shift-history`}
            defaultSort={{ key: 'shift', dir: 'desc' }}
            emptyMessage="No completed shifts on this job"
          />

          <Panel title="Open on TV">
            {d.displays_showing.length === 0 ? (
              <span className="muted">Not on any TV.</span>
            ) : (
              <span className="row">
                {d.displays_showing.map((disp) => (
                  <span className="tag" key={disp.id}>
                    {disp.name ?? `Display ${disp.id}`}
                  </span>
                ))}
              </span>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
