/** Shift breakdown table (spec 7.11 / 9.2): one row per job, operation or operator. */
import type { RollupRow } from '@fld/shared';
import { ColorChip, DataTable, type Column } from '../../../ui';
import { formatHours, formatPct } from '../../../lib/format';

export function RollupTable({ rows, label, exportName }: { rows: RollupRow[]; label: string; exportName: string }) {
  const columns: Column<RollupRow>[] = [
    { key: 'label', header: label, render: (r) => r.label },
    { key: 'units', header: 'Units', align: 'right', render: (r) => r.units },
    { key: 'visitor_units', header: 'Visitor units', align: 'right', render: (r) => r.visitor_units },
    { key: 'charged', header: 'Charged h', align: 'right', value: (r) => r.charged_hours, render: (r) => formatHours(r.charged_hours) },
    { key: 'earned', header: 'Earned h', align: 'right', value: (r) => r.earned_hours, render: (r) => formatHours(r.earned_hours) },
    {
      key: 'efficiency',
      header: 'Efficiency',
      align: 'right',
      value: (r) => r.efficiency,
      render: (r) => <ColorChip color={r.color}>{formatPct(r.efficiency)}</ColorChip>,
    },
    { key: 'operators', header: 'Eligible operators', align: 'right', render: (r) => r.eligible_operators },
    {
      key: 'no_std',
      header: 'No StdHr',
      align: 'right',
      value: (r) => r.rows_without_std,
      render: (r) => (r.rows_without_std > 0 ? <span className="tag" title="Rows excluded from efficiency">⚑ {r.rows_without_std}</span> : ''),
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      exportName={exportName}
      defaultSort={{ key: 'charged', dir: 'desc' }}
      emptyMessage="No activity in this shift"
    />
  );
}
