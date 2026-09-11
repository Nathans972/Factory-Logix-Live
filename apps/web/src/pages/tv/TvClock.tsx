/** Plant-local clock, ticking every second, with the last data refresh under it (spec 8.3). */
import { useEffect, useState } from 'react';
import { formatTime } from '../../lib/format';

export function TvClock({ tz, updatedAt }: { tz: string; updatedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="tv-clock">
      <div className="tv-clock-time">{formatTime(now, tz)}</div>
      <div className="tv-clock-updated">updated {updatedAt == null ? '—' : formatTime(updatedAt, tz)}</div>
    </div>
  );
}
