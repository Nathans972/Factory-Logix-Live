/** Small job progress bar (qty complete / released). */
export function ProgressBar({ value, small }: { value: number; small?: boolean }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <span className={`progress${small ? ' progress-sm' : ''}`} title={`${Math.round(pct * 100)}%`}>
      <i style={{ width: `${pct * 100}%` }} />
    </span>
  );
}
