/** Floor overview — live, one row per operator working this hour (spec 9.3). */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FloorRow } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatTime, relativeMinutes } from '../../lib/format';
import {
  Avatar,
  Button,
  Card,
  CardHeader,
  DataTable,
  ErrorBox,
  Input,
  KpiRow,
  KpiTile,
  PaceChip,
  PageHeader,
  Spinner,
  StatusBadge,
  Switch,
  type Column,
} from '../../ui';
import { downloadCsv, type CsvColumn } from '../../lib/csv';
import { formatUnits } from './components/numbers';

/** Engine default; the floor page does not pull the (admin-gated) settings document just for a label. */
const IDLE_FLAG_MINUTES = 15;

function haystack(r: FloorRow): string {
  return [r.operator_id, r.operator_name, r.job_number, r.product_number, r.product_name, r.operation].filter(Boolean).join(' ').toLowerCase();
}

function statusBadge(r: FloorRow) {
  if (r.visitor) return <StatusBadge tone="neutral">Visitor</StatusBadge>;
  if (r.idle_flag) return <StatusBadge tone="warn">Idle {r.minutes_since_scan == null ? '' : `${Math.round(r.minutes_since_scan)} min`}</StatusBadge>;
  return <StatusBadge tone="ok">Working</StatusBadge>;
}

const CSV_COLUMNS: CsvColumn<FloorRow>[] = [
  { header: 'Operator', value: (r) => r.operator_name ?? r.operator_id },
  { header: 'Operator ID', value: (r) => r.operator_id },
  { header: 'Job', value: (r) => r.job_number },
  { header: 'Product', value: (r) => r.product_number },
  { header: 'Product name', value: (r) => r.product_name },
  { header: 'Operation', value: (r) => r.operation },
  { header: 'Units this hour', value: (r) => r.units_hour },
  { header: 'Pace', value: (r) => (r.pace == null ? '' : `${Math.round(r.pace * 100)}%`) },
  { header: 'Units 12 h', value: (r) => r.units_12h },
  { header: 'Minutes since scan', value: (r) => (r.minutes_since_scan == null ? '' : Math.round(r.minutes_since_scan)) },
  { header: 'Status', value: (r) => (r.visitor ? 'Visitor' : r.idle_flag ? 'Idle' : 'Working') },
];

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

  const all = useMemo(() => data?.rows ?? [], [data]);

  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return needle ? all.filter((r) => haystack(r).includes(needle)) : all;
  }, [all, text]);

  const now = data?.generated_at ?? Date.now();
  const idle = all.filter((r) => r.idle_flag).length;
  const onPace = all.filter((r) => r.color === 'green' || r.color === 'blue').length;
  const behind = all.filter((r) => r.color === 'yellow').length;
  const wellBehind = all.filter((r) => r.color === 'red').length;
  const unitsHour = all.reduce((sum, r) => sum + r.units_hour, 0);
  const jobs = new Set(all.map((r) => r.job_number)).size;

  const columns: Column<FloorRow>[] = [
    {
      key: 'operator',
      header: 'Operator',
      value: (r) => r.operator_name ?? r.operator_id,
      render: (r) => (
        <span className="person">
          <Avatar name={r.operator_name ?? r.operator_id} />
          <span>
            <Link className="link" to={`/operators/${encodeURIComponent(r.operator_id)}`}>
              {r.operator_name ?? r.operator_id}
            </Link>
            <small>{r.operator_id}</small>
          </span>
        </span>
      ),
    },
    {
      key: 'job',
      header: 'Job',
      value: (r) => r.job_number,
      render: (r) => (
        <Link className="link" to={`/jobs/${encodeURIComponent(r.job_number)}`}>
          {r.job_number}
        </Link>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      value: (r) => r.product_number,
      render: (r) => (
        <span>
          <Link className="link" to={`/products/${encodeURIComponent(r.product_number)}`}>
            {r.product_number}
          </Link>
          {r.product_name && <small>{r.product_name}</small>}
        </span>
      ),
    },
    { key: 'operation', header: 'Operation', render: (r) => r.operation },
    { key: 'units_hour', header: 'Units this hour', align: 'right', value: (r) => r.units_hour, render: (r) => formatUnits(r.units_hour) },
    { key: 'pace', header: 'Pace', align: 'right', value: (r) => r.pace, render: (r) => <PaceChip pace={r.pace} color={r.color} /> },
    { key: 'units_12h', header: 'Last 12 h', align: 'right', value: (r) => r.units_12h, render: (r) => formatUnits(r.units_12h) },
    {
      key: 'since_scan',
      header: 'Last scan',
      align: 'right',
      value: (r) => r.minutes_since_scan,
      render: (r) => (
        <span title={r.last_scan_at ? formatTime(r.last_scan_at, tz, true) : 'no scan'}>{relativeMinutes(r.last_scan_at, now)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => (r.visitor ? 'Visitor' : r.idle_flag ? 'Idle' : 'Working'),
      render: statusBadge,
    },
  ];

  return (
    <>
      <PageHeader
        title="Floor overview"
        subtitle={
          data ? (
            <>
              Hour starting {formatTime(data.hour_start_utc, tz)} · {all.length} operator{all.length === 1 ? '' : 's'} on the floor
              {idle > 0 && (
                <>
                  {' · '}
                  <b className="shift-state warn">
                    {idle} idle
                  </b>
                </>
              )}
            </>
          ) : (
            'Loading…'
          )
        }
        actions={
          <>
            <span className="floor-toggle">
              <Switch
                checked={showVisitors}
                label="Show visitors"
                onChange={(on) =>
                  setParams((prev) => {
                    const next = new URLSearchParams(prev);
                    if (on) next.set('visitors', '1');
                    else next.delete('visitors');
                    return next;
                  })
                }
              />
            </span>
            <Input className="input floor-filter" placeholder="Filter…" aria-label="Filter operators" value={text} onChange={(e) => setText(e.target.value)} />
            <Button onClick={() => downloadCsv('floor-overview', CSV_COLUMNS, rows)} disabled={!data} title="Export the rows shown below as CSV">
              Export CSV
            </Button>
          </>
        }
      />

      {isError && <ErrorBox error={error} />}
      {!data && !isError && <Spinner />}

      {data && (
        <>
          <KpiRow>
            <KpiTile label="On pace" value={onPace} accent="green" hint="90 % of target or better" />
            <KpiTile label="Behind" value={behind} accent="amber" hint="70 – 90 % of target" />
            <KpiTile label="Well behind" value={wellBehind} accent="red" hint="Below 70 % of target" />
            <KpiTile label="Units this hour" value={formatUnits(unitsHour)} hint={`across ${jobs} job${jobs === 1 ? '' : 's'}`} />
          </KpiRow>

          <Card>
            <CardHeader
              title="Operators"
              subtitle="Live · refreshes with every poll"
              actions={<StatusBadge tone="warn">Idle &gt; {IDLE_FLAG_MINUTES} min highlighted</StatusBadge>}
            />
            <div className="card-body">
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => `${r.operator_id}|${r.job_number}|${r.operation}`}
                defaultSort={{ key: 'operator', dir: 'asc' }}
                emptyMessage="Nobody is scanning right now"
                rowClassName={(r) => [r.idle_flag ? 'row-flag' : '', r.visitor ? 'row-visitor' : ''].filter(Boolean).join(' ') || undefined}
              />
            </div>
          </Card>
        </>
      )}
    </>
  );
}
