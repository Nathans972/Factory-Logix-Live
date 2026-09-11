/** Shifts admin (spec 10.2): plant-wide shift definitions with effective-date versioning. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShiftDef, ShiftWrite } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { formatDays } from '../../lib/format';
import { Banner, Button, DataTable, Modal, PageHeader, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, Flash, useFlash } from './components/common';
import { ShiftForm, crossesMidnight } from './components/ShiftForm';

export function ShiftsPage() {
  return (
    <AdminOnly title="Shifts">
      <ShiftsPageInner />
    </AdminOnly>
  );
}

function ShiftsPageInner() {
  const ds = useDataSource();
  const qc = useQueryClient();
  const flash = useFlash();

  const shiftsQ = useQuery({ queryKey: ['shifts'], queryFn: () => ds.shifts() });

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ShiftDef | null>(null);
  const [deleting, setDeleting] = useState<ShiftDef | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['shifts'] });
    void qc.invalidateQueries({ queryKey: ['setupStatus'] });
  };

  const createM = useMutation({
    mutationFn: (v: ShiftWrite) => ds.createShift(v),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      flash.show('Shift added.');
    },
  });

  const updateM = useMutation({
    mutationFn: (v: { id: number; req: ShiftWrite }) => ds.updateShift(v.id, v.req),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      flash.show('Shift saved as a new version.');
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: number) => ds.deleteShift(id),
    onSuccess: () => {
      invalidate();
      setDeleting(null);
      flash.show('Shift deleted.');
    },
  });

  const columns: Column<ShiftDef>[] = [
    { key: 'name', header: 'Name', render: (s) => s.name },
    {
      key: 'time',
      header: 'Start – end',
      render: (s) => (
        <>
          {s.start_local} – {s.end_local}
          {crossesMidnight(s.start_local, s.end_local) && <span className="muted small"> (next day)</span>}
        </>
      ),
      value: (s) => s.start_local,
    },
    { key: 'days', header: 'Days', render: (s) => formatDays(s.days_of_week), value: (s) => s.days_of_week.join(',') },
    { key: 'from', header: 'Effective from', render: (s) => s.effective_from },
    { key: 'to', header: 'Effective to', render: (s) => s.effective_to ?? <span className="muted">—</span>, value: (s) => s.effective_to ?? '' },
    {
      key: 'actions',
      header: '',
      sortable: false,
      render: (s) => (
        <span className="row-actions">
          <Button
            size="sm"
            onClick={() => {
              updateM.reset();
              setEditing(s);
            }}
          >
            Edit
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDeleting(s)}>
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Shifts"
        subtitle="Plant-wide. Shift instances drive the shift view, StdDay and break expansion."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              createM.reset();
              setAdding(true);
            }}
          >
            Add shift
          </Button>
        }
      />

      <Flash message={flash.message} />
      <Banner kind="info">
        Editing a shift creates a new version from its effective-from date. Days already recorded keep the definition
        that was in effect then. Overlapping shifts on the same day are rejected by the server.
      </Banner>

      {shiftsQ.isError && <ApiError error={shiftsQ.error} />}
      {shiftsQ.isLoading ? (
        <Spinner />
      ) : (
        <DataTable
          columns={columns}
          rows={shiftsQ.data ?? []}
          rowKey={(s) => s.id}
          exportName="shifts"
          defaultSort={{ key: 'time', dir: 'asc' }}
          emptyMessage="No shifts defined yet."
        />
      )}

      <Modal open={adding} title="Add shift" onClose={() => setAdding(false)}>
        <ShiftForm
          onSubmit={(v) => createM.mutate(v)}
          onCancel={() => setAdding(false)}
          submitting={createM.isPending}
          error={createM.error}
        />
      </Modal>

      <Modal open={!!editing} title={`Edit ${editing?.name ?? ''}`} onClose={() => setEditing(null)}>
        {editing && (
          <ShiftForm
            key={editing.id}
            initial={editing}
            onSubmit={(v) => updateM.mutate({ id: editing.id, req: v })}
            onCancel={() => setEditing(null)}
            submitting={updateM.isPending}
            error={updateM.error}
          />
        )}
      </Modal>

      <ConfirmModal
        open={!!deleting}
        title="Delete shift"
        danger
        confirmLabel="Delete"
        busy={deleteM.isPending}
        error={deleteM.error}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteM.mutate(deleting.id)}
        body={<p>Delete “{deleting?.name}”? Historical shift instances that used it are recalculated without it.</p>}
      />
    </>
  );
}
