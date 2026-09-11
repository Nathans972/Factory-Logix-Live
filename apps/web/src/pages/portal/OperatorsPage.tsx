/** Searchable operator list (spec 9.4). */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { OperatorListItem } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime } from '../../lib/format';
import { DataTable, ErrorBox, Input, PageHeader, Spinner, type Column } from '../../ui';
import { useDebounced } from './components/useDebounced';

export function OperatorsPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const [text, setText] = useState('');
  const q = useDebounced(text);

  const { data, isError, error } = useQuery({
    queryKey: ['operators', q],
    queryFn: () => ds.operators(q || undefined),
    placeholderData: keepPreviousData,
  });

  const columns: Column<OperatorListItem>[] = [
    {
      key: 'id',
      header: 'Operator ID',
      value: (r) => r.operator_id,
      render: (r) => <Link to={`/operators/${encodeURIComponent(r.operator_id)}`}>{r.operator_id}</Link>,
    },
    { key: 'name', header: 'Display name', value: (r) => r.display_name, render: (r) => r.display_name ?? '—' },
    { key: 'last_seen', header: 'Last seen', value: (r) => r.last_seen_at, render: (r) => formatDateTime(r.last_seen_at, tz) },
  ];

  return (
    <>
      <PageHeader title="Operators" subtitle={data ? `${data.length} operators` : 'Loading…'} />
      {isError && <ErrorBox error={error} />}
      {!data && !isError && <Spinner />}
      {data && (
        <DataTable
          columns={columns}
          rows={data}
          rowKey={(r) => r.operator_id}
          exportName="operators"
          defaultSort={{ key: 'last_seen', dir: 'desc' }}
          emptyMessage="No operators match"
          toolbar={<Input className="search-box" placeholder="Search operators…" value={text} onChange={(e) => setText(e.target.value)} />}
        />
      )}
    </>
  );
}
