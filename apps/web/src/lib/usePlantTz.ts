/**
 * Plant time zone (WEB_NOTES "Conventions").
 *
 * Read from `AppHealth.plant_timezone` via the shared `['health']` query (refetched every
 * 60 s). Falls back to the browser time zone until it loads so formatting never breaks.
 */
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../data/DataSourceContext';

export function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The browser's own IANA time zone, resolved once (used as the fallback and in the setup wizard). */
export const BROWSER_TZ: string = browserTz();

export function usePlantTz(): string {
  const ds = useDataSource();
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () => ds.health(),
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
  return data?.plant_timezone ?? browserTz();
}
