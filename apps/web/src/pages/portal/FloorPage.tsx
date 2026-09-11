/** Floor overview — live, one row per operator working this hour (spec 9.3). */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FloorRow } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatTime } from '../../lib/format';
import { Checkbox, DataTable, ErrorBox, Input, PageHeader, PaceChip, Spinner, type Column } from '../../ui';

function haystack(r: FloorRow): string {
  return [r.operator_id, r.operator_name, r.job_number, r.product_number, r.product_name, r.operation].filter(Boolean).join(' ').toLowerCase();
}

export function FloorPage() {
  const ds = useDataSource();
  const tz = usePlantTz();
  const [params, setParams] = useSearchParams();
  const showVisitors = params.get('visitors') === '1';
  const [text, setText] = useState('');

  const { data, isError, error } = useQuery({
    queryKey: ['floor', showVisitors],
    queryFn: () => ds.floor(showVisitors),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  useLiveRefetch(['data_updated']);

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const needle = text.trim().toLowerCase();
    return needle ? all.filter((r) => haystack(r).includes(needle)) : all;
  }, [data, text]);

  const columns: Column<FloorRow>[] = [
    {
      key: 'operator',
      header: 'Operator',
      value: (r) => r.operator_name ?? r.operator_id,
      render: (r) => <Link to={`/operators/${encodeURIComponent(r.operator_id)}`}>{r.operator_name ?? r.operator_id}</Link>,
    },
    { key: 'job', header: 'Job', value: (r) => r.job_number, render: (r) => <Link to={`/jobs/${encodeURIComponent(r.job_number)}`}>{r.job_number}</Link> },
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => (
        <span className="stack">
          <Link to={`/products/${encodeURIComponent(r.product_number)}`}>{r.product_number}</Link>
          <span className="sub">{r.product_name ?? ''}</span>
        </span>
      ),
    },
    { key: 'operation', header: 'Operation', render: (r) => r.operation },
    { key: 'units_hour', header: 'Units this hour', align: 'right', render: (r) => r.units_hour },
    { key: 'pace', header: 'Pace', align: 'right', value: (r) => r.pace, render: (r) => <PaceChip pace={r.pace} color={r.color} /> },
    { key: 'units_12h', header: 'Units 12 h', align: 'right', render: (r) => r.units_12h },
    {
      key: 'since_scan',
      header: 'Min since scan',
      align: 'right',
      value: (r) => r.minutes_since_scan,
      render: (r) => (
        <span title={r.last_scan_at ? formatTime(r.last_scan_at, tz, true) : 'no scan'}>{r.minutes_since_scan == null ? '—' : Math.round(r.minutes_since_scan)}</span>
      ),
    },
    {
      key: 'flags',
      header: 'Flags',
      value: (r) => [r.idle_flag ? 'idle' : '', r.visitor ? 'visitor' : ''].filter(Boolean).join(' '),
      render: (r) => (
        <>
          {r.idle_flag && <span className="tag" title="No scan within the idle threshold">⚑ idle</span>}
          {r.visitor && <span className="tag">visitor</span>}
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Floor overview"
        subtitle={data ? `Hour starting ${formatTime(data.hour_start_utc, tz)} · ${rows.length} operators` : 'Loading…'}
        actions={
          <Checkbox
            label="Show visitors"
            checked={showVisitors}
            onChange={(e) =>
              setParams((prev) => {
                const next = new URLSearchParams(prev);
                if (e.target.checked) next.set('visitors', '1');
                else next.delete('visitors');
                return next;
              })
            }
          />
        }
      />

      {isError && <ErrorBox error={error} />}
      {!data && !isError && <Spinner />}
      {data && (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.operator_id}|${r.job_number}|${r.operation}`}
          exportName="floor-overview"
          emptyMessage="Nobody is scanning right now"
          rowClassName={(r) => [r.idle_flag ? 'row-flag' : '', r.visitor ? 'row-visitor' : ''].filter(Boolean).join(' ') || undefined}
          toolbar={<Input className="search-box" placeholder="Filter…" value={text} onChange={(e) => setText(e.target.value)} />}
        />
      )}
    </>
  );
}
