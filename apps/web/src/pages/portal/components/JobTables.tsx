/** The three job-detail tables (docs/design/job-detail.html): operators, shift over shift, defects. */
import type { JobOperatorTotal, JobShiftHistoryRow, TvDashboard, TvDefectRow } from '@fld/shared';
import { ColorChip, DataTable, HourCellBox, PersonCell, StatusBadge, type Column } from '../../../ui';
import { operatorLabel } from '../../tv/tvLogic';
import { formatHours, formatInt, formatNum, formatPct, shortDate } from '../../../lib/format';

export function JobOperatorsTable({ rows, exportName }: { rows: JobOperatorTotal[]; exportName: string }) {
  const columns: Column<JobOperatorTotal>[] = [
    {
      key: 'operator',
      header: 'Operator',
      value: (r) => operatorLabel(r.operator_id, r.operator_name),
      render: (r) => <PersonCell id={r.operator_id} name={r.operator_name} />,
    },
    { key: 'operations', header: 'Operations', value: (r) => r.operations.join(' / '), render: (r) => r.operations.join(' / ') || '—' },
    { key: 'units', header: 'Units', align: 'right', value: (r) => r.units, render: (r) => formatInt(r.units) },
    {
      key: 'charged',
      header: 'Charged',
      align: 'right',
      value: (r) => Math.round(r.charged_minutes),
      render: (r) => formatHours(r.charged_minutes / 60, 1),
    },
  ];
  return (
    <DataTable
      title="Operators on this job"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.operator_id}
      exportName={exportName}
      defaultSort={{ key: 'units', dir: 'desc' }}
      emptyMessage="No operator activity yet"
    />
  );
}

export function JobShiftHistoryTable({
  rows,
  tz,
  now,
  exportName,
}: {
  rows: JobShiftHistoryRow[];
  tz: string;
  now: number;
  exportName: string;
}) {
  const inProgress = (r: JobShiftHistoryRow) => now >= r.shift.start_utc && now < r.shift.end_utc;
  const columns: Column<JobShiftHistoryRow>[] = [
    {
      key: 'shift',
      header: 'Shift',
      value: (r) => `${r.shift.date} ${r.shift.name}`,
      render: (r) => (
        <>
          {r.shift.name} · {shortDate(r.shift.start_utc, tz)}
          {inProgress(r) && (
            <>
              {' '}
              <StatusBadge tone="ok">now</StatusBadge>
            </>
          )}
        </>
      ),
    },
    { key: 'units', header: 'Units', align: 'right', value: (r) => r.units, render: (r) => formatInt(r.units) },
    { key: 'charged', header: 'Charged h', align: 'right', value: (r) => r.charged_hours, render: (r) => formatNum(r.charged_hours, 1) },
    { key: 'earned', header: 'Earned h', align: 'right', value: (r) => r.earned_hours, render: (r) => formatNum(r.earned_hours, 1) },
    {
      key: 'efficiency',
      header: 'Efficiency',
      align: 'right',
      value: (r) => r.efficiency,
      render: (r) => <ColorChip color={r.color}>{formatPct(r.efficiency)}</ColorChip>,
    },
  ];
  return (
    <DataTable
      title="Shift over shift"
      columns={columns}
      rows={rows}
      rowKey={(r) => `${r.shift.date}|${r.shift.shift_id}`}
      exportName={exportName}
      defaultSort={{ key: 'shift', dir: 'desc' }}
      emptyMessage="No shifts recorded on this job"
    />
  );
}

export function JobDefectsTable({ dashboard, exportName }: { dashboard: TvDashboard; exportName: string }) {
  const columns: Column<TvDefectRow>[] = [
    { key: 'operation', header: 'Operation', render: (r) => r.operation },
    { key: 'prior', header: 'Prior', align: 'right', value: (r) => r.prior, render: (r) => formatInt(r.prior) },
    ...dashboard.columns.map((c, i) => ({
      key: `h${c.hour_start_utc}`,
      header: c.label,
      align: 'center' as const,
      sortable: false,
      width: 56,
      value: (r: TvDefectRow) => r.cells[i] ?? 0,
      render: (r: TvDefectRow) => {
        const n = r.cells[i] ?? 0;
        return <HourCellBox units={n === 0 ? null : n} color={n === 0 ? 'blank' : 'red'} title={`${c.label}:00 · ${n} defects`} />;
      },
    })),
    { key: 'shift', header: 'Shift qty', align: 'right', value: (r) => r.shift_qty, render: (r) => formatInt(r.shift_qty) },
  ];
  return (
    <DataTable
      title="Defects"
      columns={columns}
      rows={dashboard.defect_rows}
      rowKey={(r) => r.operation}
      exportName={exportName}
      emptyMessage="No defects recorded"
    />
  );
}
