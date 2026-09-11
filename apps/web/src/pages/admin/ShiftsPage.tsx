/** Shifts admin (spec 10.2): plant-wide shift definitions with effective-date versioning. */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ShiftDef, ShiftWrite } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { formatDays } from '../../lib/format';
import { Button, Card, DataTable, Drawer, PageHeader, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, ConfirmModal, Flash, useFlash } from './components/common';
import { ShiftForm, crossesMidnight } from './components/ShiftForm';

const FORM_ID = 'shift-form';

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

  const shifts = shiftsQ.data ?? [];
  const current = shifts.filter((s) => !s.effective_to).length;

  const columns: Column<ShiftDef>[] = [
    { key: 'name', header: 'Name', render: (s) => s.name },
    {
      key: 'time',
      header: 'Start – end',
      render: (s) => (
        <>
          {s.start_local} – {s.end_local}
          {crossesMidnight(s.start_local, s.end_local) && <small>ends the next day</small>}
        </>
      ),
      value: (s) => s.start_local,
    },
    { key: 'days', header: 'Days', render: (s) => formatDays(s.days_of_week), value: (s) => s.days_of_week.join(',') },
    { key: 'from', header: 'Effective from', render: (s) => s.effective_from },
    {
      key: 'to',
      header: 'Effective to',
      render: (s) => s.effective_to ?? <span className="dim">—</span>,
      value: (s) => s.effective_to ?? '',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      sortable: false,
      render: (s) => (
        <span className="row-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              updateM.reset();
              setEditing(s);
            }}
          >
            Edit
          </Button>
          <Button size="sm" variant="ghost" className="btn-danger-text" onClick={() => setDeleting(s)}>
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
        subtitle={`${shifts.length} definition${shifts.length === 1 ? '' : 's'} · ${current} currently in effect · Shift instances drive the shift view, StdDay and break expansion.`}
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
      {shiftsQ.isError && <ApiError error={shiftsQ.error} />}

      {shiftsQ.isLoading ? (
        <Card>
          <div className="card-body">
            <Spinner />
          </div>
        </Card>
      ) : (
        <Card>
          <DataTable
            columns={columns}
            rows={shifts}
            rowKey={(s) => s.id}
            exportName="shifts"
            defaultSort={{ key: 'time', dir: 'asc' }}
            emptyMessage="No shifts defined yet."
          />
        </Card>
      )}

      <Drawer
        open={adding}
        title="Add shift"
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={createM.isPending}>
              Add shift
            </Button>
          </>
        }
      >
        <ShiftForm id={FORM_ID} hideActions onSubmit={(v) => createM.mutate(v)} error={createM.error} />
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
              Save shift
            </Button>
          </>
        }
      >
        {editing && (
          <ShiftForm
            key={editing.id}
            id={FORM_ID}
            hideActions
            initial={editing}
            onSubmit={(v) => updateM.mutate({ id: editing.id, req: v })}
            error={updateM.error}
          />
        )}
      </Drawer>

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
