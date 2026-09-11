/** Sync health (spec 10.9). Readable by managers as well as admins. */
import { useQuery } from '@tanstack/react-query';
import type { CellColor, SourceSyncState, SyncLogEntry, SyncStatus } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime, formatNum, relativeMinutes } from '../../lib/format';
import { ColorChip, DataTable, PageHeader, Panel, Spinner, Stat, type Column } from '../../ui';
import { ApiError, BackfillBar } from './components/common';

const STATUS_COLOR: Record<SyncStatus, CellColor> = {
  ok: 'green',
  degraded: 'yellow',
  down: 'red',
  never: 'neutral',
};

const LOG_COLOR: Record<SyncLogEntry['status'], CellColor> = {
  ok: 'green',
  error: 'red',
  running: 'blue',
};

export function SyncPage() {
  const ds = useDataSource();
  const tz = usePlantTz();

  const healthQ = useQuery({ queryKey: ['syncHealth'], queryFn: () => ds.syncHealth(), refetchInterval: 10_000 });
  const logQ = useQuery({ queryKey: ['syncLog', 100], queryFn: () => ds.syncLog(100), refetchInterval: 30_000 });
  useLiveRefetch(['sync_health']);

  const h = healthQ.data;
  const now = Date.now();

  const sourceColumns: Column<SourceSyncState>[] = [
    { key: 'source', header: 'Source', render: (s) => s.source },
    { key: 'watermark', header: 'Watermark', render: (s) => <span className="mono small">{s.watermark ?? '—'}</span>, value: (s) => s.watermark ?? '' },
    {
      key: 'last_success',
      header: 'Last success',
      render: (s) => <span title={formatDateTime(s.last_success_at, tz)}>{relativeMinutes(s.last_success_at, now)}</span>,
      value: (s) => s.last_success_at ?? 0,
    },
    { key: 'failures', header: 'Failures', align: 'right', render: (s) => s.consecutive_failures, value: (s) => s.consecutive_failures },
    { key: 'rows', header: 'Rows last poll', align: 'right', render: (s) => (s.rows_last_poll == null ? '—' : s.rows_last_poll), value: (s) => s.rows_last_poll ?? -1 },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (s) => (s.duration_ms_last_poll == null ? '—' : `${formatNum(s.duration_ms_last_poll, 0)} ms`),
      value: (s) => s.duration_ms_last_poll ?? -1,
    },
    { key: 'error', header: 'Last error', render: (s) => s.last_error ?? <span className="muted">—</span>, value: (s) => s.last_error ?? '' },
  ];

  const logColumns: Column<SyncLogEntry>[] = [
    { key: 'started', header: 'Started', render: (e) => formatDateTime(e.started_at, tz), value: (e) => e.started_at },
    { key: 'source', header: 'Source', render: (e) => e.source },
    { key: 'status', header: 'Status', render: (e) => <ColorChip color={LOG_COLOR[e.status]}>{e.status}</ColorChip>, value: (e) => e.status },
    { key: 'rows', header: 'Rows', align: 'right', render: (e) => (e.rows == null ? '—' : e.rows), value: (e) => e.rows ?? -1 },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (e) => (e.finished_at == null ? '—' : `${formatNum((e.finished_at - e.started_at) / 1000, 1)} s`),
      value: (e) => (e.finished_at == null ? -1 : e.finished_at - e.started_at),
    },
    { key: 'error', header: 'Error', render: (e) => e.error ?? <span className="muted">—</span>, value: (e) => e.error ?? '' },
  ];

  return (
    <>
      <PageHeader title="Sync health" subtitle="Collector state, per-source watermarks and the recent poll log." />

      {healthQ.isError && <ApiError error={healthQ.error} />}
      {healthQ.isLoading && !h && <Spinner />}

      {h && (
        <>
          <div className="grid grid-4 mb">
            <Stat
              label="Status"
              value={<ColorChip color={STATUS_COLOR[h.status]}>{h.status}</ColorChip>}
              color={STATUS_COLOR[h.status]}
              hint={h.delayed ? `Delayed since ${formatDateTime(h.delayed_since, tz)}` : `Polls every ${h.poll_interval_seconds} s`}
            />
            <Stat
              label="Last success"
              value={relativeMinutes(h.last_success_at, now)}
              hint={formatDateTime(h.last_success_at, tz)}
            />
            <Stat
              label="Consecutive failures"
              value={h.consecutive_failures}
              color={h.consecutive_failures > 0 ? 'yellow' : undefined}
              hint={h.breaker_open_until ? `Breaker open until ${formatDateTime(h.breaker_open_until, tz)}` : 'Breaker closed'}
            />
            <Stat
              label="Collector"
              value={h.collector_running ? 'Running' : 'Stopped'}
              color={h.collector_running ? 'green' : 'red'}
            />
          </div>

          {h.last_error && <div className="banner banner-error">Last error: {h.last_error}</div>}

          <Panel title="Backfill">
            <BackfillBar backfill={h.backfill} tz={tz} />
          </Panel>

          <Panel title="Sources">
            <DataTable
              columns={sourceColumns}
              rows={h.sources}
              rowKey={(s) => String(s.source)}
              exportName="sync-sources"
              rowClassName={(s) => (s.consecutive_failures > 0 ? 'row-flag' : undefined)}
              emptyMessage="No sources have polled yet."
              dense
            />
          </Panel>
        </>
      )}

      <Panel title="Recent polls">
        {logQ.isError && <ApiError error={logQ.error} />}
        {logQ.isLoading ? (
          <Spinner />
        ) : (
          <DataTable
            columns={logColumns}
            rows={logQ.data ?? []}
            rowKey={(e) => e.id}
            exportName="sync-log"
            defaultSort={{ key: 'started', dir: 'desc' }}
            rowClassName={(e) => (e.status === 'error' ? 'row-flag' : undefined)}
            emptyMessage="No poll history yet."
            dense
          />
        )}
      </Panel>
    </>
  );
}
