/**
 * Shift-view filter bar (spec 9.2, docs/DESIGN.md "Pages" → Shift view).
 *
 * Four placeholder-only inputs plus a ghost "Clear filters", rendered as the standard
 * `.filter-bar` strip under the page header. Local state is debounced up to the URL by the page.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '../../../ui';

export interface ShiftFilters {
  job: string;
  product: string;
  operation: string;
  operator: string;
}

export const EMPTY_FILTERS: ShiftFilters = { job: '', product: '', operation: '', operator: '' };

const FIELDS: { key: keyof ShiftFilters; placeholder: string }[] = [
  { key: 'job', placeholder: 'Job number' },
  { key: 'product', placeholder: 'Product' },
  { key: 'operation', placeholder: 'Operation' },
  { key: 'operator', placeholder: 'Operator' },
];

export function FilterBar({ initial, onChange }: { initial: ShiftFilters; onChange: (f: ShiftFilters) => void }) {
  const [v, setV] = useState<ShiftFilters>(initial);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => onChange(v), 350);
    return () => clearTimeout(t);
  }, [v, onChange]);

  return (
    <div className="filter-bar shift-filters">
      {FIELDS.map((f) => (
        <Input
          key={f.key}
          className="filter-input"
          aria-label={f.placeholder}
          placeholder={f.placeholder}
          value={v[f.key]}
          onChange={(e) => setV((p) => ({ ...p, [f.key]: e.target.value }))}
        />
      ))}
      <Button variant="ghost" size="sm" onClick={() => setV(EMPTY_FILTERS)}>
        Clear filters
      </Button>
    </div>
  );
}
