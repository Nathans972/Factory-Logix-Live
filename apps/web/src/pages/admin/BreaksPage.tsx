/** Breaks admin (spec 10.3): plant-wide unpaid breaks removed from charged minutes. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BreakDef, BreakWrite } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { formatDays } from '../../lib/format';
import { Banner, Button, DataTable, Modal, PageHeader, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, Flash, useFlash } from './components/common';
import { BreakForm } from './components/BreakForm';

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
    { key: 'to', header: 'Effective to', render: (b) => b.effective_to ?? <span className="muted">—</span>, value: (b) => b.effective_to ?? '' },
    {
      key: 'actions',
      header: '',
      sortable: false,
      render: (b) => (
        <span className="row-actions">
          <Button
            size="sm"
            onClick={() => {
              updateM.reset();
              setEditing(b);
            }}
          >
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(b)}>
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
        subtitle="Break minutes are removed from every overlapping operator window."
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
      <Banner kind="info">
        Example: “Afternoon break”, 14:00, 15 minutes, Mon–Fri, all shifts — the 14:00 hour charges 45 minutes instead
        of 60 for everyone whose window overlaps it.
      </Banner>

      {breaksQ.isError && <ApiError error={breaksQ.error} />}
      {breaksQ.isLoading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={breaksQ.data ?? []}
          rowKey={(b) => b.id}
          exportName="breaks"
          defaultSort={{ key: 'start', dir: 'asc' }}
          emptyMessage="No breaks defined yet."
        />
      )}

      <Modal open={adding} title="Add break" onClose={() => setAdding(false)}>
        <BreakForm
          shifts={shifts}
          onSubmit={(v) => createM.mutate(v)}
          onCancel={() => setAdding(false)}
          submitting={createM.isPending}
          error={createM.error}
        />
      </Modal>

      <Modal open={!!editing} title={`Edit ${editing?.name ?? ''}`} onClose={() => setEditing(null)}>
        {editing && (
          <BreakForm
            key={editing.id}
            initial={editing}
            shifts={shifts}
            onSubmit={(v) => updateM.mutate({ id: editing.id, req: v })}
            onCancel={() => setEditing(null)}
            submitting={updateM.isPending}
            error={updateM.error}
          />
        )}
      </Modal>

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
