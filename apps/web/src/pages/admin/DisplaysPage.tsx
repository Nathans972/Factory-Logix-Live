/** Displays admin (spec 10.1): claim a TV, edit its settings, re-pair it, delete it. */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimDisplayRequest, Display, UpdateDisplayRequest } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime, relativeMinutes } from '../../lib/format';
import { Button, Checkbox, DataTable, Field, Input, Modal, PageHeader, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, Flash, OnlineBadge, useFlash } from './components/common';
import { JobPicker } from './components/JobPicker';

interface DisplayFormState {
  pairing_code: string;
  name: string;
  job_number: string | null;
  group_operators: boolean;
  show_std_day: boolean;
  shift_length_hours: string;
  show_gauge: boolean;
}

function emptyForm(): DisplayFormState {
  return {
    pairing_code: '',
    name: '',
    job_number: null,
    group_operators: false,
    show_std_day: true,
    shift_length_hours: '12',
    show_gauge: true,
  };
}

function formFor(d: Display): DisplayFormState {
  return {
    pairing_code: d.pairing_code,
    name: d.name ?? '',
    job_number: d.job_number,
    group_operators: d.group_operators,
    show_std_day: d.show_std_day,
    shift_length_hours: String(d.shift_length_hours),
    show_gauge: d.show_gauge,
  };
}

export function DisplaysPage() {
  return (
    <AdminOnly title="Displays">
      <DisplaysPageInner />
    </AdminOnly>
  );
}

function DisplaysPageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const tz = usePlantTz();
  const flash = useFlash();

  const displaysQ = useQuery({ queryKey: ['displays'], queryFn: () => ds.displays(), refetchInterval: 15_000 });
  useLiveRefetch(['display_updated']);

  const [claiming, setClaiming] = useState(false);
  const [editing, setEditing] = useState<Display | null>(null);
  const [repairing, setRepairing] = useState<Display | null>(null);
  const [deleting, setDeleting] = useState<Display | null>(null);
  const [form, setForm] = useState<DisplayFormState>(emptyForm());
  const [repairCode, setRepairCode] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['displays'] });

  const claimM = useMutation({
    mutationFn: (req: ClaimDisplayRequest) => ds.claimDisplay(req),
    onSuccess: (d) => {
      void invalidate();
      setClaiming(false);
      flash.show(`Claimed "${d.name ?? d.pairing_code}".`);
    },
  });

  const updateM = useMutation({
    mutationFn: (v: { id: number; req: UpdateDisplayRequest }) => ds.updateDisplay(v.id, v.req),
    onSuccess: () => {
      void invalidate();
      setEditing(null);
      flash.show('Display updated.');
    },
  });

  const repairM = useMutation({
    mutationFn: (v: { id: number; code: string }) => ds.repairDisplay(v.id, { pairing_code: v.code }),
    onSuccess: () => {
      void invalidate();
      setRepairing(null);
      flash.show('Display re-paired.');
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: number) => ds.deleteDisplay(id),
    onSuccess: () => {
      void invalidate();
      setDeleting(null);
      flash.show('Display deleted.');
    },
  });

  const openClaim = () => {
    setForm(emptyForm());
    claimM.reset();
    setClaiming(true);
  };

  const openEdit = (d: Display) => {
    setForm(formFor(d));
    updateM.reset();
    setEditing(d);
  };

  const openRepair = (d: Display) => {
    setRepairCode('');
    repairM.reset();
    setRepairing(d);
  };

  const now = Date.now();

  const columns: Column<Display>[] = [
    { key: 'name', header: 'Name', render: (d) => d.name ?? <span className="muted">(unnamed)</span>, value: (d) => d.name ?? '' },
    { key: 'code', header: 'Pairing code', render: (d) => <span className="mono">{d.pairing_code}</span>, value: (d) => d.pairing_code },
    {
      key: 'job',
      header: 'Assigned job',
      render: (d) => (d.job_number ? <Link to={`/jobs/${encodeURIComponent(d.job_number)}`}>{d.job_number}</Link> : <span className="muted">—</span>),
      value: (d) => d.job_number ?? '',
    },
    { key: 'mode', header: 'Mode', render: (d) => (d.group_operators ? 'Grouped' : 'Separate'), value: (d) => (d.group_operators ? 'Grouped' : 'Separate') },
    {
      key: 'flags',
      header: 'Options',
      render: (d) => (
        <span className="muted small">
          {d.show_std_day ? `StdDay ${d.shift_length_hours} h` : 'No StdDay'} · {d.show_gauge ? 'Gauge' : 'No gauge'}
        </span>
      ),
      value: (d) => `${d.show_std_day ? 'StdDay' : ''} ${d.show_gauge ? 'Gauge' : ''}`.trim(),
      sortable: false,
    },
    {
      key: 'last_seen',
      header: 'Last seen',
      render: (d) => <span title={formatDateTime(d.last_seen_at, tz)}>{relativeMinutes(d.last_seen_at, now)}</span>,
      value: (d) => d.last_seen_at ?? 0,
    },
    { key: 'online', header: 'Status', render: (d) => <OnlineBadge online={d.online} />, value: (d) => (d.online ? 1 : 0) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      render: (d) => (
        <span className="row-actions">
          <Button size="sm" onClick={() => openEdit(d)}>
            Edit
          </Button>
          <Button size="sm" onClick={() => openRepair(d)} title="Enter the new code shown on the TV">
            Re-pair
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(d)}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  const submitClaim = (e: FormEvent) => {
    e.preventDefault();
    claimM.mutate({
      pairing_code: form.pairing_code.trim(),
      name: form.name.trim(),
      job_number: form.job_number,
      group_operators: form.group_operators,
      show_std_day: form.show_std_day,
      show_gauge: form.show_gauge,
      shift_length_hours: Number(form.shift_length_hours),
    });
  };

  const submitEdit = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    updateM.mutate({
      id: editing.id,
      req: {
        name: form.name.trim(),
        job_number: form.job_number,
        group_operators: form.group_operators,
        show_std_day: form.show_std_day,
        show_gauge: form.show_gauge,
        shift_length_hours: Number(form.shift_length_hours),
      },
    });
  };

  const codeValid = /^\d{4}$/.test(form.pairing_code.trim());
  const nameValid = form.name.trim().length > 0 && form.name.trim().length <= 80;
  const hoursValid = Number(form.shift_length_hours) >= 1 && Number(form.shift_length_hours) <= 24;

  return (
    <>
      <PageHeader
        title="Displays"
        subtitle="Every TV shows a 4-digit pairing code until it is claimed here."
        actions={
          <Button variant="primary" onClick={openClaim}>
            Claim a TV
          </Button>
        }
      />

      <Flash message={flash.message} />
      {displaysQ.isError && <ApiError error={displaysQ.error} />}
      {displaysQ.isLoading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={displaysQ.data ?? []}
          rowKey={(d) => d.id}
          exportName="displays"
          defaultSort={{ key: 'name', dir: 'asc' }}
          emptyMessage="No displays claimed yet. Open /tv on a TV and claim the code it shows."
        />
      )}

      {/* Claim */}
      <Modal
        open={claiming}
        title="Claim a TV"
        onClose={() => setClaiming(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setClaiming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              form="claim-form"
              type="submit"
              loading={claimM.isPending}
              disabled={!codeValid || !nameValid || !hoursValid}
            >
              Claim
            </Button>
          </>
        }
      >
        <form id="claim-form" onSubmit={submitClaim}>
          {claimM.isError && <ApiError error={claimM.error} />}
          <Field label="Pairing code" hint="The 4-digit code shown on the TV." error={form.pairing_code && !codeValid ? 'Four digits' : undefined}>
            <Input
              className="mono"
              inputMode="numeric"
              maxLength={4}
              autoFocus
              value={form.pairing_code}
              onChange={(e) => setForm({ ...form, pairing_code: e.currentTarget.value.replace(/\D/g, '').slice(0, 4) })}
            />
          </Field>
          <DisplayFields form={form} setForm={setForm} />
        </form>
      </Modal>

      {/* Edit */}
      <Modal
        open={!!editing}
        title={`Edit ${editing?.name ?? editing?.pairing_code ?? ''}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" form="edit-form" type="submit" loading={updateM.isPending} disabled={!nameValid || !hoursValid}>
              Save
            </Button>
          </>
        }
      >
        <form id="edit-form" onSubmit={submitEdit}>
          {updateM.isError && <ApiError error={updateM.error} />}
          <DisplayFields form={form} setForm={setForm} />
        </form>
      </Modal>

      {/* Re-pair */}
      <Modal
        open={!!repairing}
        title={`Re-pair ${repairing?.name ?? ''}`}
        onClose={() => setRepairing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRepairing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={repairM.isPending}
              disabled={!/^\d{4}$/.test(repairCode)}
              onClick={() => repairing && repairM.mutate({ id: repairing.id, code: repairCode })}
            >
              Re-pair
            </Button>
          </>
        }
      >
        {repairM.isError && <ApiError error={repairM.error} />}
        <p className="muted">
          When a TV is replaced or its browser storage is cleared it shows a new pairing code. Enter that code to move
          this display’s settings to the new device.
        </p>
        <Field label="New pairing code">
          <Input
            className="mono"
            inputMode="numeric"
            maxLength={4}
            autoFocus
            value={repairCode}
            onChange={(e) => setRepairCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 4))}
          />
        </Field>
      </Modal>

      {/* Delete */}
      <ConfirmModal
        open={!!deleting}
        title="Delete display"
        danger
        confirmLabel="Delete"
        busy={deleteM.isPending}
        error={deleteM.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteM.mutate(deleting.id)}
        body={
          <p>
            Delete “{deleting?.name ?? deleting?.pairing_code}”? The TV will fall back to showing a pairing code. This
            cannot be undone.
          </p>
        }
      />
    </>
  );
}

function DisplayFields({ form, setForm }: { form: DisplayFormState; setForm: (f: DisplayFormState) => void }) {
  return (
    <>
      <Field label="Name" hint="Shown in the admin list and on the TV when no job is assigned.">
        <Input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
      </Field>

      <JobPicker value={form.job_number} onChange={(job_number) => setForm({ ...form, job_number })} />

      <div className="form-grid">
        <div className="field">
          <Checkbox
            label="Group operators by operation"
            checked={form.group_operators}
            onChange={(e) => setForm({ ...form, group_operators: e.currentTarget.checked })}
          />
          <span className="field-hint">One row per operation instead of one row per operator.</span>
        </div>
        <div className="field">
          <Checkbox
            label="Show the ring gauge"
            checked={form.show_gauge}
            onChange={(e) => setForm({ ...form, show_gauge: e.currentTarget.checked })}
          />
        </div>
        <div className="field">
          <Checkbox
            label="Show the StdDay column"
            checked={form.show_std_day}
            onChange={(e) => setForm({ ...form, show_std_day: e.currentTarget.checked })}
          />
        </div>
        <Field label="Shift length (hours)" hint="Used for the StdDay column.">
          <Input
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={form.shift_length_hours}
            disabled={!form.show_std_day}
            onChange={(e) => setForm({ ...form, shift_length_hours: e.currentTarget.value })}
          />
        </Field>
      </div>
    </>
  );
}
