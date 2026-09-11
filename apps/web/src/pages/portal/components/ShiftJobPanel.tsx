/** One active job section of the shift view: operation rows with an expander to operator rows (spec 9.2). */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ShiftJobSection, ShiftOperationRow, ShiftOperatorRow } from '@fld/shared';
import { ColorChip, DataTable, Panel, PaceChip, type Column } from '../../../ui';
import { formatHours, formatMinutes, formatPct } from '../../../lib/format';
import { ProgressBar } from './ProgressBar';

type Row =
  | { kind: 'op'; key: string; op: ShiftOperationRow; operator: null }
  | { kind: 'operator'; key: string; op: ShiftOperationRow; operator: ShiftOperatorRow };

export function ShiftJobPanel({ section }: { section: ShiftJobSection }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const rows: Row[] = [];
  for (const op of section.operations) {
    rows.push({ kind: 'op', key: `op:${op.operation}`, op, operator: null });
    if (open[op.operation]) {
      for (const o of op.operators) {
        rows.push({ kind: 'operator', key: `op:${op.operation}:${o.operator_id}`, op, operator: o });
      }
    }
  }

  const columns: Column<Row>[] = [
    {
      key: 'operation',
      header: 'Operation',
      sortable: false,
      value: (r) => (r.kind === 'op' ? r.op.operation : (r.operator.operator_name ?? r.operator.operator_id)),
      render: (r) =>
        r.kind === 'op' ? (
          <>
            <button
              type="button"
              className="expander"
              aria-expanded={!!open[r.op.operation]}
              title={open[r.op.operation] ? 'Hide operators' : 'Show operators'}
              onClick={() => setOpen((p) => ({ ...p, [r.op.operation]: !p[r.op.operation] }))}
            >
              {open[r.op.operation] ? '▾' : '▸'}
            </button>
            {r.op.operation}
          </>
        ) : (
          <>
            <Link to={`/operators/${encodeURIComponent(r.operator.operator_id)}`}>
              {r.operator.operator_name ?? r.operator.operator_id}
            </Link>
            {r.operator.visitor && <span className="annot">visitor</span>}
          </>
        ),
    },
    {
      key: 'std',
      header: 'StdHr',
      align: 'right',
      sortable: false,
      value: (r) => (r.kind === 'op' ? r.op.std_hr : null),
      render: (r) => (r.kind === 'op' ? (r.op.std_hr == null ? <span className="tag">no std</span> : r.op.std_hr.toFixed(1)) : ''),
    },
    {
      key: 'eligible',
      header: 'Eligible ops',
      align: 'right',
      sortable: false,
      value: (r) => (r.kind === 'op' ? r.op.eligible_operators : r.operator.eligible ? 'eligible' : 'visitor'),
      render: (r) => (r.kind === 'op' ? r.op.eligible_operators : r.operator.eligible ? 'eligible' : 'visitor'),
    },
    {
      key: 'units',
      header: 'Units',
      align: 'right',
      sortable: false,
      value: (r) => (r.kind === 'op' ? r.op.units : r.operator.units),
      render: (r) =>
        r.kind === 'op' ? (
          <>
            {r.op.units}
            {r.op.visitor_units > 0 && <span className="annot">(+{r.op.visitor_units} visitor)</span>}
          </>
        ) : (
          r.operator.units
        ),
    },
    {
      key: 'charged',
      header: 'Charged',
      align: 'right',
      sortable: false,
      value: (r) => Math.round(r.kind === 'op' ? r.op.charged_minutes : r.operator.charged_minutes),
      render: (r) => formatMinutes(r.kind === 'op' ? r.op.charged_minutes : r.operator.charged_minutes),
    },
    {
      key: 'target',
      header: 'Target',
      align: 'right',
      sortable: false,
      value: (r) => Math.round(r.kind === 'op' ? r.op.target_units : r.operator.target_units),
      render: (r) => Math.round(r.kind === 'op' ? r.op.target_units : r.operator.target_units),
    },
    {
      key: 'pace',
      header: 'Pace',
      align: 'right',
      sortable: false,
      value: (r) => (r.kind === 'op' ? r.op.pace : r.operator.pace),
      render: (r) =>
        r.kind === 'op' ? <PaceChip pace={r.op.pace} color={r.op.color} /> : <PaceChip pace={r.operator.pace} color={r.operator.color} />,
    },
  ];

  return (
    <Panel
      title={
        <span className="job-head">
          <Link className="job-no" to={`/jobs/${encodeURIComponent(section.job_number)}`}>
            {section.job_number}
          </Link>
          <span className="sep">·</span>
          <Link to={`/products/${encodeURIComponent(section.product_number)}`}>{section.product_number}</Link>
          <span className="sub">{section.product_name ?? ''}</span>
        </span>
      }
      actions={
        <span className="row">
          <span className="sub nowrap">
            {section.qty_complete} / {section.qty_released}
          </span>
          <ProgressBar value={section.progress} small />
          <ColorChip color={section.color} title="Job efficiency in this shift">
            {formatPct(section.efficiency)}
          </ColorChip>
          <span className="sub nowrap" title="Charged / earned hours">
            {formatHours(section.charged_hours)} charged · {formatHours(section.earned_hours)} earned
          </span>
        </span>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        dense
        exportName={`shift-${section.job_number}-operations`}
        emptyMessage="No operations with activity"
        rowClassName={(r) => (r.kind === 'operator' ? `row-sub${r.operator.visitor ? ' row-visitor' : ''}` : undefined)}
      />
    </Panel>
  );
}
