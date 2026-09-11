/** Audit log (spec 10.9 / 14): every write is recorded with before/after state. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditEntry } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime } from '../../lib/format';
import { Button, Card, CardHeader, DataTable, PageHeader, Spinner, type Column } from '../../ui';
import { AdminOnly, ApiError, safeJson } from './components/common';

const PAGE_SIZE = 50;

export function AuditPage() {
  return (
    <AdminOnly title="Audit log">
      <AuditPageInner />
    </AdminOnly>
  );
}

function AuditPageInner() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const [offset, setOffset] = useState(0);

  const auditQ = useQuery({
    queryKey: ['audit', PAGE_SIZE, offset],
    queryFn: () => ds.audit(PAGE_SIZE, offset),
  });

  const entries = auditQ.data?.entries ?? [];
  const total = auditQ.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + entries.length;

  const columns: Column<AuditEntry>[] = [
    { key: 'at', header: 'At', width: 170, render: (e) => formatDateTime(e.at, tz), value: (e) => e.at },
    {
      key: 'user',
      header: 'User',
      width: 140,
      render: (e) => e.username ?? <span className="dim">system</span>,
      value: (e) => e.username ?? '',
    },
    { key: 'action', header: 'Action', width: 110, render: (e) => e.action },
    { key: 'entity', header: 'Entity', width: 140, render: (e) => e.entity },
    {
      key: 'entity_id',
      header: 'Entity id',
      render: (e) => (e.entity_id ? <span className="mono">{e.entity_id}</span> : <span className="dim">—</span>),
      value: (e) => e.entity_id ?? '',
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle={`${total} recorded change${total === 1 ? '' : 's'} · Who changed what, and what the value was before and after.`}
      />

      {auditQ.isError && <ApiError error={auditQ.error} />}

      <Card>
        {auditQ.isLoading ? (
          <>
            <CardHeader title="Changes" />
            <div className="card-body">
              <Spinner />
            </div>
          </>
        ) : (
          <DataTable
            title={
              <>
                Changes
                <span className="card-sub">
                  {total === 0 ? 'Nothing recorded yet' : `Showing ${from}–${to} of ${total}`}
                </span>
              </>
            }
            toolbar={
              <span className="pager">
                <Button
                  size="sm"
                  disabled={offset === 0 || auditQ.isFetching}
                  onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                >
                  ← Prev
                </Button>
                <Button
                  size="sm"
                  disabled={to >= total || auditQ.isFetching}
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                >
                  Next →
                </Button>
              </span>
            }
            columns={columns}
            rows={entries}
            rowKey={(e) => e.id}
            exportName="audit"
            emptyMessage="No audit entries."
            dense
            renderSubRows={(e) => (
              <tr className="dt-subrow" key={`${e.id}-detail`}>
                <td colSpan={columns.length}>
                  <div className="audit-diff">
                    <div>
                      <h4>Before</h4>
                      <pre className="json-block">{e.before == null ? '(none)' : safeJson(e.before)}</pre>
                    </div>
                    <div>
                      <h4>After</h4>
                      <pre className="json-block">{e.after == null ? '(none)' : safeJson(e.after)}</pre>
                    </div>
                  </div>
                </td>
              </tr>
            )}
          />
        )}
      </Card>
    </>
  );
}
