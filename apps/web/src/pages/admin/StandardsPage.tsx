/**
 * Global standards admin (spec 10.5). Readable and usable by managers as well as admins.
 * Product-level overrides are managed on the product page; they are listed here read-only.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateAdjustmentRequest, SettingsPatch, StandardAdjustment, StandardOverride } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime, formatNum, relativeMinutes } from '../../lib/format';
import {
  Button,
  Card,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  PageHeader,
  type Column,
} from '../../ui';
import { ApiError, ConfirmModal, Flash, SectionCard, useFlash } from './components/common';
import { SettingsForm, type SettingsGroup } from './components/SettingsForm';

const COMPUTATION_GROUP: SettingsGroup = {
  title: 'Computation settings',
  subtitle: 'How the base standard is derived from history.',
  fields: [
    { key: 'std_lookback_days', label: 'Lookback (days)', kind: 'int', min: 1, max: 3650, hint: 'History window used to compute a standard.' },
    { key: 'std_min_units', label: 'Minimum units', kind: 'int', min: 1, hint: 'Below this the computed standard is not trusted.' },
    { key: 'std_min_operators', label: 'Minimum operators', kind: 'int', min: 1 },
    { key: 'std_max_unit_minutes', label: 'Max unit minutes', kind: 'number', min: 1, hint: 'Units slower than this are treated as outliers.' },
    { key: 'session_gap_minutes', label: 'Session gap (minutes)', kind: 'number', min: 0, hint: 'A gap this long ends a working session.' },
    { key: 'std_recompute_time', label: 'Nightly recompute time', kind: 'time', hint: 'Plant local.' },
  ],
};

function percentText(p: number): string {
  return `${p > 0 ? '+' : ''}${formatNum(p, p % 1 === 0 ? 0 : 1)}%`;
}

export function StandardsPage() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const flash = useFlash();

  const adminQ = useQuery({ queryKey: ['standardsAdmin'], queryFn: () => ds.standardsAdmin() });
  const settingsQ = useQuery({ queryKey: ['settings'], queryFn: () => ds.settings() });

  const [globalOpen, setGlobalOpen] = useState(false);
  const [opOpen, setOpOpen] = useState(false);
  const [deleting, setDeleting] = useState<StandardAdjustment | null>(null);
  const [confirmRecompute, setConfirmRecompute] = useState(false);

  const [gPercent, setGPercent] = useState('0');
  const [gNote, setGNote] = useState('');

  const [opName, setOpName] = useState('');
  const [opPercent, setOpPercent] = useState('0');
  const [opNote, setOpNote] = useState('');

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['standardsAdmin'] });
  };

  const createM = useMutation({
    mutationFn: (req: CreateAdjustmentRequest) => ds.createGlobalAdjustment(req),
    onSuccess: (_r, req) => {
      invalidate();
      if (req.scope === 'operation') {
        setOpOpen(false);
        setOpName('');
        setOpPercent('0');
        setOpNote('');
      } else setGlobalOpen(false);
      flash.show('Adjustment saved.');
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: number) => ds.deleteGlobalAdjustment(id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      flash.show('Adjustment removed.');
    },
  });

  const recomputeM = useMutation({
    mutationFn: () => ds.recomputeStandards({}),
    onSuccess: () => {
      invalidate();
      setConfirmRecompute(false);
      flash.show('Recompute started.');
    },
  });

  const saveSettingsM = useMutation({
    mutationFn: (patch: SettingsPatch) => ds.updateSettings(patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      flash.show('Standard settings saved.');
    },
  });

  const adjustments = adminQ.data?.adjustments ?? [];
  const globalAdj = adjustments.find((a) => a.scope === 'global') ?? null;
  const opAdjustments = adjustments.filter((a) => a.scope === 'operation');
  const overrides = adminQ.data?.overrides ?? [];
  const operations = adminQ.data?.operations ?? [];
  const lastRecompute = adminQ.data?.last_recompute_at ?? null;

  const validPercent = (v: string) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= -90 && n <= 300;
  };
  const validNote = (v: string) => v.trim().length > 0 && v.trim().length <= 500;

  const adjColumns: Column<StandardAdjustment>[] = [
    { key: 'operation', header: 'Operation', render: (a) => a.operation ?? '—', value: (a) => a.operation ?? '' },
    {
      key: 'percent',
      header: 'Adjustment',
      align: 'right',
      width: 120,
      render: (a) => <span className={`chip ${a.percent >= 0 ? 'chip-blue' : 'chip-amber'}`}>{percentText(a.percent)}</span>,
      value: (a) => a.percent,
    },
    { key: 'note', header: 'Note', render: (a) => a.note ?? <span className="dim">—</span>, value: (a) => a.note ?? '' },
    { key: 'by', header: 'By', render: (a) => a.created_by ?? '—', value: (a) => a.created_by ?? '' },
    { key: 'at', header: 'Created', render: (a) => formatDateTime(a.created_at, tz), value: (a) => a.created_at },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      render: (a) => (
        <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDeleting(a)}>
          Remove
        </Button>
      ),
    },
  ];

  const overrideColumns: Column<StandardOverride>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (o) => (
        <Link className="link" to={`/products/${encodeURIComponent(o.product_number)}`}>
          {o.product_number}
        </Link>
      ),
      value: (o) => o.product_number,
    },
    {
      key: 'operation',
      header: 'Operation',
      render: (o) => o.operation ?? <span className="dim">all operations</span>,
      value: (o) => o.operation ?? '',
    },
    { key: 'std', header: 'StdHr', align: 'right', width: 100, render: (o) => formatNum(o.std_hr, 2), value: (o) => o.std_hr },
    { key: 'note', header: 'Note', render: (o) => o.note ?? <span className="dim">—</span>, value: (o) => o.note ?? '' },
    { key: 'by', header: 'By', render: (o) => o.created_by ?? '—', value: (o) => o.created_by ?? '' },
    { key: 'at', header: 'Created', render: (o) => formatDateTime(o.created_at, tz), value: (o) => o.created_at },
  ];

  const openGlobal = () => {
    setGPercent(globalAdj ? String(globalAdj.percent) : '0');
    setGNote('');
    createM.reset();
    setGlobalOpen(true);
  };

  return (
    <>
      <PageHeader
        title="Standards"
        subtitle={`${adjustments.length} active adjustment${adjustments.length === 1 ? '' : 's'} · ${overrides.length} override${overrides.length === 1 ? '' : 's'} · Last recompute ${lastRecompute ? relativeMinutes(lastRecompute, Date.now()) : 'never'}`}
        actions={
          <Button variant="primary" onClick={() => setConfirmRecompute(true)}>
            Recompute all standards
          </Button>
        }
      />

      <Flash message={flash.message} />
      {adminQ.isError && <ApiError error={adminQ.error} />}
      {adminQ.isLoading && <Spinner />}

      <SectionCard
        title="Global adjustment"
        subtitle="Applied on top of every computed standard, below any product override."
        badges={globalAdj ? <span className="chip chip-blue">{percentText(globalAdj.percent)}</span> : undefined}
        actions={
          globalAdj ? (
            <>
              <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDeleting(globalAdj)}>
                Remove
              </Button>
              <Button size="sm" onClick={openGlobal}>
                Change
              </Button>
            </>
          ) : undefined
        }
      >
        {globalAdj ? (
          <p className="muted">
            {globalAdj.note ?? 'No note'} · set by {globalAdj.created_by ?? 'unknown'} ·{' '}
            {formatDateTime(globalAdj.created_at, tz)}
          </p>
        ) : (
          <EmptyState
            title="No global adjustment"
            hint="Every standard is used exactly as computed. A positive percent raises the target units per hour everywhere; a negative percent lowers it."
            action={
              <Button size="sm" onClick={openGlobal}>
                Set adjustment
              </Button>
            }
          />
        )}
      </SectionCard>

      <Card>
        <DataTable
          title="Per-operation adjustments"
          columns={adjColumns}
          rows={opAdjustments}
          rowKey={(a) => a.id}
          exportName="operation-adjustments"
          emptyMessage="No per-operation adjustments."
          dense
          toolbar={
            <Button
              size="sm"
              onClick={() => {
                createM.reset();
                setOpOpen(true);
              }}
            >
              Add adjustment
            </Button>
          }
        />
      </Card>

      <Card>
        <DataTable
          title="Active overrides"
          columns={overrideColumns}
          rows={overrides.filter((o) => o.active)}
          rowKey={(o) => o.id}
          exportName="standard-overrides"
          emptyMessage="No overrides. Overrides are set on a product page and replace the computed standard entirely."
          dense
        />
      </Card>

      {settingsQ.isError && <ApiError error={settingsQ.error} />}
      {settingsQ.isLoading && <Spinner />}
      {settingsQ.data && (
        <SettingsForm
          settings={settingsQ.data.settings}
          groups={[COMPUTATION_GROUP]}
          onSave={(patch) => saveSettingsM.mutate(patch)}
          saving={saveSettingsM.isPending}
          error={saveSettingsM.error}
        />
      )}

      {/* ---------------- Global adjustment drawer ---------------- */}
      <Drawer
        open={globalOpen}
        title="Global adjustment"
        onClose={() => setGlobalOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setGlobalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="global-adj-form"
              loading={createM.isPending && createM.variables?.scope === 'global'}
              disabled={!validPercent(gPercent) || !validNote(gNote)}
            >
              Save adjustment
            </Button>
          </>
        }
      >
        <form
          id="global-adj-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validPercent(gPercent) || !validNote(gNote)) return;
            createM.mutate({ scope: 'global', percent: Number(gPercent), note: gNote.trim() });
          }}
        >
          {createM.isError && createM.variables?.scope === 'global' && <ApiError error={createM.error} />}
          <Field
            label="Percent"
            hint="+20 makes every standard 20% harder; -10 makes it 10% easier."
            error={gPercent && !validPercent(gPercent) ? '-90 to 300' : undefined}
          >
            <Input
              type="number"
              step={1}
              min={-90}
              max={300}
              autoFocus
              value={gPercent}
              onChange={(e) => setGPercent(e.currentTarget.value)}
            />
          </Field>
          <Field label="Note (required)" hint="Recorded in the audit log.">
            <Input value={gNote} maxLength={500} onChange={(e) => setGNote(e.currentTarget.value)} placeholder="Why?" />
          </Field>
        </form>
      </Drawer>

      {/* ---------------- Per-operation adjustment drawer ---------------- */}
      <Drawer
        open={opOpen}
        title="Add operation adjustment"
        onClose={() => setOpOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="op-adj-form"
              loading={createM.isPending && createM.variables?.scope === 'operation'}
              disabled={!opName || !validPercent(opPercent) || !validNote(opNote)}
            >
              Add adjustment
            </Button>
          </>
        }
      >
        <form
          id="op-adj-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!opName || !validPercent(opPercent) || !validNote(opNote)) return;
            createM.mutate({ scope: 'operation', operation: opName, percent: Number(opPercent), note: opNote.trim() });
          }}
        >
          {createM.isError && createM.variables?.scope === 'operation' && <ApiError error={createM.error} />}
          <Field label="Operation">
            <Select value={opName} autoFocus onChange={(e) => setOpName(e.currentTarget.value)}>
              <option value="">— pick an operation —</option>
              {operations.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Percent" error={opPercent && !validPercent(opPercent) ? '-90 to 300' : undefined}>
            <Input
              type="number"
              step={1}
              min={-90}
              max={300}
              value={opPercent}
              onChange={(e) => setOpPercent(e.currentTarget.value)}
            />
          </Field>
          <Field label="Note (required)" hint="Recorded in the audit log.">
            <Input value={opNote} maxLength={500} onChange={(e) => setOpNote(e.currentTarget.value)} placeholder="Why?" />
          </Field>
        </form>
      </Drawer>

      <ConfirmModal
        open={!!deleting}
        title="Remove adjustment"
        danger
        confirmLabel="Remove"
        busy={deleteM.isPending}
        error={deleteM.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteM.mutate(deleting.id)}
        body={<p>Remove the {deleting?.scope === 'global' ? 'global' : `“${deleting?.operation}”`} adjustment?</p>}
      />

      <ConfirmModal
        open={confirmRecompute}
        title="Recompute all standards"
        confirmLabel="Recompute"
        busy={recomputeM.isPending}
        error={recomputeM.error}
        onClose={() => setConfirmRecompute(false)}
        onConfirm={() => recomputeM.mutate()}
        body={
          <p>
            Recompute the base standard for every product and operation from the last{' '}
            {settingsQ.data?.settings.std_lookback_days ?? '—'} days. This can take a while on a large history.
          </p>
        }
      />
    </>
  );
}
