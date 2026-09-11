/** Searchable job list (spec 9.5). */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { JobListItem } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime } from '../../lib/format';
import { Checkbox, DataTable, ErrorBox, Input, PageHeader, Spinner, type Column } from '../../ui';
import { ProgressBar } from './components/ProgressBar';
import { useDebounced } from './components/useDebounced';

export function JobsPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const [text, setText] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);
  const q = useDebounced(text);

  const { data, isError, error } = useQuery({
    queryKey: ['jobs', q, activeOnly],
    queryFn: () => ds.jobs(q || undefined, activeOnly),
    placeholderData: keepPreviousData,
  });

  const columns: Column<JobListItem>[] = [
    {
      key: 'job',
      header: 'Job',
      value: (r) => r.job_number,
      render: (r) => <Link to={`/jobs/${encodeURIComponent(r.job_number)}`}>{r.job_number}</Link>,
    },
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => <Link to={`/products/${encodeURIComponent(r.product_number)}`}>{r.product_number}</Link>,
    },
    { key: 'name', header: 'Product name', value: (r) => r.product_name, render: (r) => r.product_name ?? '—' },
    {
      key: 'qty',
      header: 'Complete / Released',
      align: 'right',
      value: (r) => r.qty_complete_effective,
      render: (r) => `${r.qty_complete_effective} / ${r.qty_released}`,
    },
    { key: 'progress', header: 'Progress', value: (r) => r.progress, render: (r) => <ProgressBar value={r.progress} /> },
    { key: 'status', header: 'Status', value: (r) => r.status ?? (r.active ? 'active' : ''), render: (r) => r.status ?? (r.active ? 'active' : '—') },
    { key: 'last', header: 'Last activity', value: (r) => r.last_activity_at, render: (r) => formatDateTime(r.last_activity_at, tz) },
  ];

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle={data ? `${data.jobs.length} jobs` : 'Loading…'}
        actions={<Checkbox label="Active only" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />}
      />
      {isError && <ErrorBox error={error} />}
      {!data && !isError && <Spinner />}
      {data && (
        <DataTable
          columns={columns}
          rows={data.jobs}
          rowKey={(r) => r.job_number}
          exportName="jobs"
          defaultSort={{ key: 'last', dir: 'desc' }}
          emptyMessage="No jobs match"
          toolbar={<Input className="search-box" placeholder="Search jobs…" value={text} onChange={(e) => setText(e.target.value)} />}
        />
      )}
    </>
  );
}
