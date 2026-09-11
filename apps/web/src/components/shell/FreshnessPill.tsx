/**
 * Data freshness pill in the top bar (spec 9.2, docs/DESIGN.md "Freshness indicator").
 *
 * green  "Live · updated 11:26 AM"
 * amber  "Data delayed since 10:58"
 * red    "Collector down" / "Backend unreachable"
 *
 * Refetches `syncHealth` every 30 s and on every `sync_health` event.
 */
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../../data/DataSourceContext';
import { useLiveRefetch } from '../../lib/useLive';
import { usePlantTz } from '../../lib/usePlantTz';
import { formatTime } from '../../lib/format';

export function FreshnessPill() {
  const ds = useDataSource();
  const tz = usePlantTz();
  useLiveRefetch(['sync_health'], [['syncHealth']]);
  const { data, isError } = useQuery({
    queryKey: ['syncHealth'],
    queryFn: () => ds.syncHealth(),
    refetchInterval: 30_000,
    retry: false,
  });

  if (isError) {
    return (
      <span className="freshness fresh-bad" title="The API could not be reached">
        <span className="dot" />
        Backend unreachable
      </span>
    );
  }
  if (!data) {
    return (
      <span className="freshness">
        <span className="dot" />
        Checking…
      </span>
    );
  }
  if (data.status === 'down' || !data.collector_running) {
    return (
      <span className="freshness fresh-bad" title={data.last_error ?? 'The collector is not running'}>
        <span className="dot" />
        Collector down
      </span>
    );
  }
  if (data.delayed || data.status === 'degraded') {
    const since = data.delayed_since ?? data.last_success_at;
    return (
      <span className="freshness fresh-warn" title={data.last_error ?? 'Polling is behind'}>
        <span className="dot" />
        Data delayed since {formatTime(since, tz)}
      </span>
    );
  }
  return (
    <span className="freshness fresh-ok" title={`Polling every ${data.poll_interval_seconds}s`}>
      <span className="dot" />
      Live · updated {formatTime(data.last_success_at, tz)}
    </span>
  );
}
