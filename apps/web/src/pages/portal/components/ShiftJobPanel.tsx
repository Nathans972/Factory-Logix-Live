/**
 * One active job of the shift view, rendered as a standard card (spec 9.2).
 *
 * Card header: job number link, product, status badge, then progress / efficiency /
 * charged-earned hours and "Export CSV" on the right. The table has one row per operation with an
 * expander to the per-operator rows; visitor rows are muted and annotated.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ShiftJobSection, ShiftOperationRow } from '@fld/shared';
import { Button, Card, CardHeader, DataTable, PaceChip, ProgressBar, StatusBadge, type Column } from '../../../ui';
import { downloadCsv, type CsvColumn } from '../../../lib/csv';
import { formatHours } from '../../../lib/format';
import { formatStdHr, formatUnits } from './numbers';

/** "2 eligible · 1 visitor", or just the name when a single operator worked the operation. */
function operatorsLabel(op: ShiftOperationRow): string {
  if (op.operators.length === 1) {
    const only = op.operators[0]!;
    return only.operator_name ?? only.operator_id;
  }
  const visitors = op.operators.filter((o) => o.visitor).length;
  const parts = [`${op.eligible_operators} eligible`];
  if (visitors > 0) parts.push(`${visitors} visitor${visitors === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

const CSV_COLUMNS: CsvColumn<ShiftOperationRow>[] = [
  { header: 'Operation', value: (r) => r.operation },
  { header: 'Operators', value: (r) => operatorsLabel(r) },
  { header: 'StdHr', value: (r) => r.std_hr },
  { header: 'Units', value: (r) => r.units },
  { header: 'Visitor units', value: (r) => r.visitor_units },
  { header: 'Charged h', value: (r) => (r.charged_minutes / 60).toFixed(2) },
  { header: 'Target', value: (r) => Math.round(r.target_units) },
  { header: 'Pace', value: (r) => (r.pace == null ? '' : `${Math.round(r.pace * 100)}%`) },
];

export function ShiftJobPanel({ section }: { section: ShiftJobSection }) {
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (key: string | number) =>
    setExpanded((prev) => (prev.includes(String(key)) ? prev.filter((k) => k !== String(key)) : [...prev, String(key)]));

  const columns: Column<ShiftOperationRow>[] = [
    { key: 'operation', header: 'Operation', sortable: false, render: (r) => r.operation },
    { key: 'operators', header: 'Operators', sortable: false, render: (r) => operatorsLabel(r) },
    {
      key: 'std',
      header: 'StdHr',
      align: 'right',
      sortable: false,
      render: (r) => (r.std_hr == null ? <span className="chip chip-neutral">no std</span> : formatStdHr(r.std_hr)),
    },
    {
      key: 'units',
      header: 'Units',
      align: 'right',
      sortable: false,
      render: (r) => (
        <>
          {formatUnits(r.units)}
          {r.visitor_units > 0 && <span className="num-note"> (+{r.visitor_units} visitor)</span>}
        </>
      ),
    },
    { key: 'charged', header: 'Charged', align: 'right', sortable: false, render: (r) => formatHours(r.charged_minutes / 60, 1) },
    { key: 'target', header: 'Target', align: 'right', sortable: false, render: (r) => formatUnits(Math.round(r.target_units)) },
    {
      key: 'pace',
      header: 'Pace',
      align: 'right',
      sortable: false,
      render: (r) => <PaceChip pace={r.pace} color={r.color} />,
    },
  ];

  return (
    <Card className="shift-job">
      <CardHeader
        title={
          <Link className="link" to={`/jobs/${encodeURIComponent(section.job_number)}`}>
            {section.job_number}
          </Link>
        }
        subtitle={
          <>
            <Link className="link" to={`/products/${encodeURIComponent(section.product_number)}`}>
              {section.product_number}
            </Link>
            {section.product_name ? ` · ${section.product_name}` : ''}
          </>
        }
        badges={<StatusBadge tone="ok">Active</StatusBadge>}
        actions={
          <>
            <span className="card-sub nowrap">
              {formatUnits(section.qty_complete)} / {formatUnits(section.qty_released)}
            </span>
            <ProgressBar value={section.progress} />
            <PaceChip pace={section.efficiency} color={section.color} />
            <span className="card-sub nowrap" title="Charged / earned hours in this shift">
              {formatHours(section.charged_hours, 1)} charged · {formatHours(section.earned_hours, 1)} earned
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => downloadCsv(`shift-${section.job_number}-operations`, CSV_COLUMNS, section.operations)}
              title="Export this job's operations as CSV"
            >
              Export CSV
            </Button>
          </>
        }
      />
      <div className="card-body">
        <DataTable
          columns={columns}
          rows={section.operations}
          rowKey={(r) => r.operation}
          emptyMessage="No operations with activity"
          expandedKeys={expanded}
          onToggleExpand={toggle}
          expandable={(r) => r.operators.length > 0}
          renderSubRows={(r) =>
            r.operators.map((o) => (
              <tr key={`${r.operation}:${o.operator_id}`} className={`row-sub${o.visitor ? ' row-visitor' : ''}`}>
                <td>
                  <Link to={`/operators/${encodeURIComponent(o.operator_id)}`}>{o.operator_name ?? o.operator_id}</Link>
                </td>
                <td>{o.eligible ? 'Eligible' : 'Visitor'}</td>
                <td className="dt-num">{o.eligible ? formatStdHr(r.std_hr) : '—'}</td>
                <td className="dt-num">{formatUnits(o.units)}</td>
                <td className="dt-num">{o.eligible ? formatHours(o.charged_minutes / 60, 1) : '—'}</td>
                <td className="dt-num">{o.eligible ? formatUnits(Math.round(o.target_units)) : '—'}</td>
                <td className="dt-num">
                  <PaceChip pace={o.pace} color={o.color} />
                </td>
              </tr>
            ))
          }
        />
      </div>
    </Card>
  );
}
