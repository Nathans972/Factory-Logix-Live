/** Breaks admin (spec 10.3): plant-wide unpaid breaks removed from charged minutes. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BreakDef, BreakWrite } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { formatDays } from '../../lib/format';
import { Button, Card, DataTable, Drawer, Note, PageHeader, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, Flash, useFlash } from './components/common';
import { BreakForm } from './components/BreakForm';

const FORM_ID = 'break-form';

export function BreaksPage() {
  return (
    <AdminOnly title="Breaks">
      <BreaksPageInner />
    </AdminOnly>
  );
}

function BreaksPageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();

  const breaksQ = useQuery({ queryKey: ['breaks'], queryFn: () => ds.breaks() });
  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => ds.shifts() });
  const shifts = shiftsQ.data ?? [];

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BreakDef | null>(null);
  const [deleting, setDeleting] = useState<BreakDef | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['breaks'] });
    void qc.invalidateQueries({ queryKey: ['setupStatus'] });
  };

  const createM = useMutation({
    mutationFn: (v: BreakWrite) => ds.createBreak(v),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      flash.show('Break added.');
    },
  });

  const updateM = useMutation({
    mutationFn: (v: { id: number; req: BreakWrite }) => ds.updateBreak(v.id, v.req),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      flash.show('Break saved.');
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: number) => ds.deleteBreak(id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      flash.show('Break deleted.');
    },
  });

  const breaks = breaksQ.data ?? [];
  const totalMinutes = breaks.reduce((sum, b) => sum + b.duration_minutes, 0);

  const shiftNames = (b: BreakDef) =>
    b.shift_ids == null
      ? 'All shifts'
      : b.shift_ids.map((id) => shifts.find((s) => s.id === id)?.name ?? `#${id}`).join(', ') || '(none)';

  const columns: Column<BreakDef>[] = [
    { key: 'name', header: 'Name', render: (b) => b.name },
    { key: 'start', header: 'Start', render: (b) => b.start_local },
    { key: 'duration', header: 'Minutes', align: 'right', render: (b) => b.duration_minutes },
    { key: 'days', header: 'Days', render: (b) => formatDays(b.days_of_week), value: (b) => b.days_of_week.join(',') },
    { key: 'shifts', header: 'Applies to', render: (b) => shiftNames(b), value: (b) => shiftNames(b) },
    { key: 'from', header: 'Effective from', render: (b) => b.effective_from },
    {
      key: 'to',
      header: 'Effective to',
      render: (b) => b.effective_to ?? <span className="dim">—</span>,
      value: (b) => b.effective_to ?? '',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      render: (b) => (
        <span className="row-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              updateM.reset();
              setEditing(b);
            }}
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDeleting(b)}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Breaks"
        subtitle={`${breaks.length} break${breaks.length === 1 ? '' : 's'} · ${totalMinutes} unpaid minutes a day · Break minutes are removed from every overlapping operator window.`}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              createM.reset();
              setAdding(true);
            }}
          >
            Add break
          </Button>
        }
      />

      <Flash message={flash.message} />
      {breaksQ.isError && <ApiError error={breaksQ.error} />}

      <div className="mb">
        <Note tone="info" title="How a break is charged">
          “Afternoon break”, 14:00, 15 minutes, Mon–Fri, all shifts — the 14:00 hour charges 45 minutes instead of 60
          for everyone whose window overlaps it.
        </Note>
      </div>

      {breaksQ.isLoading ? (
        <Card>
          <div className="card-body">
            <Spinner />
          </div>
        </Card>
      ) : (
        <Card>
          <DataTable
            columns={columns}
            rows={breaks}
            rowKey={(b) => b.id}
            exportName="breaks"
            defaultSort={{ key: 'start', dir: 'asc' }}
            emptyMessage="No breaks defined yet."
          />
        </Card>
      )}

      <Drawer
        open={adding}
        title="Add break"
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={createM.isPending}>
              Add break
            </Button>
          </>
        }
      >
        <BreakForm id={FORM_ID} hideActions shifts={shifts} onSubmit={(v) => createM.mutate(v)} error={createM.error} />
      </Drawer>

      <Drawer
        open={!!editing}
        title={`Edit ${editing?.name ?? ''}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={updateM.isPending}>
              Save break
            </Button>
          </>
        }
      >
        {editing && (
          <BreakForm
            key={editing.id}
            id={FORM_ID}
            hideActions
            initial={editing}
            shifts={shifts}
            onSubmit={(v) => updateM.mutate({ id: editing.id, req: v })}
            error={updateM.error}
          />
        )}
      </Drawer>

      <ConfirmModal
        open={!!deleting}
        title="Delete break"
        danger
        confirmLabel="Delete"
        busy={deleteM.isPending}
        error={deleteM.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteM.mutate(deleting.id)}
        body={<p>Delete “{deleting?.name}”? Charged minutes are recalculated without it.</p>}
      />
    </>
  );
}
