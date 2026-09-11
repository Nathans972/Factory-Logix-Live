/**
 * Offline / delayed banners (spec 8.2, 15 scenarios 14).
 * Text carries the whole message so color is never the only signal (spec 14).
 * Both clear automatically when the underlying condition clears.
 */
import { formatTime24 } from '../../lib/format';

export interface TvBannersProps {
  /** time of the first failed fetch of the current outage */
  offlineSince: number | null;
  /** `sync.delayed_since` while the collector is behind */
  delayedSince: number | null;
  delayed: boolean;
  tz: string;
}

export function TvBanners({ offlineSince, delayedSince, delayed, tz }: TvBannersProps) {
  if (offlineSince == null && !delayed) return null;
  return (
    <div className="tv-banners" role="status" aria-live="polite">
      {offlineSince != null && (
        <div className="tv-banner tv-banner-offline">Dashboard offline since {formatTime24(offlineSince, tz)}</div>
      )}
      {delayed && (
        <div className="tv-banner tv-banner-delayed">
          {delayedSince == null ? 'Data delayed' : `Data delayed since ${formatTime24(delayedSince, tz)}`}
        </div>
      )}
    </div>
  );
}
