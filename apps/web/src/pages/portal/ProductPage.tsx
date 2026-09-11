/** Product standards view with manager adjustments/overrides (spec 9.6). */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProductOperationRow, StandardAdjustment, StandardOverride } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  Button,
  DataTable,
  Empty,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  type Column,
} from '../../ui';

type ModalKind = 'adjust' | 'override';

const PROVENANCE_LABEL: Record<string, string> = {
  override_product_operation: 'override (operation)',
  override_product: 'override (product)',
  adjusted: 'adjusted',
  base_computed: 'computed',
  base_fl: 'FactoryLogix',
  none: 'none',
};

function stdHr(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(2);
}

export function ProductPage() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const { user } = useAuth();
  const isManager = hasRole(user, 'manager');
  const { z = '' } = useParams();

  const view = useQuery({ queryKey: ['productView', z], queryFn: () => ds.productView(z) });

  const [modal, setModal] = useState<ModalKind | null>(null);
  const [scope, setScope] = useState<'product' | 'product_operation'>('product');
  const [operation, setOperation] = useState<string>('');
  const [percent, setPercent] = useState('0');
  const [stdHrValue, setStdHrValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const v = view.data;

  const openModal = (kind: ModalKind, op: string | null) => {
    setModal(kind);
    setScope(op ? 'product_operation' : 'product');
    setOperation(op ?? v?.rows[0]?.operation ?? '');
    setPercent('0');
    setStdHrValue('');
    setNote('');
    setError(null);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['productView', z] });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The action failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitModal = async () => {
    if (!note.trim()) {
      setError('A note is required.');
      return;
    }
    const op = scope === 'product_operation' ? operation : null;
    const ok =
      modal === 'adjust'
        ? await run(() =>
            ds.createProductAdjustment(z, { scope, product_number: z, operation: op, percent: Number(percent), note: note.trim() }),
          )
        : await run(() =>
            ds.createOverride(z, { scope, product_number: z, operation: op, std_hr: Number(stdHrValue), note: note.trim() }),
          );
    if (ok) setModal(null);
  };

  const columns: Column<ProductOperationRow>[] = [
    { key: 'operation', header: 'Operation', value: (r) => r.operation, render: (r) => r.operation },
    {
      key: 'base',
      header: 'Base computed',
      align: 'right',
      value: (r) => r.standard?.computed_std_hr ?? null,
      render: (r) => (
        <span className="stack">
          <span>{stdHr(r.standard?.computed_std_hr)}</span>
          <span className="sub">
            {r.standard
              ? `${r.standard.sample_units} units · ${r.standard.sample_operators} ops · ${formatDate(r.standard.sample_from, tz)} – ${formatDate(r.standard.sample_to, tz)}`
              : 'no sample'}
          </span>
        </span>
      ),
    },
    {
      key: 'median',
      header: 'Median min/unit',
      align: 'right',
      value: (r) => r.standard?.median_minutes_per_unit ?? null,
      render: (r) => (r.standard?.median_minutes_per_unit == null ? '—' : r.standard.median_minutes_per_unit.toFixed(2)),
    },
    { key: 'fl', header: 'FL StdHr', align: 'right', value: (r) => r.standard?.fl_std_hr ?? null, render: (r) => stdHr(r.standard?.fl_std_hr) },
    {
      key: 'adjustment',
      header: 'Adjustment',
      align: 'right',
      value: (r) => r.effective.adjustment?.percent ?? null,
      render: (r) =>
        r.effective.adjustment ? (
          <span className="stack" title={r.effective.adjustment.note ?? ''}>
            <span>
              {r.effective.adjustment.percent > 0 ? '+' : ''}
              {r.effective.adjustment.percent}%
            </span>
            <span className="sub">{r.effective.adjustment.scope}</span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'override',
      header: 'Override',
      align: 'right',
      value: (r) => r.effective.override?.std_hr ?? null,
      render: (r) =>
        r.effective.override ? (
          <span className="stack" title={r.effective.override.note ?? ''}>
            <span>{r.effective.override.std_hr.toFixed(2)}</span>
            <span className="sub">{r.effective.override.scope}</span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'effective',
      header: 'Effective StdHr',
      align: 'right',
      value: (r) => r.effective.effective,
      render: (r) => (
        <span className="stack">
          <span className="bold">{stdHr(r.effective.effective)}</span>
          <span className="sub">{PROVENANCE_LABEL[r.effective.provenance] ?? r.effective.provenance}</span>
        </span>
      ),
    },
    {
      key: 'computed_at',
      header: 'Computed',
      value: (r) => r.standard?.computed_at ?? null,
      render: (r) => formatDateTime(r.standard?.computed_at ?? null, tz),
    },
    ...(isManager
      ? [
          {
            key: 'actions',
            header: 'Actions',
            sortable: false,
            value: () => '',
            render: (r: ProductOperationRow) => (
              <span className="actions">
                <Button size="sm" variant="ghost" onClick={() => openModal('adjust', r.operation)}>
                  Adjust
                </Button>
                {r.effective.adjustment && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title={`Clear the ${r.effective.adjustment.scope} adjustment`}
                    onClick={() => void run(() => ds.deleteAdjustment(r.effective.adjustment!.id))}
                  >
                    Clear adj.
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => openModal('override', r.operation)}>
                  Override
                </Button>
                {r.effective.override && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    title={`Clear the ${r.effective.override.scope} override`}
                    onClick={() => void run(() => ds.deleteOverride(r.effective.override!.id))}
                  >
                    Clear ovr.
                  </Button>
                )}
              </span>
            ),
          } as Column<ProductOperationRow>,
        ]
      : []),
  ];

  const adjustmentColumns: Column<StandardAdjustment>[] = [
    { key: 'scope', header: 'Scope', render: (a) => a.scope },
    { key: 'operation', header: 'Operation', value: (a) => a.operation, render: (a) => a.operation ?? '(all)' },
    { key: 'percent', header: 'Percent', align: 'right', value: (a) => a.percent, render: (a) => `${a.percent > 0 ? '+' : ''}${a.percent}%` },
    { key: 'note', header: 'Note', value: (a) => a.note, render: (a) => a.note ?? '' },
    { key: 'by', header: 'Created', value: (a) => a.created_at, render: (a) => `${formatDateTime(a.created_at, tz)}${a.created_by ? ` · ${a.created_by}` : ''}` },
    ...(isManager
      ? [
          {
            key: 'delete',
            header: '',
            sortable: false,
            value: () => '',
            render: (a: StandardAdjustment) => (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => ds.deleteAdjustment(a.id))}>
                Delete
              </Button>
            ),
          } as Column<StandardAdjustment>,
        ]
      : []),
  ];

  const overrideColumns: Column<StandardOverride>[] = [
    { key: 'scope', header: 'Scope', render: (o) => o.scope },
    { key: 'operation', header: 'Operation', value: (o) => o.operation, render: (o) => o.operation ?? '(all)' },
    { key: 'std', header: 'StdHr', align: 'right', value: (o) => o.std_hr, render: (o) => o.std_hr.toFixed(2) },
    { key: 'note', header: 'Note', value: (o) => o.note, render: (o) => o.note ?? '' },
    { key: 'by', header: 'Created', value: (o) => o.created_at, render: (o) => `${formatDateTime(o.created_at, tz)}${o.created_by ? ` · ${o.created_by}` : ''}` },
    ...(isManager
      ? [
          {
            key: 'delete',
            header: '',
            sortable: false,
            value: () => '',
            render: (o: StandardOverride) => (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => ds.deleteOverride(o.id))}>
                Delete
              </Button>
            ),
          } as Column<StandardOverride>,
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={v?.product_name ?? z}
        subtitle={v ? `${v.product_number} · ${v.rows.length} operations` : 'Loading…'}
        actions={
          isManager && (
            <>
              <Button size="sm" onClick={() => openModal('adjust', null)}>
                Adjust product
              </Button>
              <Button size="sm" onClick={() => openModal('override', null)}>
                Override product
              </Button>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void run(() => ds.recomputeProduct(z))}>
                Recompute now
              </Button>
            </>
          )
        }
      />

      {error && <ErrorBox error={error} />}
      {view.isError && <ErrorBox error={view.error} />}
      {!v && !view.isError && <Spinner />}

      {v && (
        <>
          <DataTable
            title="Route operations"
            columns={columns}
            rows={v.rows}
            rowKey={(r) => r.operation}
            exportName={`product-${z}-standards`}
            emptyMessage="No operations on this product's route"
          />

          <Panel title="Active adjustments">
            {v.adjustments.length === 0 ? (
              <Empty>No adjustments in scope.</Empty>
            ) : (
              <DataTable columns={adjustmentColumns} rows={v.adjustments} rowKey={(a) => a.id} exportName={`product-${z}-adjustments`} dense />
            )}
          </Panel>

          <Panel title="Active overrides">
            {v.overrides.length === 0 ? (
              <Empty>No overrides.</Empty>
            ) : (
              <DataTable columns={overrideColumns} rows={v.overrides} rowKey={(o) => o.id} exportName={`product-${z}-overrides`} dense />
            )}
          </Panel>
        </>
      )}

      <Modal
        open={modal != null}
        title={modal === 'adjust' ? 'Percentage adjustment' : 'Hard override'}
        onClose={() => setModal(null)}
        footer={
          <>
            <Button onClick={() => setModal(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void submitModal()}>
              Save
            </Button>
          </>
        }
      >
        {error && <div className="inline-err mb">{error}</div>}
        <Field label="Scope">
          <Select value={scope} onChange={(e) => setScope(e.target.value as 'product' | 'product_operation')}>
            <option value="product">Whole product ({z})</option>
            <option value="product_operation">One operation</option>
          </Select>
        </Field>
        {scope === 'product_operation' && (
          <Field label="Operation">
            <Select value={operation} onChange={(e) => setOperation(e.target.value)}>
              {(v?.rows ?? []).map((r) => (
                <option key={r.operation} value={r.operation}>
                  {r.operation}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {modal === 'adjust' ? (
          <Field label="Percent" hint="Positive raises the standard (e.g. +20), negative lowers it.">
            <Input type="number" step="1" value={percent} onChange={(e) => setPercent(e.target.value)} />
          </Field>
        ) : (
          <Field label="StdHr" hint="Units per hour at standard.">
            <Input type="number" step="0.01" min="0" value={stdHrValue} onChange={(e) => setStdHrValue(e.target.value)} />
          </Field>
        )}
        <Field label="Note (required)" hint="Stored in the audit log.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
