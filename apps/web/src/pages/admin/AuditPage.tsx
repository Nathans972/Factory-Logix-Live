/** Audit log (spec 10.9 / 14): every write is recorded with before/after state. */
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime } from '../../lib/format';
import { Button, PageHeader, Panel, Spinner } from '../../ui';
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
  const [expanded, setExpanded] = useState<number | null>(null);

  const auditQ = useQuery({
    queryKey: ['audit', PAGE_SIZE, offset],
    queryFn: () => ds.audit(PAGE_SIZE, offset),
  });

  const entries = auditQ.data?.entries ?? [];
  const total = auditQ.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + entries.length;

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, and what the value was before and after." />

      {auditQ.isError && <ApiError error={auditQ.error} />}

      <Panel
        title={`Entries ${from}–${to} of ${total}`}
        actions={
          <span className="pager">
            <Button size="sm" disabled={offset === 0 || auditQ.isFetching} onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}>
              ← Prev
            </Button>
            <Button size="sm" disabled={to >= total || auditQ.isFetching} onClick={() => setOffset((o) => o + PAGE_SIZE)}>
              Next →
            </Button>
          </span>
        }
      >
        {auditQ.isLoading ? (
          <Spinner />
        ) : (
          <div className="dt">
            <div className="dt-scroll">
              <table className="dt-table dt-dense">
                <thead>
                  <tr>
                    <th style={{ width: 28 }} />
                    <th>At</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>Entity id</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && (
                    <tr>
                      <td colSpan={6} className="dt-empty">
                        No audit entries.
                      </td>
                    </tr>
                  )}
                  {entries.map((e) => (
                    <Fragment key={e.id}>
                      <tr>
                        <td>
                          <button
                            className="expander-btn"
                            aria-expanded={expanded === e.id}
                            aria-label={expanded === e.id ? 'Hide details' : 'Show details'}
                            onClick={() => setExpanded((x) => (x === e.id ? null : e.id))}
                          >
                            {expanded === e.id ? '▾' : '▸'}
                          </button>
                        </td>
                        <td>{formatDateTime(e.at, tz)}</td>
                        <td>{e.username ?? <span className="muted">system</span>}</td>
                        <td>{e.action}</td>
                        <td>{e.entity}</td>
                        <td className="mono">{e.entity_id ?? '—'}</td>
                      </tr>
                      {expanded === e.id && (
                        <tr className="audit-detail">
                          <td colSpan={6}>
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
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Panel>
    </>
  );
}
