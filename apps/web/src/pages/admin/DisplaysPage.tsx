/**
 * Displays admin (spec 10.1) — list + 440 px drawer, matching docs/design/admin-displays.html:
 * claim a TV by its 4-digit code, edit its settings, re-pair it, delete it.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClaimDisplayRequest, Display, JobListItem, UpdateDisplayRequest } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { downloadCsv } from '../../lib/csv';
import { formatDateTime, relativeMinutes, shortDate } from '../../lib/format';
import {
  Button,
  Card,
  CodeInput,
  DataTable,
  Drawer,
  Field,
  Input,
  PageHeader,
  Segmented,
  Spinner,
  StatusBadge,
  Switch,
  type Column,
} from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, FieldBlock, Flash, useFlash } from './components/common';
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

function optionsText(d: Display): string {
  return [d.show_std_day ? 'StdDay' : 'No StdDay', `${d.shift_length_hours} h`, d.show_gauge ? 'Gauge' : 'No gauge'].join(
    ' · ',
  );
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
  const jobsQ = useQuery({ queryKey: ['jobs', null, 'displays'], queryFn: () => ds.jobs(), staleTime: 60_000 });
  useLiveRefetch(['display_updated']);

  const [claiming, setClaiming] = useState(false);
  const [editing, setEditing] = useState<Display | null>(null);
  const [repairing, setRepairing] = useState<Display | null>(null);
  const [deleting, setDeleting] = useState<Display | null>(null);
  const [form, setForm] = useState<DisplayFormState>(emptyForm());
  const [repairCode, setRepairCode] = useState('');
  const [touched, setTouched] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['displays'] });

  const claimM = useMutation({
    mutationFn: (req: ClaimDisplayRequest) => ds.claimDisplay(req),
    onSuccess: (d) => {
      void invalidate();
      setClaiming(false);
      flash.show(`Claimed “${d.name ?? d.pairing_code}”.`);
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

  // Claimed displays first (by name), unclaimed at the bottom — the reference ordering.
  const displays = useMemo(() => {
    const all = displaysQ.data ?? [];
    return [...all].sort((a, b) => {
      const ac = a.claimed_at == null ? 1 : 0;
      const bc = b.claimed_at == null ? 1 : 0;
      if (ac !== bc) return ac - bc;
      return (a.name ?? a.pairing_code).localeCompare(b.name ?? b.pairing_code, undefined, { numeric: true });
    });
  }, [displaysQ.data]);
  const jobsByNumber = useMemo(() => {
    const m = new Map<string, JobListItem>();
    for (const j of jobsQ.data?.jobs ?? []) m.set(j.job_number, j);
    return m;
  }, [jobsQ.data]);

  const now = Date.now();
  const online = displays.filter((d) => d.online).length;
  const unclaimed = displays.filter((d) => d.claimed_at == null);

  const openClaim = (prefill?: Display) => {
    setForm(prefill ? { ...emptyForm(), pairing_code: prefill.pairing_code } : emptyForm());
    setTouched(false);
    claimM.reset();
    setClaiming(true);
  };

  const openEdit = (d: Display) => {
    setForm(formFor(d));
    setTouched(false);
    updateM.reset();
    setEditing(d);
  };

  const openRepair = (d: Display) => {
    setRepairCode('');
    repairM.reset();
    setRepairing(d);
  };

  const columns: Column<Display>[] = [
    {
      key: 'online',
      header: 'Status',
      width: 110,
      render: (d) => <StatusBadge tone={d.online ? 'ok' : 'off'}>{d.online ? 'Online' : 'Offline'}</StatusBadge>,
      value: (d) => (d.online ? 'Online' : 'Offline'),
    },
    {
      key: 'name',
      header: 'Name',
      render: (d) =>
        d.name ? (
          <>
            {d.name}
            <small>Claimed {shortDate(d.claimed_at, tz)}</small>
          </>
        ) : (
          <span className="dim">
            (unclaimed)
            <small>Registered {relativeMinutes(d.created_at, now)}</small>
          </span>
        ),
      value: (d) => d.name ?? '',
    },
    {
      key: 'code',
      header: 'Pairing code',
      width: 130,
      render: (d) => <span className="mono-chip">{d.pairing_code}</span>,
      value: (d) => d.pairing_code,
    },
    {
      key: 'job',
      header: 'Assigned job',
      render: (d) => {
        if (!d.job_number) return <span className="dim">—</span>;
        const j = jobsByNumber.get(d.job_number);
        return (
          <>
            <Link className="link" to={`/jobs/${encodeURIComponent(d.job_number)}`}>
              {d.job_number}
            </Link>
            {j && (
              <small>
                {j.product_number}
                {j.product_name ? ` · ${j.product_name}` : ''}
              </small>
            )}
          </>
        );
      },
      value: (d) => d.job_number ?? '',
    },
    {
      key: 'mode',
      header: 'Mode',
      width: 120,
      render: (d) =>
        d.claimed_at == null ? (
          <span className="dim">—</span>
        ) : (
          <span className={`badge ${d.group_operators ? 'badge-info' : 'badge-neutral'}`}>
            {d.group_operators ? 'Grouped' : 'Per operator'}
          </span>
        ),
      value: (d) => (d.group_operators ? 'Grouped' : 'Per operator'),
    },
    {
      key: 'flags',
      header: 'Options',
      sortable: false,
      render: (d) => (d.claimed_at == null ? null : <small>{optionsText(d)}</small>),
      value: (d) => (d.claimed_at == null ? '' : optionsText(d)),
    },
    {
      key: 'last_seen',
      header: 'Last seen',
      align: 'right',
      width: 120,
      render: (d) => <span title={formatDateTime(d.last_seen_at, tz)}>{relativeMinutes(d.last_seen_at, now)}</span>,
      value: (d) => d.last_seen_at ?? 0,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      render: (d) => (
        <span className="row-actions">
          {d.claimed_at == null ? (
            <Button size="sm" onClick={() => openClaim(d)}>
              Claim
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => openEdit(d)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openRepair(d)} title="Enter the new code shown on the TV">
                Re-pair
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDeleting(d)}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  const exportCsv = () =>
    downloadCsv(
      'displays',
      columns.filter((c) => c.key !== 'actions').map((c) => ({ header: c.header, value: (d: Display) => c.value?.(d) ?? '' })),
      displays,
    );

  const codeValid = /^\d{4}$/.test(form.pairing_code);
  const nameValid = form.name.trim().length > 0 && form.name.trim().length <= 80;
  const hoursValid = Number(form.shift_length_hours) >= 1 && Number(form.shift_length_hours) <= 24;

  const matched = unclaimed.find((d) => d.pairing_code === form.pairing_code);
  const codeNote = !codeValid
    ? undefined
    : matched
      ? { ok: true, text: `Found: unclaimed display registered ${relativeMinutes(matched.created_at, now)}.` }
      : { ok: false, text: 'No unclaimed display is showing that code right now. Check the TV and try again.' };

  const submitClaim = () => {
    setTouched(true);
    if (!codeValid || !nameValid || !hoursValid) return;
    claimM.mutate({
      pairing_code: form.pairing_code,
      name: form.name.trim(),
      job_number: form.job_number,
      group_operators: form.group_operators,
      show_std_day: form.show_std_day,
      show_gauge: form.show_gauge,
      shift_length_hours: Number(form.shift_length_hours),
    });
  };

  const submitEdit = () => {
    setTouched(true);
    if (!editing || !nameValid || !hoursValid) return;
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

  return (
    <>
      <PageHeader
        title="Displays"
        subtitle={`${displays.length} display${displays.length === 1 ? '' : 's'} · ${online} online · Every TV shows a 4-digit pairing code until it is claimed here.`}
        actions={
          <>
            <Button onClick={exportCsv} disabled={displays.length === 0}>
              Export CSV
            </Button>
            <Button variant="primary" onClick={() => openClaim()}>
              Claim a TV
            </Button>
          </>
        }
      />

      <Flash message={flash.message} />
      {displaysQ.isError && <ApiError error={displaysQ.error} />}

      {displaysQ.isLoading ? (
        <Card>
          <div className="card-body">
            <Spinner />
          </div>
        </Card>
      ) : (
        <Card>
          <DataTable
            columns={columns}
            rows={displays}
            rowKey={(d) => d.id}
            emptyMessage="No displays yet. Open /tv on a TV and claim the code it shows."
          />
        </Card>
      )}

      {/* ---------------- Claim drawer ---------------- */}
      <Drawer
        open={claiming}
        title="Claim a TV"
        onClose={() => setClaiming(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setClaiming(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={claimM.isPending} onClick={submitClaim}>
              Claim display
            </Button>
          </>
        }
      >
        {claimM.isError && <ApiError error={claimM.error} title="Could not claim this TV" />}

        <FieldBlock
          label="Pairing code shown on the TV"
          hint={codeNote?.ok ? codeNote.text : undefined}
          error={touched && !codeValid ? 'Enter the four digits shown on the TV' : codeNote && !codeNote.ok ? codeNote.text : undefined}
        >
          <CodeInput
            value={form.pairing_code}
            onChange={(v) => setForm({ ...form, pairing_code: v })}
            autoFocus={claiming}
            invalid={touched && !codeValid}
          />
        </FieldBlock>

        <DisplayFields form={form} setForm={setForm} showNameError={touched && !nameValid} />
      </Drawer>

      {/* ---------------- Edit drawer ---------------- */}
      <Drawer
        open={!!editing}
        title={editing?.name ?? 'Edit display'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" loading={updateM.isPending} onClick={submitEdit}>
              Save changes
            </Button>
          </>
        }
      >
        {updateM.isError && <ApiError error={updateM.error} title="Could not save this display" />}
        <DisplayFields form={form} setForm={setForm} showNameError={touched && !nameValid} />
      </Drawer>

      {/* ---------------- Re-pair drawer ---------------- */}
      <Drawer
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
        {repairM.isError && <ApiError error={repairM.error} title="Could not re-pair" />}
        <p className="muted">
          When a TV is replaced, or its browser storage is cleared, it shows a new pairing code. Enter that code to move
          this display’s settings to the new device.
        </p>
        <FieldBlock label="New pairing code">
          <CodeInput value={repairCode} onChange={setRepairCode} autoFocus={!!repairing} />
        </FieldBlock>
      </Drawer>

      {/* ---------------- Delete ---------------- */}
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
            Delete “{deleting?.name ?? deleting?.pairing_code}”? The TV falls back to showing a pairing code. This
            cannot be undone.
          </p>
        }
      />
    </>
  );
}

/** The shared part of the claim and edit drawers (everything except the pairing code). */
function DisplayFields({
  form,
  setForm,
  showNameError,
}: {
  form: DisplayFormState;
  setForm: (f: DisplayFormState) => void;
  showNameError?: boolean;
}) {
  return (
    <>
      <Field
        label="Display name"
        hint="Shown in this list and on the TV when no job is assigned."
        error={showNameError ? 'Required' : undefined}
      >
        <Input
          value={form.name}
          maxLength={80}
          placeholder="Line 5 - Rework Bench"
          onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
        />
      </Field>

      <JobPicker value={form.job_number} onChange={(job_number) => setForm({ ...form, job_number })} />

      <FieldBlock label="Operator rows">
        <Segmented
          value={form.group_operators ? 'grouped' : 'separate'}
          onChange={(v) => setForm({ ...form, group_operators: v === 'grouped' })}
          options={[
            { value: 'separate', label: 'Per operator' },
            { value: 'grouped', label: 'Grouped by operation' },
          ]}
          full
        />
      </FieldBlock>

      <Switch
        checked={form.show_std_day}
        onChange={(v) => setForm({ ...form, show_std_day: v })}
        label="Show StdDay column"
        hint={`StdHr × ${form.shift_length_hours || '12'} h shift length`}
      />
      {form.show_std_day && (
        <Field label="Shift length (hours)" hint="Used for the StdDay column only.">
          <Input
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={form.shift_length_hours}
            onChange={(e) => setForm({ ...form, shift_length_hours: e.currentTarget.value })}
          />
        </Field>
      )}

      <Switch
        checked={form.show_gauge}
        onChange={(v) => setForm({ ...form, show_gauge: v })}
        label="Show progress gauge"
        hint="Qty complete ÷ qty released"
      />
    </>
  );
}
