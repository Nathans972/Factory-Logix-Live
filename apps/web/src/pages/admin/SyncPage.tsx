/** Sync health (spec 10.9). Readable by managers as well as admins. Auto-refreshes every 10 s. */
import { useQuery } from '@tanstack/react-query';
import type { SourceSyncState, SyncLogEntry, SyncStatus } from '@fld/shared';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatDateTime, formatNum, relativeMinutes } from '../../lib/format';
import {
  Card,
  DataTable,
  KpiRow,
  KpiTile,
  Note,
  PageHeader,
  Spinner,
  StatusBadge,
  type Accent,
  type BadgeTone,
  type Column,
} from '../../ui';
import { ApiError, BackfillBar, SectionCard } from './components/common';

const STATUS_TONE: Record<SyncStatus, BadgeTone> = { ok: 'ok', degraded: 'warn', down: 'off', never: 'neutral' };
const STATUS_ACCENT: Record<SyncStatus, Accent> = { ok: 'green', degraded: 'amber', down: 'red', never: 'none' };
const LOG_TONE: Record<SyncLogEntry['status'], BadgeTone> = { ok: 'ok', error: 'off', running: 'info' };

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
    {
      key: 'watermark',
      header: 'Watermark',
      render: (s) => <span className="mono small">{s.watermark ?? '—'}</span>,
      value: (s) => s.watermark ?? '',
    },
    {
      key: 'last_success',
      header: 'Last success',
      render: (s) => <span title={formatDateTime(s.last_success_at, tz)}>{relativeMinutes(s.last_success_at, now)}</span>,
      value: (s) => s.last_success_at ?? 0,
    },
    {
      key: 'failures',
      header: 'Failures',
      align: 'right',
      render: (s) => s.consecutive_failures,
      value: (s) => s.consecutive_failures,
    },
    {
      key: 'rows',
      header: 'Rows last poll',
      align: 'right',
      render: (s) => (s.rows_last_poll == null ? '—' : s.rows_last_poll),
      value: (s) => s.rows_last_poll ?? -1,
    },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (s) => (s.duration_ms_last_poll == null ? '—' : `${formatNum(s.duration_ms_last_poll, 0)} ms`),
      value: (s) => s.duration_ms_last_poll ?? -1,
    },
    {
      key: 'error',
      header: 'Last error',
      render: (s) => s.last_error ?? <span className="dim">—</span>,
      value: (s) => s.last_error ?? '',
    },
  ];

  const logColumns: Column<SyncLogEntry>[] = [
    { key: 'started', header: 'Started', render: (e) => formatDateTime(e.started_at, tz), value: (e) => e.started_at },
    { key: 'source', header: 'Source', render: (e) => e.source },
    {
      key: 'status',
      header: 'Status',
      width: 110,
      render: (e) => <StatusBadge tone={LOG_TONE[e.status]}>{e.status}</StatusBadge>,
      value: (e) => e.status,
    },
    { key: 'rows', header: 'Rows', align: 'right', render: (e) => (e.rows == null ? '—' : e.rows), value: (e) => e.rows ?? -1 },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      render: (e) => (e.finished_at == null ? '—' : `${formatNum((e.finished_at - e.started_at) / 1000, 1)} s`),
      value: (e) => (e.finished_at == null ? -1 : e.finished_at - e.started_at),
    },
    { key: 'error', header: 'Error', render: (e) => e.error ?? <span className="dim">—</span>, value: (e) => e.error ?? '' },
  ];

  return (
    <>
      <PageHeader
        title="Sync health"
        subtitle={
          h
            ? `Collector ${h.collector_running ? 'running' : 'stopped'} · polls every ${h.poll_interval_seconds} s · ${h.sources.length} source${h.sources.length === 1 ? '' : 's'}`
            : 'Collector state, per-source watermarks and the recent poll log.'
        }
      />

      {healthQ.isError && <ApiError error={healthQ.error} />}
      {healthQ.isLoading && !h && <Spinner />}

      {h && (
        <>
          <KpiRow>
            <KpiTile
              label="Status"
              value={<StatusBadge tone={STATUS_TONE[h.status]}>{h.status}</StatusBadge>}
              accent={STATUS_ACCENT[h.status]}
              hint={h.delayed ? `Delayed since ${formatDateTime(h.delayed_since, tz)}` : `Polls every ${h.poll_interval_seconds} s`}
            />
            <KpiTile
              label="Last success"
              value={relativeMinutes(h.last_success_at, now)}
              hint={formatDateTime(h.last_success_at, tz)}
            />
            <KpiTile
              label="Consecutive failures"
              value={h.consecutive_failures}
              accent={h.consecutive_failures > 0 ? 'amber' : 'none'}
              hint={h.breaker_open_until ? `Breaker open until ${formatDateTime(h.breaker_open_until, tz)}` : 'Breaker closed'}
            />
            <KpiTile
              label="Collector"
              value={h.collector_running ? 'Running' : 'Stopped'}
              accent={h.collector_running ? 'green' : 'red'}
              hint={h.collector_running ? 'Polling on schedule' : 'No polls are being issued'}
            />
          </KpiRow>

          {h.last_error && (
            <div className="mb">
              <Note tone="error" title="Last error">
                {h.last_error}
              </Note>
            </div>
          )}

          <SectionCard title="Backfill" subtitle="Historical fill-in progress.">
            <BackfillBar backfill={h.backfill} tz={tz} />
          </SectionCard>

          <Card>
            <DataTable
              title="Sources"
              columns={sourceColumns}
              rows={h.sources}
              rowKey={(s) => String(s.source)}
              exportName="sync-sources"
              rowClassName={(s) => (s.consecutive_failures > 0 ? 'row-flag' : undefined)}
              emptyMessage="No sources have polled yet."
              dense
            />
          </Card>
        </>
      )}

      <Card>
        {logQ.isError && (
          <div className="card-body">
            <ApiError error={logQ.error} />
          </div>
        )}
        {logQ.isLoading ? (
          <div className="card-body">
            <Spinner />
          </div>
        ) : (
          <DataTable
            title="Recent polls"
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
      </Card>
    </>
  );
}
