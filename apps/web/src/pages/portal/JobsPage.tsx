/** Searchable job list (spec 9.5). `?q=` is shared with the top-bar search box. */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { JobListItem } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { relativeMinutes } from '../../lib/format';
import { DataTable, ErrorBox, Input, PageHeader, ProgressBar, Segmented, Spinner, StatusBadge, type Column } from '../../ui';
import { intText } from './components/HourlyGrid';
import { useDebounced } from './components/useDebounced';

const CLOSED_RE = /clos|complet|cancel/i;

export function JobsPage() {
  const ds = useDataSource();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const activeOnly = params.get('active') !== '0';

  const [text, setText] = useState(urlQ);
  const q = useDebounced(text);

  // The top bar navigates to /jobs?q=… — keep the input in sync with the URL both ways.
  useEffect(() => setText(urlQ), [urlQ]);
  useEffect(() => {
    if (q === urlQ) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q) next.set('q', q);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const { data, isError, error } = useQuery({
    queryKey: ['jobs', q, activeOnly],
    queryFn: () => ds.jobs(q || undefined, activeOnly),
    placeholderData: keepPreviousData,
  });

  const now = Date.now();

  const columns: Column<JobListItem>[] = [
    {
      key: 'job',
      header: 'Job',
      value: (r) => r.job_number,
      render: (r) => (
        <Link className="link" to={'/jobs/' + encodeURIComponent(r.job_number)}>
          {r.job_number}
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => (
        <Link className="link" to={'/products/' + encodeURIComponent(r.product_number)}>
          {r.product_number}
        </Link>
      ),
    },
    { key: 'name', header: 'Product name', value: (r) => r.product_name, render: (r) => r.product_name ?? '—' },
    {
      key: 'qty',
      header: 'Qty complete',
      align: 'right',
      value: (r) => r.qty_complete_effective,
      render: (r) => (
        <span className="qty-cell">
          <span>
            {intText(r.qty_complete_effective)} <span className="kpi-den">/ {intText(r.qty_released)}</span>
          </span>
          <ProgressBar value={r.progress} width={90} />
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status ?? (r.active ? 'In process' : 'Closed'),
      render: (r) => {
        const closed = r.status ? CLOSED_RE.test(r.status) : !r.active;
        return <StatusBadge tone={closed ? 'off' : 'ok'}>{closed ? 'Closed' : (r.status ?? 'In process')}</StatusBadge>;
      },
    },
    {
      key: 'last',
      header: 'Last activity',
      align: 'right',
      value: (r) => r.last_activity_at,
      render: (r) => relativeMinutes(r.last_activity_at, now),
    },
  ];

  return (
    <>
      <PageHeader title="Jobs" subtitle={data ? data.jobs.length + (activeOnly ? ' active jobs' : ' jobs') : 'Loading…'} />

      <div className="filter-bar">
        <Input className="search-box" placeholder="Search job, product or name…" value={text} onChange={(e) => setText(e.target.value)} />
        <Segmented
          value={activeOnly ? 'active' : 'all'}
          onChange={(v) =>
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                if (v === 'all') next.set('active', '0');
                else next.delete('active');
                return next;
              },
              { replace: true },
            )
          }
          options={[
            { value: 'active', label: 'Active' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      {isError && <ErrorBox error={error} />}
      {!data && !isError && <Spinner />}
      {data && (
        <DataTable
          title="Jobs"
          columns={columns}
          rows={data.jobs}
          rowKey={(r) => r.job_number}
          exportName="jobs"
          defaultSort={{ key: 'last', dir: 'desc' }}
          emptyMessage="No jobs match"
        />
      )}
    </>
  );
}
