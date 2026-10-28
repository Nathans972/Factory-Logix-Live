/** Shift breakdown table (spec 7.11 / 9.2): one row per job, operation or operator. */
import { Link } from 'react-router-dom';
import type { RollupRow } from '@fld/shared';
import { ColorChip, DataTable, type Column } from '../../../ui';
import { downloadCsv, type CsvColumn } from '../../../lib/csv';
import { formatInt, formatPct } from '../../../lib/format';

export type RollupKind = 'job' | 'operation' | 'operator';

export const ROLLUP_LABEL: Record<RollupKind, string> = { job: 'Job', operation: 'Operation', operator: 'Operator' };

export function rollupCsvColumns(kind: RollupKind): CsvColumn<RollupRow>[] {
  return [
    { header: ROLLUP_LABEL[kind], value: (r) => r.label },
    { header: 'Product', value: (r) => r.product_number },
    { header: 'Units', value: (r) => r.units },
    { header: 'Visitor units', value: (r) => r.visitor_units },
    { header: 'Charged h', value: (r) => r.charged_hours.toFixed(2) },
    { header: 'Earned h', value: (r) => r.earned_hours.toFixed(2) },
    { header: 'Efficiency', value: (r) => (r.efficiency == null ? '' : `${Math.round(r.efficiency * 100)}%`) },
    { header: 'Operators', value: (r) => r.eligible_operators },
    { header: 'Rows without standard', value: (r) => r.rows_without_std },
    { header: 'Charged h without standard', value: (r) => r.charged_hours_without_std.toFixed(2) },
  ];
}

export function exportRollups(filename: string, kind: RollupKind, rows: RollupRow[]): void {
  downloadCsv(filename, rollupCsvColumns(kind), rows);
}

function labelCell(kind: RollupKind, r: RollupRow) {
  if (kind === 'job' && r.job_number) {
    return (
      <Link className="link" to={`/jobs/${encodeURIComponent(r.job_number)}`}>
        {r.label}
      </Link>
    );
  }
  if (kind === 'operator' && r.operator_id) {
    return (
      <Link className="link" to={`/operators/${encodeURIComponent(r.operator_id)}`}>
        {r.label}
      </Link>
    );
  }
  return r.label;
}

export function RollupTable({ rows, kind }: { rows: RollupRow[]; kind: RollupKind }) {
  const hasProduct = rows.some((r) => r.product_number);
  const hasMissingStd = rows.some((r) => r.rows_without_std > 0);

  const columns: Column<RollupRow>[] = [
    { key: 'label', header: ROLLUP_LABEL[kind], value: (r) => r.label, render: (r) => labelCell(kind, r) },
    ...(hasProduct
      ? [
          {
            key: 'product',
            header: 'Product',
            value: (r: RollupRow) => r.product_number,
            render: (r: RollupRow) =>
              r.product_number ? (
                <Link className="link" to={`/products/${encodeURIComponent(r.product_number)}`}>
                  {r.product_number}
                </Link>
              ) : (
                '—'
              ),
          },
        ]
      : []),
    { key: 'units', header: 'Units', align: 'right', value: (r) => r.units, render: (r) => formatInt(r.units) },
    { key: 'charged', header: 'Charged h', align: 'right', value: (r) => r.charged_hours, render: (r) => r.charged_hours.toFixed(1) },
    { key: 'earned', header: 'Earned h', align: 'right', value: (r) => r.earned_hours, render: (r) => r.earned_hours.toFixed(1) },
    {
      key: 'efficiency',
      header: 'Efficiency',
      align: 'right',
      value: (r) => r.efficiency,
      render: (r) => <ColorChip color={r.color}>{formatPct(r.efficiency)}</ColorChip>,
    },
    // one row per operator already answers "how many operators", so the column only earns its
    // place on the job and operation breakdowns
    ...(kind === 'operator'
      ? []
      : [
          {
            key: 'operators',
            header: 'Operators',
            align: 'right' as const,
            value: (r: RollupRow) => r.eligible_operators,
            render: (r: RollupRow) => r.eligible_operators,
          },
        ]),
    ...(hasMissingStd
      ? [
          {
            key: 'no_std',
            header: 'No StdHr',
            align: 'right' as const,
            value: (r: RollupRow) => r.rows_without_std,
            render: (r: RollupRow) =>
              r.rows_without_std > 0 ? (
                <span className="badge badge-warn" title="Rows excluded from efficiency">
                  <span className="dot" />
                  {r.rows_without_std}
                </span>
              ) : (
                ''
              ),
          },
        ]
      : []),
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      defaultSort={{ key: 'charged', dir: 'desc' }}
      emptyMessage="No activity in this shift"
    />
  );
}
