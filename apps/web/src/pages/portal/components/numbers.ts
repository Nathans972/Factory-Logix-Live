/** Number formatting shared by the shift view and the floor page (docs/DESIGN.md, principle 3). */

/** StdHr reads as a whole number once it is big enough; small standards keep one decimal. */
export function formatStdHr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

/** Unit counts are grouped ("1,226") and rendered with tabular figures by the table. */
export function formatUnits(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
