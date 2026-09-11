/** Ring gauge for job progress (spec 8.3 / 7.10). Pure SVG so it scales with the viewport. */
import { clampProgress, formatProgressPct } from './tvLogic';

const R = 42;
const CIRC = 2 * Math.PI * R;

export function TvGauge({ progress }: { progress: number }) {
  const frac = clampProgress(progress);
  const label = formatProgressPct(progress);
  return (
    <div className="tv-gauge" role="img" aria-label={`Job progress ${label}`}>
      <svg viewBox="0 0 100 100" className="tv-gauge-svg" aria-hidden="true">
        <circle className="tv-gauge-track" cx="50" cy="50" r={R} />
        <circle
          className="tv-gauge-arc"
          cx="50"
          cy="50"
          r={R}
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - frac)}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="tv-gauge-label">{label}</div>
    </div>
  );
}
