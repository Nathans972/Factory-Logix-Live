/**
 * Product standards (spec 9.6, docs/DESIGN.md "Product standards").
 *
 * One row per route operation: computed value + sample, median, FactoryLogix value, the active
 * adjustment and override, and the bold effective value with its provenance. Managers can adjust,
 * override and recompute; every write takes a required note (audited).
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProductOperationRow, StandardAdjustment, StandardOverride, StdProvenance } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { hasRole, useAuth } from '../../auth/AuthContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  Breadcrumbs,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Modal,
  Note,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  type Column,
} from '../../ui';
import { intText, shortDate } from './components/HourlyGrid';

type ModalKind = 'adjust' | 'override';

/** The one word under the effective value (docs/DESIGN.md "Product standards"). */
const PROVENANCE_WORD: Record<StdProvenance, string> = {
  override_product_operation: 'override',
  override_product: 'override',
  adjusted: 'adjusted',
  base_computed: 'computed',
  base_fl: 'FL fallback',
  none: 'none',
};

const DAY = 24 * 60 * 60 * 1000;

function stdHr(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(2);
}

function percentText(a: StandardAdjustment): string {
  return (a.percent > 0 ? '+' : '') + a.percent + '%';
}

function scopeText(scope: string, operation: string | null): string {
  if (scope === 'global') return 'every product';
  if (scope === 'product') return 'whole product';
  if (scope === 'operation') return 'operation ' + (operation ?? '');
  return operation ?? 'one operation';
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
        : await run(() => ds.createOverride(z, { scope, product_number: z, operation: op, std_hr: Number(stdHrValue), note: note.trim() }));
    if (ok) setModal(null);
  };

  // ---- header context ----------------------------------------------------
  const recomputedAt = (v?.rows ?? []).reduce<number | null>(
    (m, r) => (r.standard ? (m == null || r.standard.computed_at > m ? r.standard.computed_at : m) : m),
    null,
  );
  const lookbackDays = (v?.rows ?? []).reduce<number>((m, r) => {
    const s = r.standard;
    if (!s || s.sample_from == null || s.sample_to == null) return m;
    return Math.max(m, Math.round((s.sample_to - s.sample_from) / DAY));
  }, 0);

  const subtitleParts: string[] = [];
  if (v) subtitleParts.push(v.rows.length + ' route operations');
  if (recomputedAt != null) subtitleParts.push('Standards recomputed ' + formatDate(recomputedAt, tz));
  if (lookbackDays > 0) subtitleParts.push(lookbackDays + '-day sample');

  const columns: Column<ProductOperationRow>[] = [
    { key: 'operation', header: 'Operation', value: (r) => r.operation, render: (r) => r.operation },
    {
      key: 'base',
      header: 'Computed StdHr',
      align: 'right',
      value: (r) => r.standard?.computed_std_hr ?? null,
      render: (r) => (
        <span className="stack">
          <span>{stdHr(r.standard?.computed_std_hr)}</span>
          <small>
            {r.standard
              ? intText(r.standard.sample_units) +
                ' units · ' +
                r.standard.sample_operators +
                ' operators · ' +
                shortDate(r.standard.sample_from, tz) +
                ' – ' +
                shortDate(r.standard.sample_to, tz)
              : 'no sample'}
          </small>
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
          <span title={r.effective.adjustment.note ?? ''}>
            <StatusBadge tone="warn">{percentText(r.effective.adjustment)}</StatusBadge>
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
          <span title={r.effective.override.note ?? ''}>
            <StatusBadge tone="info">{r.effective.override.std_hr.toFixed(2)}</StatusBadge>
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'effective',
      header: 'Effective',
      align: 'right',
      value: (r) => r.effective.effective,
      render: (r) => (
        <span className="stack">
          <span className="eff-value">{stdHr(r.effective.effective)}</span>
          <small>{PROVENANCE_WORD[r.effective.provenance] ?? r.effective.provenance}</small>
        </span>
      ),
    },
    ...(isManager
      ? [
          {
            key: 'actions',
            header: '',
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
                    variant="danger"
                    disabled={busy}
                    title={'Clear the ' + r.effective.adjustment.scope + ' adjustment'}
                    onClick={() => void run(() => ds.deleteAdjustment(r.effective.adjustment!.id))}
                  >
                    Clear
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => openModal('override', r.operation)}>
                  Override
                </Button>
                {r.effective.override && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    title={'Clear the ' + r.effective.override.scope + ' override'}
                    onClick={() => void run(() => ds.deleteOverride(r.effective.override!.id))}
                  >
                    Clear override
                  </Button>
                )}
              </span>
            ),
          } as Column<ProductOperationRow>,
        ]
      : []),
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: 'Products', to: '/products' }, { label: z }]} />

      <PageHeader
        title={v?.product_name ? z + ' · ' + v.product_name : z}
        subtitle={v ? subtitleParts.join(' · ') : 'Loading…'}
        actions={
          isManager && (
            <>
              <Button onClick={() => openModal('adjust', null)}>Adjust product</Button>
              <Button onClick={() => openModal('override', null)}>Override product</Button>
              <Button variant="primary" loading={busy} onClick={() => void run(() => ds.recomputeProduct(z))}>
                Recompute now
              </Button>
            </>
          )
        }
      />

      {error && modal == null && <Note tone="error">{error}</Note>}
      {view.isError && <ErrorBox error={view.error} />}
      {!v && !view.isError && <Spinner />}

      {v && (
        <>
          <DataTable
            title={
              <>
                Standards by operation <span className="card-sub">Effective = override, else base × adjustment</span>
              </>
            }
            toolbar={
              <>
                <StatusBadge tone="neutral">Computed</StatusBadge>
                <StatusBadge tone="warn">Adjusted</StatusBadge>
                <StatusBadge tone="info">Override</StatusBadge>
              </>
            }
            columns={columns}
            rows={v.rows}
            rowKey={(r) => r.operation}
            exportName={'product-' + z + '-standards'}
            emptyMessage="No operations on this product's route"
          />

          <div className="pair2">
            <Card>
              <CardHeader title="Active adjustments" subtitle="most specific wins, no stacking" />
              {v.adjustments.length === 0 ? (
                <EmptyState title="No adjustments in scope" hint="A percentage adjustment nudges the computed standard." />
              ) : (
                v.adjustments.map((a: StandardAdjustment) => (
                  <div className="list-item" key={a.id}>
                    <StatusBadge tone="warn">{percentText(a)}</StatusBadge>
                    <div className="list-main">
                      <b>{a.operation ?? v.product_name ?? z}</b>
                      <small>
                        {scopeText(a.scope, a.operation) +
                          (a.created_by ? ' · by ' + a.created_by : '') +
                          ' · ' +
                          formatDateTime(a.created_at, tz) +
                          (a.note ? ' · “' + a.note + '”' : '')}
                      </small>
                    </div>
                    {isManager && (
                      <div className="right-actions">
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => ds.deleteAdjustment(a.id))}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </Card>

            <Card>
              <CardHeader title="Active overrides" subtitle="replace everything else" />
              {v.overrides.length === 0 ? (
                <EmptyState title="No overrides" hint="An override pins the standard to a fixed StdHr." />
              ) : (
                v.overrides.map((o: StandardOverride) => (
                  <div className="list-item" key={o.id}>
                    <StatusBadge tone="info">{o.std_hr.toFixed(2)}</StatusBadge>
                    <div className="list-main">
                      <b>{o.operation ?? v.product_name ?? z}</b>
                      <small>
                        {scopeText(o.scope, o.operation) +
                          (o.created_by ? ' · by ' + o.created_by : '') +
                          ' · ' +
                          formatDateTime(o.created_at, tz) +
                          (o.note ? ' · “' + o.note + '”' : '')}
                      </small>
                    </div>
                    {isManager && (
                      <div className="right-actions">
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => void run(() => ds.deleteOverride(o.id))}>
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </Card>
          </div>
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
        {error && <Note tone="error">{error}</Note>}
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
