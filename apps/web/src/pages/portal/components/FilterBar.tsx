/** Shift-view filters (spec 9.2). Local state is debounced up to the URL by the page. */
import { useEffect, useRef, useState } from 'react';
import { Field, Input } from '../../../ui';

export interface ShiftFilters {
  job: string;
  product: string;
  operation: string;
  operator: string;
}

export const EMPTY_FILTERS: ShiftFilters = { job: '', product: '', operation: '', operator: '' };

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

  const set = (patch: Partial<ShiftFilters>) => setV((p) => ({ ...p, ...patch }));

  return (
    <div className="filters">
      <Field label="Job">
        <Input value={v.job} placeholder="Job number" onChange={(e) => set({ job: e.target.value })} />
      </Field>
      <Field label="Product (Z-number)">
        <Input value={v.product} placeholder="Product number" onChange={(e) => set({ product: e.target.value })} />
      </Field>
      <Field label="Operation">
        <Input value={v.operation} placeholder="Operation" onChange={(e) => set({ operation: e.target.value })} />
      </Field>
      <Field label="Operator">
        <Input value={v.operator} placeholder="Operator" onChange={(e) => set({ operator: e.target.value })} />
      </Field>
    </div>
  );
}
